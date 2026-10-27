use super::{BudgetTicket, DetectorError};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};
fn error() -> DetectorError {
    DetectorError::new(
        "forward_budget_unavailable",
        "missing, corrupt, exhausted, or replayed development receipt",
    )
}
/// Same persistent sidecar byte range as Python. Never deletes or replaces a lock.
pub fn redeem(ticket: &BudgetTicket) -> Result<(), DetectorError> {
    let sidecar = ticket.ledger.with_file_name(format!(
        "{}.lock",
        ticket
            .ledger
            .file_name()
            .ok_or_else(error)?
            .to_string_lossy()
    ));
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(sidecar)
        .map_err(|_| error())?;
    lock.lock().map_err(|_| error())?;
    let result = (|| {
        let mut text = String::new();
        File::open(&ticket.ledger)
            .map_err(|_| error())?
            .take(64 * 1024)
            .read_to_string(&mut text)
            .map_err(|_| error())?;
        let mut state: Value = serde_json::from_str(&text).map_err(|_| error())?;
        let used = state["used"].as_u64().ok_or_else(error)?;
        if state["schema_version"] != 1 || state["limit"] != 20 || used > 20 {
            return Err(error());
        }
        let receipts = state["receipts"].as_array_mut().ok_or_else(error)?;
        if receipts.len() != used as usize || ticket.sequence == 0 || ticket.sequence > used {
            return Err(error());
        }
        for (i, r) in receipts.iter().enumerate() {
            if r["sequence"].as_u64() != Some(i as u64 + 1) {
                return Err(error());
            }
        }
        let receipt = &mut receipts[ticket.sequence as usize - 1];
        if receipt["nonce"].as_str() != Some(ticket.nonce.as_str())
            || receipt["kind"] != "rust-request"
            || receipt["redeemed"] != false
        {
            return Err(error());
        }
        receipt["redeemed"] = json!(true);
        let temporary = ticket.ledger.with_file_name(format!(
            "{}.{}.tmp",
            ticket
                .ledger
                .file_name()
                .ok_or_else(error)?
                .to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| error())?;
        file.write_all(
            serde_json::to_string(&state)
                .map_err(|_| error())?
                .as_bytes(),
        )
        .map_err(|_| error())?;
        file.sync_all().map_err(|_| error())?;
        drop(file);
        replace(&temporary, &ticket.ledger)?;
        Ok(())
    })();
    lock.unlock().map_err(|_| error())?;
    result
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<(), DetectorError> {
    std::fs::rename(from, to).map_err(|_| error())?;
    File::open(to.parent().ok_or_else(error)?)
        .and_then(|f| f.sync_all())
        .map_err(|_| error())
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<(), DetectorError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: NUL-terminated path buffers remain live during this synchronous call.
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn synthetic_precharged_rust_ticket_is_redeemed_once_without_model_loading() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/test-artifacts/R05");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let ledger = dir.path().join("CONTROL-ledger.json");
        std::fs::write(dir.path().join("CONTROL-ledger.json.lock"), [0u8]).unwrap();
        std::fs::write(&ledger,serde_json::to_vec(&json!({"schema_version":1,"limit":20,"used":1,"receipts":[{"sequence":1,"kind":"rust-request","nonce":"control-nonce","redeemed":false}]})).unwrap()).unwrap();
        let ticket = BudgetTicket {
            ledger: ledger.clone(),
            sequence: 1,
            nonce: "control-nonce".into(),
        };
        redeem(&ticket).unwrap();
        let state: Value = serde_json::from_slice(&std::fs::read(&ledger).unwrap()).unwrap();
        assert_eq!(state["used"], 1);
        assert_eq!(state["receipts"][0]["redeemed"], true);
        assert_eq!(
            redeem(&ticket).unwrap_err().code,
            "forward_budget_unavailable"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&ledger).unwrap()).unwrap()["used"],
            1
        );
    }
}
