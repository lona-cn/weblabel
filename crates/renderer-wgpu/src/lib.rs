//! Real browser WebGPU rendering and platform-independent layout invariants.

pub mod buffers;
#[cfg(target_arch = "wasm32")]
mod device;
pub mod image;
mod renderer;
pub mod scene;

pub use renderer::{Renderer, RendererError};

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn initialize_browser_device_probe() -> Result<String, wasm_bindgen::JsValue> {
    let (adapter, device, _queue) = device::request_device()
        .await
        .map_err(|e| wasm_bindgen::JsValue::from_str(&e))?;
    let info = adapter.get_info();
    device.destroy();
    Ok(format!(
        "backend={:?}; device_type={:?}",
        info.backend, info.device_type
    ))
}
