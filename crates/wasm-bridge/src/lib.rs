//! Browser-facing C3 editor facade (docs/contracts.md C3): `create_editor`
//! plus the `EditorFacade` surface over editor-core and renderer-wgpu.
//! JsValue/serde_wasm_bindgen wrapping stays inside `facade`'s wasm32 module.

mod facade;
mod input;

pub use facade::{
    api_error, api_error_from_domain, validate_canonical_rgba, CommitReadback, EditorSession,
    PreparedFrame, ProjectionCache,
};
pub use input::{pointer_input, tool, viewport, LocalFlagsArgs, PointerInputArgs, ViewportArgs};

#[cfg(target_arch = "wasm32")]
pub use facade::wasm::{create_editor, EditorFacade};

/// Read-only authorization hashing; no editor, canvas, DOM, or GPU is created.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn host_execution_configuration_hash(
    host_json: &str,
    provider_id: &str,
    profile_id: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    annotation_domain::hash::host_execution_configuration_hash(host_json, provider_id, profile_id)
        .map_err(|error| wasm_bindgen::JsValue::from_str(error.code))
}
