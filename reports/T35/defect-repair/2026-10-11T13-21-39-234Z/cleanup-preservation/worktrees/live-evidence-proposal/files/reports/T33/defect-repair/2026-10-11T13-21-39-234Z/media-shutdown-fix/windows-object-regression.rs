#[cfg(windows)]
#[test]
fn long_windows_object_paths_publish_atomically_deduplicate_and_survive_reopen() {
    use std::os::windows::ffi::OsStrExt;

    let temp = tempdir().unwrap();
    let base = temp.path().join("long-object-root");
    let padding = 191usize.saturating_sub(base.as_os_str().encode_wide().count() + 1).max(1);
    let root = base.join("r".repeat(padding));
    let store = ObjectStore::new(&root).unwrap();
    let bytes = b"immutable media at the Windows native path boundary";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let destination = root.join(&hash[..2]).join(&hash[2..4]).join(&hash);
    assert!(destination.as_os_str().encode_wide().count() >= 260);

    let unpublished = store.stage_bytes("original.jpg", bytes).unwrap();
    assert!(!destination.exists(), "unpublished bytes must not be a readable object");
    drop(unpublished);
    assert_eq!(count_files(store.root()), 0);

    let first = store.stage_bytes("original.jpg", bytes).unwrap().publish().unwrap();
    assert_eq!(first.sha256, hash);
    assert_eq!(first.size_bytes, bytes.len() as u64);
    assert_eq!(std::fs::read(&first.path).unwrap(), bytes);
    let second = store.put_bytes("another-name.jpg", bytes).unwrap();
    assert_eq!(second.sha256, hash);
    assert_eq!(std::fs::read(&second.path).unwrap(), bytes);
    assert_eq!(count_files(store.root()), 1);
    drop(store);

    let reopened = ObjectStore::new(&root).unwrap();
    assert_eq!(std::fs::read(reopened.path_for_hash(&hash).unwrap()).unwrap(), bytes);
    assert_eq!(count_files(reopened.root()), 1);
}
