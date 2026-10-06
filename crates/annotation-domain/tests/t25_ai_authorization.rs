use annotation_domain::{AiApprovedGrants, AiConsentResponse};
use serde_json::json;

#[test]
fn explicit_crop_scope_and_utc_consent_expiry_are_required() {
    let grants = json!({"allow_image":true,"allow_object_context":false,"preview_crop":null});
    assert_eq!(
        serde_json::from_value::<AiApprovedGrants>(grants.clone())
            .unwrap()
            .preview_crop,
        None
    );
    let mut omitted = grants;
    omitted.as_object_mut().unwrap().remove("preview_crop");
    assert!(serde_json::from_value::<AiApprovedGrants>(omitted).is_err());
    let mut consent = json!({"consent_id":"consent-1","preview_id":"preview-1","input_fingerprint":"frozen-input","expires_at":"2026-10-06T12:00:00Z"});
    assert_eq!(
        serde_json::from_value::<AiConsentResponse>(consent.clone())
            .unwrap()
            .expires_at,
        "2026-10-06T12:00:00Z"
    );
    for invalid in [
        json!("2026-10-06T12:00:00+01:00"),
        json!("2026-10-06T12:00:00-00:00"),
        json!("2026-10-06T12:00:00"),
        json!("not-a-timestamp"),
        json!(false),
        json!(null),
    ] {
        consent["expires_at"] = invalid;
        assert!(serde_json::from_value::<AiConsentResponse>(consent.clone()).is_err());
    }
    consent.as_object_mut().unwrap().remove("expires_at");
    assert!(serde_json::from_value::<AiConsentResponse>(consent).is_err());
}
