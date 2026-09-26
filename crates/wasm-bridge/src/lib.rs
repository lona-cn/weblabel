//! Browser-facing C3 editor facade (docs/contracts.md C3): `create_editor`
//! plus the `EditorFacade` surface over editor-core and renderer-wgpu.
//! JsValue/serde_wasm_bindgen wrapping stays inside `facade`'s wasm32 module.

mod facade;
mod input;

pub use facade::{
    api_error, api_error_from_domain, validate_canonical_rgba, EditorSession, PreparedFrame,
    ProjectionCache,
};
pub use input::{pointer_input, tool, viewport, LocalFlagsArgs, PointerInputArgs, ViewportArgs};

#[cfg(target_arch = "wasm32")]
pub use facade::wasm::{create_editor, EditorFacade};
