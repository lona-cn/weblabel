use annotation_domain::BBox;

pub(crate) mod dense;
pub(crate) mod gesture;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Select,
    Box,
    Pan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerPhase {
    Down,
    Move,
    Up,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointerInput {
    pub phase: PointerPhase,
    pub pointer_id: i32,
    pub x_css: f64,
    pub y_css: f64,
    pub button: i16,
    pub buttons: i16,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Preview {
    pub geometry: BBox,
}
