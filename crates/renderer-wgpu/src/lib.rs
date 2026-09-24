//! Browser GPU renderer; scene rendering is implemented in T05.

/// Requests a browser WebGPU adapter and device without silently substituting another backend.
#[cfg(target_arch = "wasm32")]
async fn request_browser_device() -> Result<(wgpu::Adapter, wgpu::Device, wgpu::Queue), String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .map_err(|error| error.to_string())?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .map_err(|error| error.to_string())?;
    Ok((adapter, device, queue))
}

/// Initializes an actual WebGPU device and returns adapter diagnostics for the browser UI.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn initialize_browser_device_probe() -> Result<String, wasm_bindgen::JsValue> {
    let (adapter, device, _queue) = request_browser_device()
        .await
        .map_err(|message| wasm_bindgen::JsValue::from_str(&message))?;
    let info = adapter.get_info();
    device.destroy();
    Ok(format!(
        "backend={:?}; device_type={:?}",
        info.backend, info.device_type
    ))
}
