#[cfg(target_arch = "wasm32")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::JsValue;

#[cfg(target_arch = "wasm32")]
use crate::{
    buffers::{bbox_instances_into, overlay_instances_into, BBoxInstance},
    scene::{
        changed_element_range, dirty_byte_range, scene_upload_plan, validate_projection,
        validate_scene, CanonicalImage, Overlay, RenderObject, RenderScene, Viewport,
    },
};

#[cfg(target_arch = "wasm32")]
#[derive(serde::Deserialize)]
struct RenderProjectionUpdate {
    objects: Vec<RenderObject>,
    overlays: Vec<Overlay>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RendererError {
    Unsupported(String),
    InvalidScene,
    DeviceLost,
    Surface(String),
}
impl std::fmt::Display for RendererError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for RendererError {}

/// Browser-backed renderer. No alternate canvas renderer is provided.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub struct Renderer {
    canvas: web_sys::HtmlCanvasElement,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    device: wgpu::Device,
    queue: wgpu::Queue,
    texture: wgpu::Texture,
    render_format: wgpu::TextureFormat,
    image_bind: wgpu::BindGroup,
    image_layout: wgpu::BindGroupLayout,
    image_sampler: wgpu::Sampler,
    image_width: u32,
    image_height: u32,
    image_pipeline: wgpu::RenderPipeline,
    box_pipeline: wgpu::RenderPipeline,
    overlay_pipeline: wgpu::RenderPipeline,
    instance_layout: wgpu::BindGroupLayout,
    uniform: wgpu::Buffer,
    uniform_bind: wgpu::BindGroup,
    instance_buffer: wgpu::Buffer,
    overlay_buffer: wgpu::Buffer,
    instance_capacity: u64,
    overlay_capacity: u64,
    instance_scratch: Vec<BBoxInstance>,
    scene: Option<RenderScene>,
    diagnostics: String,
    lost: Arc<AtomicBool>,
}

#[cfg(not(target_arch = "wasm32"))]
pub struct Renderer;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
impl Renderer {
    #[wasm_bindgen::prelude::wasm_bindgen(js_name = new)]
    pub async fn new(
        canvas: web_sys::HtmlCanvasElement,
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    ) -> Result<Renderer, wasm_bindgen::JsValue> {
        let mut renderer = Self::create(canvas, width, height, &rgba)
            .await
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
        let dpr = web_sys::window()
            .map(|w| w.device_pixel_ratio() as f32)
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(1.0);
        let css_width = renderer.canvas.client_width().max(0) as f32;
        let css_height = renderer.canvas.client_height().max(0) as f32;
        renderer.scene = Some(RenderScene {
            viewport: Viewport {
                scale: 1.0,
                tx: 0.0,
                ty: 0.0,
                css_width,
                css_height,
                dpr,
            },
            image: CanonicalImage {
                width,
                height,
                rgba,
            },
            objects: vec![],
            overlays: vec![],
        });
        renderer
            .render_saved()
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
        Ok(renderer)
    }
    pub fn resize(
        &mut self,
        css_width: f64,
        css_height: f64,
        dpr: f64,
    ) -> Result<(), wasm_bindgen::JsValue> {
        if ![css_width, css_height, dpr].iter().all(|v| v.is_finite())
            || css_width < 0.0
            || css_height < 0.0
            || dpr <= 0.0
        {
            return Err(wasm_bindgen::JsValue::from_str("invalid canvas dimensions"));
        }
        if css_width == 0.0 || css_height == 0.0 {
            if let Some(scene) = &mut self.scene {
                scene.viewport.css_width = css_width as f32;
                scene.viewport.css_height = css_height as f32;
                scene.viewport.dpr = dpr as f32;
            }
            return Ok(());
        }
        let w = (css_width * dpr).round().clamp(1.0, u32::MAX as f64) as u32;
        let h = (css_height * dpr).round().clamp(1.0, u32::MAX as f64) as u32;
        if let Some(scene) = &mut self.scene {
            scene.viewport.css_width = css_width as f32;
            scene.viewport.css_height = css_height as f32;
            scene.viewport.dpr = dpr as f32;
        }
        if w == self.config.width && h == self.config.height {
            return self
                .render_saved()
                .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()));
        }
        self.config.width = w;
        self.config.height = h;
        self.canvas.set_width(w);
        self.canvas.set_height(h);
        self.surface.configure(&self.device, &self.config);
        self.render_saved()
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
    }
    /// Replace the complete renderer scene, including the canonical image.
    /// Use the narrower update methods for ordinary viewport or object changes.
    pub fn update_scene(&mut self, scene: JsValue) -> Result<(), wasm_bindgen::JsValue> {
        let scene: RenderScene = serde_wasm_bindgen::from_value(scene)
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
        if !validate_scene(&scene) {
            return Err(wasm_bindgen::JsValue::from_str("invalid render scene"));
        }
        let plan = scene_upload_plan(self.scene.as_ref(), &scene);
        self.scene = Some(scene);
        if plan.image_changed {
            self.upload_image()?;
        }
        self.upload_instance_ranges(plan.object_range, plan.overlay_range)?;
        self.render_saved()
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
    }
    /// Update pan/zoom without transferring image pixels or rebuilding instances.
    pub fn update_viewport(&mut self, viewport: JsValue) -> Result<(), wasm_bindgen::JsValue> {
        let viewport: Viewport = serde_wasm_bindgen::from_value(viewport)
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
        if !viewport.valid() {
            return Err(wasm_bindgen::JsValue::from_str("invalid viewport"));
        }
        let Some(scene) = self.scene.as_mut() else {
            return Err(wasm_bindgen::JsValue::from_str("renderer has no scene"));
        };
        scene.viewport = viewport;
        self.render_saved()
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
    }
    /// Update annotation geometry/overlays without retransferring the image.
    pub fn update_objects(&mut self, projection: JsValue) -> Result<(), wasm_bindgen::JsValue> {
        let projection: RenderProjectionUpdate = serde_wasm_bindgen::from_value(projection)
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
        let Some(scene) = self.scene.as_ref() else {
            return Err(wasm_bindgen::JsValue::from_str("renderer has no scene"));
        };
        if !validate_projection(
            scene.image.width,
            scene.image.height,
            &projection.objects,
            &projection.overlays,
        ) {
            return Err(wasm_bindgen::JsValue::from_str("invalid render projection"));
        }
        let object_range = changed_element_range(&scene.objects, &projection.objects);
        let overlay_range = changed_element_range(&scene.overlays, &projection.overlays);
        let scene = self.scene.as_mut().expect("scene checked above");
        scene.objects = projection.objects;
        scene.overlays = projection.overlays;
        self.upload_instance_ranges(object_range, overlay_range)?;
        self.render_saved()
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
    }
    pub fn render(&mut self) -> Result<(), wasm_bindgen::JsValue> {
        self.render_saved()
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
    }
    pub async fn recover(&mut self) -> Result<(), wasm_bindgen::JsValue> {
        let scene = self
            .scene
            .clone()
            .ok_or_else(|| wasm_bindgen::JsValue::from_str("no saved scene"))?;
        let replacement = Self::create(
            self.canvas.clone(),
            scene.image.width,
            scene.image.height,
            &scene.image.rgba,
        )
        .await
        .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
        *self = replacement;
        self.scene = Some(scene);
        self.upload_scene()?;
        self.render_saved()
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
    }
    pub fn device_state(&self) -> String {
        if self.lost.load(Ordering::Acquire) {
            "lost"
        } else {
            "ready"
        }
        .to_owned()
    }
    pub fn adapter_diagnostics(&self) -> String {
        self.diagnostics.clone()
    }
    /// Simulate the only device-loss vector a page can force: destroying the
    /// GPUDevice (loss reason Destroyed). Browsers cannot force a `Failed`
    /// loss; see reports/T05 for what was and was not exercised. The saved
    /// scene survives so `recover` rebuilds from it like an unexpected loss.
    pub fn simulate_device_loss(&mut self) {
        self.device.destroy();
        self.lost.store(true, Ordering::Release);
    }
    pub fn dispose(&mut self) {
        self.device.destroy();
        self.lost.store(true, Ordering::Release);
        self.scene = None;
    }
}

#[cfg(target_arch = "wasm32")]
impl Renderer {
    async fn create(
        canvas: web_sys::HtmlCanvasElement,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<Self, RendererError> {
        let expected_bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or(RendererError::InvalidScene)?;
        if expected_bytes != rgba.len() {
            return Err(RendererError::InvalidScene);
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|e| RendererError::Surface(e.to_string()))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .map_err(|e| RendererError::Unsupported(e.to_string()))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|e| RendererError::Unsupported(e.to_string()))?;
        let caps = surface.get_capabilities(&adapter);
        // Browsers only expose *Unorm canvas formats, whose texels the
        // compositor reads as sRGB-encoded (SurfaceColorSpace::Auto resolves
        // to Srgb on the web), and wgpu never encodes for us. Rendering
        // through the *Srgb reinterpretation view makes the hardware apply
        // the same encoding an sRGB target would, and blends in linear light.
        let (format, render_format) = caps
            .formats
            .iter()
            .copied()
            .find_map(|format| srgb_render_format(format).map(|view| (format, view)))
            .ok_or_else(|| {
                RendererError::Unsupported("surface has no sRGB-encodable format".into())
            })?;
        let info = adapter.get_info();
        let diagnostics = format!(
            "backend={:?}; device_type={:?}; name={}; surface={:?}; render_view={:?}",
            info.backend, info.device_type, info.name, format, render_format
        );
        let (css_w, css_h) = (
            canvas.client_width().max(0) as u32,
            canvas.client_height().max(0) as u32,
        );
        let (cw, ch) = (css_w.max(1), css_h.max(1));
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: cw,
            height: ch,
            present_mode: caps
                .present_modes
                .first()
                .copied()
                .unwrap_or(wgpu::PresentMode::Fifo),
            desired_maximum_frame_latency: 2,
            alpha_mode: caps
                .alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto),
            view_formats: if render_format != format {
                vec![render_format]
            } else {
                vec![]
            },
        };
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("viewport uniform"),
            size: 48,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniform_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("viewport"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let uniform_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("viewport bind"),
            layout: &uniform_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }],
        });
        let image_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("image"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/image.wgsl").into()),
        });
        let box_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("bbox"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/bbox.wgsl").into()),
        });
        let instance_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("instances"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let overlay_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("overlay"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/overlay.wgsl").into()),
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("canonical image"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let tex_view = texture.create_view(&Default::default());
        let image_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("image texture"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let image_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("image bind"),
            layout: &image_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&tex_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let image_pipeline = pipeline(
            &device,
            &uniform_layout,
            &image_layout,
            &image_shader,
            render_format,
            "image pipeline",
        );
        let box_pipeline = pipeline(
            &device,
            &uniform_layout,
            &instance_layout,
            &box_shader,
            render_format,
            "bbox pipeline",
        );
        let overlay_pipeline = pipeline(
            &device,
            &uniform_layout,
            &instance_layout,
            &overlay_shader,
            render_format,
            "overlay pipeline",
        );
        let instance_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("bbox instances"),
            size: 48,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let overlay_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("overlay instances"),
            size: 48,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let lost = Arc::new(AtomicBool::new(false));
        let lost_signal = lost.clone();
        device.set_device_lost_callback(move |_reason, _message| {
            lost_signal.store(true, Ordering::Release);
        });
        let this = Self {
            canvas,
            surface,
            config,
            device,
            queue,
            texture,
            render_format,
            image_bind,
            image_pipeline,
            box_pipeline,
            overlay_pipeline,
            uniform,
            uniform_bind,
            instance_layout,
            image_layout,
            image_sampler: sampler,
            image_width: width,
            image_height: height,
            instance_buffer,
            overlay_buffer,
            instance_capacity: 48,
            overlay_capacity: 48,
            instance_scratch: Vec::new(),
            scene: None,
            lost,
            diagnostics,
        };
        this.canvas.set_width(css_w);
        this.canvas.set_height(css_h);
        if css_w > 0 && css_h > 0 {
            this.surface.configure(&this.device, &this.config);
        }
        let data = crate::image::padded_rgba_rows(width, height, &rgba)
            .ok_or(RendererError::InvalidScene)?;
        this.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &this.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &data.1,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(data.0),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        Ok(this)
    }
    fn upload_scene(&mut self) -> Result<(), wasm_bindgen::JsValue> {
        if let Some(scene) = &self.scene {
            bbox_instances_into(&scene.objects, &mut self.instance_scratch);
            upload_instances(
                &self.device,
                &self.queue,
                &mut self.instance_buffer,
                &mut self.instance_capacity,
                &self.instance_scratch,
                "bbox instances",
            );
            overlay_instances_into(&scene.overlays, &mut self.instance_scratch);
            upload_instances(
                &self.device,
                &self.queue,
                &mut self.overlay_buffer,
                &mut self.overlay_capacity,
                &self.instance_scratch,
                "overlay instances",
            );
        }
        Ok(())
    }
    fn upload_instance_ranges(
        &mut self,
        object_range: Option<std::ops::Range<usize>>,
        overlay_range: Option<std::ops::Range<usize>>,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let Some(scene) = self.scene.as_ref() else {
            return Ok(());
        };
        upload_instances_delta(
            &self.device,
            &self.queue,
            &mut self.instance_buffer,
            &mut self.instance_capacity,
            &scene.objects,
            object_range,
            "bbox instances",
            &mut self.instance_scratch,
            bbox_instances_into,
        )?;
        upload_instances_delta(
            &self.device,
            &self.queue,
            &mut self.overlay_buffer,
            &mut self.overlay_capacity,
            &scene.overlays,
            overlay_range,
            "overlay instances",
            &mut self.instance_scratch,
            overlay_instances_into,
        )
    }
    fn upload_image(&mut self) -> Result<(), wasm_bindgen::JsValue> {
        let Some(image) = self.scene.as_ref().map(|s| &s.image) else {
            return Ok(());
        };
        if image.width != self.image_width || image.height != self.image_height {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("canonical image"),
                size: wgpu::Extent3d {
                    width: image.width,
                    height: image.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            self.image_bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("image bind"),
                layout: &self.image_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.image_sampler),
                    },
                ],
            });
            self.texture = texture;
            self.image_width = image.width;
            self.image_height = image.height;
        }
        let Some((stride, bytes)) =
            crate::image::padded_rgba_rows(image.width, image.height, &image.rgba)
        else {
            return Err(wasm_bindgen::JsValue::from_str(
                "invalid image dimensions or RGBA data",
            ));
        };
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(image.height),
            },
            wgpu::Extent3d {
                width: image.width,
                height: image.height,
                depth_or_array_layers: 1,
            },
        );
        Ok(())
    }
    fn render_saved(&mut self) -> Result<(), RendererError> {
        if self.lost.load(Ordering::Acquire) {
            return Err(RendererError::DeviceLost);
        }
        let Some(scene) = self.scene.as_ref() else {
            return Ok(());
        };
        let Some((w, h)) = scene.viewport.backing_size() else {
            return Ok(());
        };
        if w != self.config.width || h != self.config.height {
            self.config.width = w;
            self.config.height = h;
            self.canvas.set_width(w);
            self.canvas.set_height(h);
            self.surface.configure(&self.device, &self.config);
        }
        let s = scene.viewport;
        let uniform = s.render_uniform(scene.image.width, scene.image.height);
        self.queue
            .write_buffer(&self.uniform, 0, bytemuck_bytes(&uniform));
        let (frame, suboptimal) = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) => (frame, false),
            wgpu::CurrentSurfaceTexture::Suboptimal(frame) => (frame, true),
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(());
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return Ok(());
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                return Err(RendererError::Surface("surface lost".into()));
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err(RendererError::Surface("surface validation failed".into()));
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("surface frame view"),
            format: Some(self.render_format),
            ..Default::default()
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("render scene"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("image and annotations"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &self.uniform_bind, &[]);
            pass.set_pipeline(&self.image_pipeline);
            pass.set_bind_group(1, &self.image_bind, &[]);
            pass.draw(0..6, 0..1);
            if !scene.objects.is_empty() {
                let bind =
                    instance_bind(&self.device, &self.instance_layout, &self.instance_buffer);
                pass.set_pipeline(&self.box_pipeline);
                pass.set_bind_group(1, &bind, &[]);
                pass.draw(0..6, 0..scene.objects.len() as u32);
            }
            if !scene.overlays.is_empty() {
                let bind = instance_bind(&self.device, &self.instance_layout, &self.overlay_buffer);
                pass.set_pipeline(&self.overlay_pipeline);
                pass.set_bind_group(1, &bind, &[]);
                pass.draw(0..6, 0..scene.overlays.len() as u32);
            }
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        if suboptimal {
            self.surface.configure(&self.device, &self.config);
        }
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
fn instance_bind(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    buffer: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("instance bind"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    })
}
#[cfg(target_arch = "wasm32")]
fn pipeline(
    device: &wgpu::Device,
    view: &wgpu::BindGroupLayout,
    second: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
    label: &str,
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[Some(view), Some(second)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    })
}
#[cfg(target_arch = "wasm32")]
fn upload_instances(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    buffer: &mut wgpu::Buffer,
    capacity: &mut u64,
    values: &[BBoxInstance],
    label: &str,
) {
    let bytes = bytemuck_bytes(values);
    if bytes.len() as u64 > *capacity {
        *capacity = (bytes.len() as u64).next_power_of_two().max(48);
        *buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: *capacity,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
    }
    if !bytes.is_empty() {
        queue.write_buffer(buffer, 0, bytes)
    }
}
#[cfg(target_arch = "wasm32")]
fn upload_instances_delta<T>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    buffer: &mut wgpu::Buffer,
    capacity: &mut u64,
    source: &[T],
    range: Option<std::ops::Range<usize>>,
    label: &str,
    scratch: &mut Vec<BBoxInstance>,
    convert: fn(&[T], &mut Vec<BBoxInstance>),
) -> Result<(), wasm_bindgen::JsValue> {
    let Some(range) = range else {
        return Ok(());
    };
    if range.is_empty() {
        return Ok(());
    }
    let required_bytes = source
        .len()
        .checked_mul(std::mem::size_of::<BBoxInstance>())
        .and_then(|size| u64::try_from(size).ok())
        .ok_or_else(|| wasm_bindgen::JsValue::from_str("instance buffer size overflow"))?;
    if required_bytes > *capacity {
        convert(source, scratch);
        upload_instances(device, queue, buffer, capacity, scratch, label);
        return Ok(());
    }
    let byte_range = dirty_byte_range(
        range.clone(),
        std::mem::size_of::<BBoxInstance>(),
        source.len(),
    )
    .ok_or_else(|| wasm_bindgen::JsValue::from_str("invalid instance dirty range"))?;
    convert(&source[range], scratch);
    queue.write_buffer(buffer, byte_range.start, bytemuck_bytes(scratch));
    Ok(())
}
#[cfg(target_arch = "wasm32")]
fn bytemuck_bytes<T>(values: &[T]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(values.as_ptr().cast(), std::mem::size_of_val(values)) }
}
/// The sRGB reinterpretation of a surface format, when one exists. Formats
/// without a pair (e.g. `Rgba16Float`) are rejected at device creation rather
/// than silently rendered with the wrong transfer function.
#[cfg(target_arch = "wasm32")]
fn srgb_render_format(format: wgpu::TextureFormat) -> Option<wgpu::TextureFormat> {
    match format {
        wgpu::TextureFormat::Rgba8Unorm => Some(wgpu::TextureFormat::Rgba8UnormSrgb),
        wgpu::TextureFormat::Bgra8Unorm => Some(wgpu::TextureFormat::Bgra8UnormSrgb),
        wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb => Some(format),
        _ => None,
    }
}
