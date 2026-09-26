//! C3 boundary argument decoding: JS objects become typed editor inputs, and
//! every rejection is a structured `ApiError` — never a panic.
use annotation_domain::ApiError;
use editor_core::{PointerInput, PointerPhase, Tool};
use geometry::Viewport;
use serde::{Deserialize, Serialize};

use crate::facade::api_error;

/// C3 `PointerInput` wire shape (docs/contracts.md C3).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointerInputArgs {
    pub phase: String,
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

/// C3 `Viewport` wire shape. DPR sizes the backing store only; it never
/// participates in image coordinates (docs/architecture.md view formula).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewportArgs {
    pub scale: f64,
    pub tx: f64,
    pub ty: f64,
    pub css_width: f64,
    pub css_height: f64,
    pub dpr: f64,
}

/// C3 `set_local_flags` flags object.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFlagsArgs {
    pub hidden: Option<bool>,
    pub locked: Option<bool>,
}

pub fn pointer_input(args: PointerInputArgs) -> Result<PointerInput, ApiError> {
    let phase = match args.phase.as_str() {
        "down" => PointerPhase::Down,
        "move" => PointerPhase::Move,
        "up" => PointerPhase::Up,
        "cancel" => PointerPhase::Cancel,
        _ => {
            return Err(api_error(
                "INVALID_POINTER",
                "phase must be one of down|move|up|cancel",
            ))
        }
    };
    if !args.x_css.is_finite() || !args.y_css.is_finite() {
        return Err(api_error(
            "INVALID_POINTER",
            "pointer coordinates must be finite",
        ));
    }
    Ok(PointerInput {
        phase,
        pointer_id: args.pointer_id,
        x_css: args.x_css,
        y_css: args.y_css,
        button: args.button,
        buttons: args.buttons,
        shift: args.shift,
        ctrl: args.ctrl,
        alt: args.alt,
        meta: args.meta,
    })
}

pub fn viewport(args: ViewportArgs) -> Result<Viewport, ApiError> {
    Viewport::try_new(
        args.scale,
        args.tx,
        args.ty,
        args.css_width,
        args.css_height,
        args.dpr,
    )
    .map_err(|error| api_error(error.code, error.message))
}

pub fn tool(name: &str) -> Result<Tool, ApiError> {
    match name {
        "select" => Ok(Tool::Select),
        "box" => Ok(Tool::Box),
        "pan" => Ok(Tool::Pan),
        _ => Err(api_error(
            "INVALID_TOOL",
            "tool must be one of select|box|pan",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(phase: &str) -> PointerInputArgs {
        PointerInputArgs {
            phase: phase.to_owned(),
            pointer_id: 7,
            x_css: 10.5,
            y_css: -3.25,
            button: 0,
            buttons: 1,
            shift: true,
            ctrl: false,
            alt: false,
            meta: true,
        }
    }

    #[test]
    fn maps_every_c3_pointer_phase_and_modifier() {
        for (phase, expected) in [
            ("down", PointerPhase::Down),
            ("move", PointerPhase::Move),
            ("up", PointerPhase::Up),
            ("cancel", PointerPhase::Cancel),
        ] {
            let input = pointer_input(args(phase)).expect("valid phase");
            assert_eq!(input.phase, expected);
            assert_eq!(input.pointer_id, 7);
            assert_eq!(input.x_css, 10.5);
            assert_eq!(input.y_css, -3.25);
            assert!(input.shift && input.meta && !input.ctrl && !input.alt);
        }
    }

    #[test]
    fn rejects_unknown_phase_with_structured_error() {
        let error = pointer_input(args("drag")).err().expect("unknown phase");
        assert_eq!(error.code, "INVALID_POINTER");
        assert!(!error.request_id.is_empty());
    }

    #[test]
    fn rejects_non_finite_coordinates_with_structured_error() {
        let mut bad = args("move");
        bad.x_css = f64::NAN;
        assert_eq!(
            pointer_input(bad).err().expect("NaN x").code,
            "INVALID_POINTER"
        );
        bad = args("move");
        bad.y_css = f64::INFINITY;
        assert_eq!(
            pointer_input(bad).err().expect("infinite y").code,
            "INVALID_POINTER"
        );
    }

    #[test]
    fn deserializes_the_c3_wire_shape_strictly() {
        let parsed: PointerInputArgs = serde_json::from_str(
            r#"{"phase":"move","pointer_id":1,"x_css":2.0,"y_css":3.0,"button":0,"buttons":0,"shift":false,"ctrl":false,"alt":false,"meta":false}"#,
        )
        .expect("exact C3 shape");
        assert_eq!(parsed.pointer_id, 1);
        assert!(serde_json::from_str::<PointerInputArgs>(
            r#"{"phase":"move","pointer_id":1,"x_css":2.0,"y_css":3.0,"button":0,"buttons":0,"shift":false,"ctrl":false,"alt":false,"meta":false,"extra":1}"#
        )
        .is_err());
    }

    #[test]
    fn rejects_invalid_viewport_and_tool() {
        assert_eq!(
            viewport(ViewportArgs {
                scale: f64::NAN,
                tx: 0.0,
                ty: 0.0,
                css_width: 1.0,
                css_height: 1.0,
                dpr: 1.0
            })
            .err()
            .expect("invalid scale")
            .code,
            "INVALID_VIEWPORT"
        );
        assert!(
            viewport(ViewportArgs {
                scale: 1.0,
                tx: 0.0,
                ty: 0.0,
                css_width: 0.0,
                css_height: 0.0,
                dpr: 2.0
            })
            .is_ok(),
            "0x0 CSS size is a legal paused viewport"
        );
        assert!(matches!(tool("select"), Ok(Tool::Select)));
        assert_eq!(
            tool("wand").err().expect("invalid tool").code,
            "INVALID_TOOL"
        );
    }
}
