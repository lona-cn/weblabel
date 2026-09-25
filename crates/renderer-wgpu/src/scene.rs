use std::ops::Range;

/// A read-only canonical image and annotation projection consumed by the renderer.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RenderScene {
    pub viewport: Viewport,
    pub image: CanonicalImage,
    pub objects: Vec<RenderObject>,
    pub overlays: Vec<Overlay>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SceneUploadPlan {
    pub image_changed: bool,
    pub object_range: Option<Range<usize>>,
    pub overlay_range: Option<Range<usize>>,
}

pub fn scene_upload_plan(previous: Option<&RenderScene>, next: &RenderScene) -> SceneUploadPlan {
    SceneUploadPlan {
        image_changed: previous.is_none_or(|previous| previous.image != next.image),
        object_range: previous.map_or_else(
            || (!next.objects.is_empty()).then_some(0..next.objects.len()),
            |previous| changed_element_range(&previous.objects, &next.objects),
        ),
        overlay_range: previous.map_or_else(
            || (!next.overlays.is_empty()).then_some(0..next.overlays.len()),
            |previous| changed_element_range(&previous.overlays, &next.overlays),
        ),
    }
}

pub fn changed_element_range<T: PartialEq>(previous: &[T], next: &[T]) -> Option<Range<usize>> {
    let shared_len = previous.len().min(next.len());
    let first_changed = (0..shared_len).find(|&index| previous[index] != next[index]);
    match first_changed {
        Some(first) if previous.len() == next.len() => {
            let last = (first..shared_len)
                .rfind(|&index| previous[index] != next[index])
                .expect("first changed item exists");
            Some(first..last + 1)
        }
        Some(first) => (first < next.len()).then_some(first..next.len()),
        None if next.len() > previous.len() => Some(previous.len()..next.len()),
        None => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Viewport {
    pub scale: f32,
    pub tx: f32,
    pub ty: f32,
    pub css_width: f32,
    pub css_height: f32,
    pub dpr: f32,
}

impl Viewport {
    pub fn valid(self) -> bool {
        [
            self.scale,
            self.tx,
            self.ty,
            self.css_width,
            self.css_height,
            self.dpr,
        ]
        .iter()
        .all(|n| n.is_finite())
            && self.scale > 0.0
            && self.css_width >= 0.0
            && self.css_height >= 0.0
            && self.dpr > 0.0
    }
    pub fn backing_size(self) -> Option<(u32, u32)> {
        if !self.valid() {
            return None;
        }
        let width = (self.css_width * self.dpr).round();
        let height = (self.css_height * self.dpr).round();
        if width <= 0.0 || height <= 0.0 || width > u32::MAX as f32 || height > u32::MAX as f32 {
            None
        } else {
            Some((width as u32, height as u32))
        }
    }
    /// Shader viewport, pan, and scale stay in CSS units; the canvas backing
    /// store handles DPR when clip space is rasterized.
    pub fn render_uniform(self, image_width: u32, image_height: u32) -> [f32; 12] {
        [
            self.css_width,
            self.css_height,
            self.tx,
            self.ty,
            self.scale,
            self.dpr,
            image_width as f32,
            image_height as f32,
            0.0,
            0.0,
            0.0,
            0.0,
        ]
    }
    pub fn css_pixels_to_clip(self, x: f32, y: f32) -> [f32; 2] {
        [
            2.0 * x / self.css_width - 1.0,
            1.0 - 2.0 * y / self.css_height,
        ]
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CanonicalImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RenderObject {
    pub bounds: [f32; 4],
    pub color: [f32; 4],
    pub selected: bool,
    pub locked: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Overlay {
    pub bounds: [f32; 4],
    pub color: [f32; 4],
}

pub fn validate_image(image: &CanonicalImage) -> bool {
    image.width > 0
        && image.height > 0
        && (image.width as usize)
            .checked_mul(image.height as usize)
            .and_then(|n| n.checked_mul(4))
            == Some(image.rgba.len())
}

pub fn validate_scene(scene: &RenderScene) -> bool {
    scene.viewport.valid()
        && validate_image(&scene.image)
        && validate_projection(
            scene.image.width,
            scene.image.height,
            &scene.objects,
            &scene.overlays,
        )
}

pub fn validate_projection(
    image_width: u32,
    image_height: u32,
    objects: &[RenderObject],
    overlays: &[Overlay],
) -> bool {
    if image_width == 0 || image_height == 0 {
        return false;
    }
    let image_width = image_width as f32;
    let image_height = image_height as f32;
    objects.iter().all(|object| {
        object.bounds.iter().all(|v| v.is_finite())
            && object.bounds[0] >= 0.0
            && object.bounds[1] >= 0.0
            && object.bounds[2] <= image_width
            && object.bounds[3] <= image_height
            && object.bounds[0] < object.bounds[2]
            && object.bounds[1] < object.bounds[3]
            && valid_color(object.color)
    }) && overlays.iter().all(|overlay| {
        overlay.bounds.iter().all(|v| v.is_finite())
            && overlay.bounds[0] <= overlay.bounds[2]
            && overlay.bounds[1] <= overlay.bounds[3]
            && valid_color(overlay.color)
    })
}

fn valid_color(color: [f32; 4]) -> bool {
    color
        .iter()
        .all(|channel| channel.is_finite() && (0.0..=1.0).contains(channel))
}

pub fn dirty_byte_range(
    range: Range<usize>,
    element_size: usize,
    total_elements: usize,
) -> Option<Range<u64>> {
    if range.start > range.end || range.end > total_elements || element_size == 0 {
        return None;
    }
    if range.is_empty() {
        return Some(0..0);
    }
    let start = range.start.checked_mul(element_size)? as u64;
    let end = range.end.checked_mul(element_size)? as u64;
    let aligned_start = start & !3;
    let aligned_end = end.checked_add(3)? & !3;
    Some(aligned_start..aligned_end)
}

/// Border thickness in CSS pixels is independent of image magnification.
pub const fn bbox_stroke_css_pixels() -> f32 {
    1.5
}
/// Selection handles use the same CSS-space diameter at every image zoom.
pub const fn control_diameter_css_pixels() -> f32 {
    8.0
}
