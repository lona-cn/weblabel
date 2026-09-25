use weblabel_api::auth::{
    hash_launch_code, hash_password, verify_launch_code, verify_password, Role,
};

#[test]
fn passwords_are_argon2id_and_only_verify_for_the_original_secret() {
    let encoded = hash_password("correct horse battery staple").expect("password hashing succeeds");
    assert!(encoded.starts_with("$argon2id$"));
    assert!(verify_password("correct horse battery staple", &encoded));
    assert!(!verify_password("incorrect horse battery staple", &encoded));
}

#[test]
fn project_role_policy_distinguishes_writers_from_review_only_and_read_only_roles() {
    assert!(Role::Admin.can_write());
    assert!(Role::Annotator.can_write());
    assert!(!Role::Reviewer.can_write());
    assert!(!Role::Viewer.can_write());
    assert_eq!(Role::parse("viewer"), Some(Role::Viewer));
    assert_eq!(Role::parse("owner"), None);
}
#[test]
fn bootstrap_code_expires_and_rejects_a_nonmatching_candidate() {
    let code = "one-time-launch-code";
    let hash = hash_launch_code(code);
    assert!(verify_launch_code(code, &hash, 100, 100));
    assert!(!verify_launch_code(code, &hash, 99, 100));
    assert!(!verify_launch_code("different-code", &hash, 101, 100));
}
