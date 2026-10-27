//! Native local operations. Only backup's owned snapshot is scrubbed; preflight
//! and usage inspection connect SQLite exclusively to isolated filesystem copies.
pub mod backup;
pub mod database;
pub mod doctor;
pub mod preflight;
mod privacy;
mod privacy_json;
mod storage;
