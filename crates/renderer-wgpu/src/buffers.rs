use crate::scene::{Overlay, RenderObject};

/// WGSL storage/vertex record; padding is explicit, never Rust bools.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BBoxInstance {
    pub bounds: [f32; 4],
    pub color: [f32; 4],
    pub flags: u32,
    pub padding: [u32; 3],
}

pub const INSTANCE_STRIDE: u64 = 48;
pub const BOUNDS_OFFSET: u64 = 0;
pub const COLOR_OFFSET: u64 = 16;
pub const FLAGS_OFFSET: u64 = 32;

pub fn bbox_instances(objects: &[RenderObject]) -> Vec<BBoxInstance> {
    let mut instances = Vec::with_capacity(objects.len());
    bbox_instances_into(objects, &mut instances);
    instances
}

pub fn bbox_instances_into(objects: &[RenderObject], instances: &mut Vec<BBoxInstance>) {
    instances.clear();
    instances.extend(objects.iter().map(|object| BBoxInstance {
        bounds: object.bounds,
        color: srgb_color_to_linear(object.color),
        flags: u32::from(object.selected) | (u32::from(object.locked) << 1),
        padding: [0; 3],
    }));
}

pub fn overlay_instances_into(overlays: &[Overlay], instances: &mut Vec<BBoxInstance>) {
    instances.clear();
    instances.extend(overlays.iter().map(|overlay| BBoxInstance {
        bounds: overlay.bounds,
        color: srgb_color_to_linear(overlay.color),
        flags: 0,
        padding: [0; 3],
    }));
}

fn srgb_color_to_linear(color: [f32; 4]) -> [f32; 4] {
    let convert = |c: f32| {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    [
        convert(color[0]),
        convert(color[1]),
        convert(color[2]),
        color[3],
    ]
}
