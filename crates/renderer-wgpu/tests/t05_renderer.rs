use renderer_wgpu::{
    buffers::{
        bbox_instances, BBoxInstance, BOUNDS_OFFSET, COLOR_OFFSET, FLAGS_OFFSET, INSTANCE_STRIDE,
    },
    image::padded_rgba_rows,
    scene::{
        bbox_stroke_css_pixels, changed_element_range, control_diameter_css_pixels,
        dirty_byte_range, scene_upload_plan, CanonicalImage, RenderObject, RenderScene, Viewport,
    },
};

#[test]
fn instance_layout_matches_shader_record() {
    assert_eq!(std::mem::size_of::<BBoxInstance>(), 48);
    assert_eq!(
        std::mem::offset_of!(BBoxInstance, bounds),
        BOUNDS_OFFSET as usize
    );
    assert_eq!(
        std::mem::offset_of!(BBoxInstance, color),
        COLOR_OFFSET as usize
    );
    assert_eq!(
        std::mem::offset_of!(BBoxInstance, flags),
        FLAGS_OFFSET as usize
    );
    assert_eq!(
        INSTANCE_STRIDE as usize,
        std::mem::size_of::<BBoxInstance>()
    );
}

#[test]
fn zero_area_viewport_has_no_backing_store_and_restores_nonzero_size() {
    let zero = Viewport {
        scale: 1.0,
        tx: 0.0,
        ty: 0.0,
        css_width: 0.0,
        css_height: 0.0,
        dpr: 2.0,
    };
    assert_eq!(zero.backing_size(), None);
    let restored = Viewport {
        css_width: 320.0,
        css_height: 240.0,
        ..zero
    };
    assert_eq!(restored.backing_size(), Some((640, 480)));
}

#[test]
fn screen_controls_and_stroke_do_not_scale_with_image_zoom() {
    let zooms = [0.125_f32, 1.0, 8.0];
    let control_diameters: Vec<_> = zooms
        .iter()
        .map(|_| control_diameter_css_pixels())
        .collect();
    let stroke_widths: Vec<_> = zooms.iter().map(|_| bbox_stroke_css_pixels()).collect();
    assert_eq!(control_diameters, vec![8.0; zooms.len()]);
    assert_eq!(stroke_widths, vec![1.5; zooms.len()]);
}

#[test]
fn render_uniform_keeps_css_geometry_aligned_across_dpr() {
    let viewport = Viewport {
        scale: 2.0,
        tx: 13.0,
        ty: -7.0,
        css_width: 320.0,
        css_height: 240.0,
        dpr: 1.0,
    };
    let high_dpi = Viewport {
        dpr: 2.0,
        ..viewport
    };
    let normal_uniform = viewport.render_uniform(640, 480);
    let high_dpi_uniform = high_dpi.render_uniform(640, 480);
    assert_eq!(&normal_uniform[..5], &high_dpi_uniform[..5]);
    assert_eq!(&normal_uniform[6..8], &high_dpi_uniform[6..8]);
    let image_x_css = 10.0 * high_dpi_uniform[4] + high_dpi_uniform[2];
    let image_y_css = 20.0 * high_dpi_uniform[4] + high_dpi_uniform[3];
    assert_eq!([image_x_css, image_y_css], [33.0, 33.0]);
    assert_eq!(
        high_dpi.css_pixels_to_clip(image_x_css, image_y_css),
        viewport.css_pixels_to_clip(image_x_css, image_y_css)
    );
}

#[test]
fn dirty_ranges_are_bounded_and_word_aligned() {
    assert_eq!(dirty_byte_range(3..4, 48, 8), Some(144..192));
    assert_eq!(dirty_byte_range(2..2, 48, 8), Some(0..0));
    assert_eq!(dirty_byte_range(7..9, 48, 8), None);
    assert_eq!(dirty_byte_range(4..3, 48, 8), None);
}

#[test]
fn canonical_rgba_upload_pads_rows_without_changing_pixel_order() {
    let src: Vec<u8> = (0..3 * 2 * 4).collect();
    let (stride, bytes) = padded_rgba_rows(3, 2, &src).unwrap();
    assert_eq!(stride, 256);
    assert_eq!(&bytes[..12], &src[..12]);
    assert_eq!(&bytes[256..268], &src[12..24]);
    assert_eq!(bytes.len(), 512);
    assert!(padded_rgba_rows(3, 2, &src[..23]).is_none());
    assert!(padded_rgba_rows(0, 2, &[]).is_none());
}

#[test]
fn rejects_corrupt_canonical_texture_dimensions() {
    let image = CanonicalImage {
        width: 640,
        height: 480,
        rgba: vec![0; 640 * 480 * 4 - 1],
    };
    assert!(!renderer_wgpu::scene::validate_image(&image));
}

#[test]
fn annotation_srgb_colors_are_converted_for_srgb_surface_output() {
    let instances = bbox_instances(&[RenderObject {
        bounds: [10.0, 20.0, 110.0, 220.0],
        color: [0.5, 0.25, 1.0, 0.4],
        selected: true,
        locked: false,
    }]);
    assert!((instances[0].color[0] - 0.214_041_14).abs() < 1e-6);
    assert!((instances[0].color[1] - 0.050_876_09).abs() < 1e-6);
    assert_eq!(instances[0].color[2], 1.0);
    assert_eq!(instances[0].color[3], 0.4);
}

fn test_scene() -> RenderScene {
    RenderScene {
        viewport: Viewport {
            scale: 1.0,
            tx: 0.0,
            ty: 0.0,
            css_width: 100.0,
            css_height: 80.0,
            dpr: 1.0,
        },
        image: CanonicalImage {
            width: 4,
            height: 2,
            rgba: vec![0; 4 * 2 * 4],
        },
        objects: Vec::new(),
        overlays: Vec::new(),
    }
}

fn test_object(x_min: f32) -> RenderObject {
    RenderObject {
        bounds: [x_min, 0.0, x_min + 1.0, 1.0],
        color: [1.0, 0.0, 0.0, 1.0],
        selected: false,
        locked: false,
    }
}

#[test]
fn viewport_update_plan_skips_image_and_instance_uploads() {
    let previous = test_scene();
    let mut next = previous.clone();
    next.viewport.tx = 12.0;
    let plan = scene_upload_plan(Some(&previous), &next);
    assert!(!plan.image_changed);
    assert_eq!(plan.object_range, None);
    assert_eq!(plan.overlay_range, None);
}

#[test]
fn scene_upload_plan_targets_only_changed_instance_ranges() {
    let mut previous = test_scene();
    previous.objects = (0..3).map(|index| test_object(index as f32)).collect();
    let mut next = previous.clone();
    next.objects[1].selected = true;
    assert_eq!(
        changed_element_range(&previous.objects, &next.objects),
        Some(1..2)
    );
    let plan = scene_upload_plan(Some(&previous), &next);
    assert!(!plan.image_changed);
    assert_eq!(plan.object_range, Some(1..2));
    assert_eq!(plan.overlay_range, None);
    next.image.rgba[0] = 1;
    assert!(scene_upload_plan(Some(&previous), &next).image_changed);
}

#[test]
fn render_scene_rejects_object_bounds_outside_canonical_image() {
    let mut scene = test_scene();
    scene.objects.push(test_object(0.0));
    assert!(renderer_wgpu::scene::validate_scene(&scene));
    scene.objects[0].bounds[0] = -0.01;
    assert!(!renderer_wgpu::scene::validate_scene(&scene));
    scene.objects[0].bounds = [0.0, 0.0, 4.01, 1.0];
    assert!(!renderer_wgpu::scene::validate_scene(&scene));
}
