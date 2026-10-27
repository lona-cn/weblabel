use annotation_domain::hash::runtime_execution_configuration_hash as hash;
use serde_json::{json, Value};

#[test]
fn native_hash_selects_exact_local_profile_and_preserves_numeric_identity() {
    let mut runtime = json!({"schema_version":1,"timeout_ms":1000,"providers":[
        {"provider":"claude_local","config":{"profile_id":"first","model_id":"claude-first","timeout_ms":1.0}},
        {"provider":"claude_local","config":{"profile_id":"second","model_id":"claude-second","timeout_ms":2}}
    ]});
    let first = hash(&runtime.to_string(), "claude_local", "first").unwrap();
    let second = hash(&runtime.to_string(), "claude_local", "second").unwrap();
    assert_ne!(first, second);
    assert!(hash(&runtime.to_string(), "claude_local", "missing").is_err());
    assert!(hash(&runtime.to_string(), "detector_local", "first").is_err());
    runtime["providers"][1]["config"]["model_id"] = json!("changed-other-profile");
    assert_eq!(
        hash(&runtime.to_string(), "claude_local", "first").unwrap(),
        first
    );
    runtime["providers"][0]["config"]["timeout_ms"] = json!(1);
    assert_ne!(
        hash(&runtime.to_string(), "claude_local", "first").unwrap(),
        first
    );
    let duplicate = runtime["providers"][0].clone();
    runtime["providers"].as_array_mut().unwrap().push(duplicate);
    assert!(hash(&runtime.to_string(), "claude_local", "first").is_err());
    runtime["schema_version"] = Value::Null;
    assert!(hash(&runtime.to_string(), "claude_local", "second").is_err());
}
