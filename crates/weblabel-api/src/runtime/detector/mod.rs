//! Native, CPU-only detector. All execution is in the product's disposable worker.
mod adapter;
mod budget;
mod candidates;
mod decode;
mod pool;
mod preprocess;
mod probe;
mod worker;
pub use adapter::execute;
pub use decode::{decode, DecodeResult, Detection, Projection, UnsupportedDetection};
pub use pool::{Cancellation, DetectorPool};
pub use preprocess::preprocess_rgb;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
pub use worker::{read_frame, worker_stdio};

pub const MAX_FRAME: usize = 4 * 1024 * 1024;
pub const MODEL_ID: &str = "PekingU/rtdetr_v2_r18vd@5650961749fa93567c0d46fc7f43ea4f9e914107";
pub const INPUT_FLOATS: usize = 3 * 640 * 640;
pub const WINDOWS_CPU_DLL_SHA256: &str =
    "dec964ab1ee36cc9b0ae247d13b376627992fc57dec0454354017ab8fd84f1ea";

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct DetectorError {
    pub code: String,
    pub message: String,
}
impl DetectorError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for DetectorError {
    fn from(_: std::io::Error) -> Self {
        Self::new("detector_io", "detector I/O failed")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkerInput {
    Image { path: PathBuf, sha256: String },
    Tensor { path: PathBuf, sha256: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetTicket {
    pub ledger: PathBuf,
    pub sequence: u64,
    pub nonce: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    pub run_id: String,
    /// Private job spool, selected by the trusted parent, never a browser path.
    pub artifact_root: PathBuf,
    pub lock_path: PathBuf,
    pub model_dir: PathBuf,
    pub runtime_library: PathBuf,
    pub runtime_sha256: String,
    pub label_map_path: PathBuf,
    pub input: WorkerInput,
    pub projection: Projection,
    pub region: Option<[u32; 4]>,
    pub timeout_ms: u64,
    /// Present only in measured development; the receipt is precharged before sending.
    pub budget_ticket: Option<BudgetTicket>,
    pub return_raw: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkerResult {
    pub run_id: String,
    pub input_tensor_sha256: String,
    pub projection: Projection,
    pub region: Option<[u32; 4]>,
    pub decoded: DecodeResult,
    pub raw_logits: Option<Vec<f32>>,
    pub raw_boxes: Option<Vec<f32>>,
    pub receipt: ExecutionReceipt,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecutionReceipt {
    pub implementation: String,
    pub runtime_version: String,
    pub execution_provider: String,
    pub model_id: String,
    pub model_sha256: String,
    pub run_id: String,
    pub cost: Option<f64>,
    pub cost_status: String,
}
