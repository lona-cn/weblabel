use annotation_domain::BBox;

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

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PointerGesture {
    pub pointer_id: i32,
    pub start: [f64; 2],
    pub current: [f64; 2],
    pub additive: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Preview {
    pub geometry: BBox,
}
