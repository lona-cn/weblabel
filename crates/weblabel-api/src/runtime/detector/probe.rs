//! Existing NDJSON Probe method: deterministic preprocessing only, never ORT/model loading.
use super::{worker, DetectorError, Projection, WorkerInput};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{BufWriter, Write},
    path::PathBuf,
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    run_id: String,
    artifact_root: PathBuf,
    input: WorkerInput,
    projection: Projection,
    timeout_ms: u64,
    output_name: String,
}
fn error(code: &str) -> DetectorError {
    DetectorError::new(code, "preprocessing-only probe rejected")
}
pub(super) fn preprocess(value: Value) -> Result<Value, DetectorError> {
    let request: Request = serde_json::from_value(value).map_err(|_| error("invalid_request"))?;
    request.projection.validate()?;
    if request.run_id.is_empty()
        || request.run_id.len() > 128
        || request.timeout_ms == 0
        || !request.artifact_root.is_absolute()
        || request.output_name.is_empty()
        || request.output_name.len() > 128
        || request.output_name.contains(['/', '\\', ':'])
        || request.output_name == "."
        || request.output_name == ".."
    {
        return Err(error("invalid_request"));
    }
    let root = request
        .artifact_root
        .canonicalize()
        .map_err(|_| error("input_missing"))?;
    let output = root.join(&request.output_name);
    // Refuse an existing output BEFORE reading/processing image bytes.
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&output).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            error("preprocess_output_exists")
        } else {
            error("detector_io")
        }
    })?;
    worker::check_handle(&root, &output, &file, "input_missing")?;
    let tensor = worker::tensor(&root, &request.input, &request.projection)?;
    let mut writer = BufWriter::with_capacity(65536, file);
    let mut hasher = Sha256::new();
    for value in tensor {
        let bytes = value.to_le_bytes();
        writer.write_all(&bytes)?;
        hasher.update(bytes);
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(
        json!({"kind":"preprocess_only","run_id":request.run_id,"shape":[1,3,640,640],"dtype":"float32-le",
        "tensor_file":request.output_name,"tensor_sha256":format!("{:x}",hasher.finalize()),
        "processor":"Transformers5.17 RTDetrImageProcessor / Torchvision0.29.1 / Torch2.14 CPU uint8 bilinear antialias",
        "model_loaded":false,"forward_completed":false,"detector_forwards":0}),
    )
}
