#[cfg(test)]
mod tests {
    use crate::{DsError, DsStub, InstanceConfig, RegisterGroup};
    use dilla_core::ids::InstanceId;
    use dilla_core::mls::{DillaBinding, GroupKind};

    fn config() -> InstanceConfig {
        InstanceConfig {
            instance_id: InstanceId::from_bytes([0x11; 16]),
            signing_key: [0x77; 32],
            policy_version: 1,
            k_frank: [0x09; 32],
        }
    }

    fn binding() -> DillaBinding {
        DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            community_id: None,
            target_id: [0x33; 16],
            kind: GroupKind::Text,
            policy_version: 1,
            e2ee_version: 1,
            media_version: 0,
        }
    }

    /// Invariant 1: a malformed binding is refused before anything is stored.
    #[test]
    fn register_group_refuses_a_malformed_binding() {
        let mut ds = DsStub::new(config());
        let err = ds
            .register_group(RegisterGroup {
                binding: vec![0xff, 0xff],
                group_info: Vec::new(),
                ratchet_tree: Vec::new(),
            })
            .expect_err("a malformed binding must be refused");
        assert!(matches!(err, DsError::BindingInvalid));
        assert_eq!(err.code(), "E_BINDING_INVALID");
        assert_eq!(err.http_status(), 400);
    }

    /// Invariant 1: a binding naming another instance is refused.
    #[test]
    fn register_group_refuses_a_binding_for_another_instance() {
        let mut ds = DsStub::new(config());
        let mut foreign = binding();
        foreign.instance_id = InstanceId::from_bytes([0x99; 16]);
        let err = ds
            .register_group(RegisterGroup {
                binding: foreign.encode(),
                group_info: Vec::new(),
                ratchet_tree: Vec::new(),
            })
            .expect_err("another instance's binding must be refused");
        assert!(matches!(err, DsError::BindingInvalid));
    }

    /// Role 1 (the KeyPackage directory, protocol/02 line 60): the directory consumes ordinary
    /// packages and never the last resort.
    #[test]
    fn take_key_package_never_consumes_the_last_resort_until_the_others_are_gone() {
        use dilla_core::ids::DeviceId;
        let mut ds = DsStub::new(config());
        let device = DeviceId::from_bytes([0x02; 16]);
        assert_eq!(
            ds.publish_key_packages(
                device,
                vec![b"kp-1".to_vec(), b"kp-2".to_vec()],
                b"last".to_vec()
            )
            .unwrap(),
            2
        );
        let (first, was_last) = ds.take_key_package(&device).unwrap();
        assert_eq!(first, b"kp-1".to_vec());
        assert!(!was_last);
        let (second, was_last) = ds.take_key_package(&device).unwrap();
        assert_eq!(second, b"kp-2".to_vec());
        assert!(!was_last);
        // the ordinary packages are exhausted; the last-resort one is served but not consumed
        let (third, was_last) = ds.take_key_package(&device).unwrap();
        assert_eq!(third, b"last".to_vec());
        assert!(was_last);
        let (fourth, was_last) = ds.take_key_package(&device).unwrap();
        assert_eq!(fourth, b"last".to_vec());
        assert!(was_last);

        let unknown = DeviceId::from_bytes([0xee; 16]);
        assert!(matches!(
            ds.take_key_package(&unknown),
            Err(DsError::NotFound)
        ));
    }

    #[test]
    fn ds_error_codes_and_statuses_match_protocol_02() {
        assert_eq!(DsError::ModeReadable.code(), "E_MODE_READABLE");
        assert_eq!(DsError::ModeReadable.http_status(), 403);
        assert_eq!(DsError::GroupExists.code(), "E_GROUP_EXISTS");
        assert_eq!(DsError::GroupExists.http_status(), 409);
        assert_eq!(DsError::LeafNotCurrent.code(), "E_LEAF_NOT_CURRENT");
        assert_eq!(DsError::LeafNotCurrent.http_status(), 403);
        assert_eq!(DsError::CommitmentInvalid.code(), "E_COMMITMENT_INVALID");
        assert_eq!(DsError::CommitmentInvalid.http_status(), 422);
        assert_eq!(DsError::TooLarge.code(), "E_TOO_LARGE");
        assert_eq!(DsError::TooLarge.http_status(), 413);
        assert_eq!(DsError::Pruned.code(), "E_PRUNED");
        assert_eq!(DsError::Pruned.http_status(), 410);
        assert_eq!(
            DsError::CommitConflict {
                winning_commit: Vec::new(),
                proposals: Vec::new()
            }
            .code(),
            "E_COMMIT_CONFLICT"
        );
        assert_eq!(
            DsError::CommitConflict {
                winning_commit: Vec::new(),
                proposals: Vec::new()
            }
            .http_status(),
            409
        );
        assert_eq!(
            DsError::CommitRequired {
                proposals: Vec::new()
            }
            .http_status(),
            425
        );
        assert_eq!(
            DsError::CommitInvalid {
                reason: String::new()
            }
            .http_status(),
            422
        );
        assert_eq!(DsError::NotFound.http_status(), 404);
    }

    /// interfaces.md §2.1: one E_* vocabulary — a 25-row table after ID12 — and
    /// the two new DS codes 404 E_NOT_FOUND and 429 E_RATE_LIMITED. Only the
    /// twelve the delivery service itself raises are DsError variants.
    #[test]
    fn ds_error_codes_are_the_e_star_vocabulary() {
        let cases: &[(DsError, &str, u16)] = &[
            (DsError::BindingInvalid, "E_BINDING_INVALID", 400),
            (DsError::ModeReadable, "E_MODE_READABLE", 403),
            (DsError::LeafNotCurrent, "E_LEAF_NOT_CURRENT", 403),
            (DsError::NotFound, "E_NOT_FOUND", 404),
            (DsError::GroupExists, "E_GROUP_EXISTS", 409),
            (DsError::Pruned, "E_PRUNED", 410),
            (DsError::TooLarge, "E_TOO_LARGE", 413),
            (DsError::CommitmentInvalid, "E_COMMITMENT_INVALID", 422),
            (DsError::RateLimited { retry_after_ms: 1_500 }, "E_RATE_LIMITED", 429),
        ];
        for (err, code, status) in cases {
            assert_eq!(err.code(), *code, "code for {err:?}");
            assert_eq!(err.http_status(), *status, "status for {err:?}");
        }
        let conflict = DsError::CommitConflict { winning_commit: vec![1], proposals: vec![vec![2]] };
        assert_eq!(conflict.code(), "E_COMMIT_CONFLICT");
        assert_eq!(conflict.http_status(), 409);
        let required = DsError::CommitRequired { proposals: vec![vec![3]] };
        assert_eq!(required.code(), "E_COMMIT_REQUIRED");
        assert_eq!(required.http_status(), 425);
        let invalid = DsError::CommitInvalid { reason: "group_info_signature".into() };
        assert_eq!(invalid.code(), "E_COMMIT_INVALID");
        assert_eq!(invalid.http_status(), 422);
    }

    /// Every code is a stable string starting `E_`, and no two variants share one.
    #[test]
    fn ds_error_codes_are_unique_and_prefixed() {
        let all = [
            DsError::BindingInvalid.code(),
            DsError::ModeReadable.code(),
            DsError::LeafNotCurrent.code(),
            DsError::NotFound.code(),
            DsError::GroupExists.code(),
            DsError::Pruned.code(),
            DsError::TooLarge.code(),
            DsError::CommitmentInvalid.code(),
            DsError::RateLimited { retry_after_ms: 0 }.code(),
            DsError::CommitConflict { winning_commit: vec![], proposals: vec![] }.code(),
            DsError::CommitRequired { proposals: vec![] }.code(),
            DsError::CommitInvalid { reason: String::new() }.code(),
        ];
        for code in all {
            assert!(code.starts_with("E_"), "{code} is not an E_* code");
        }
        let mut sorted = all.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), before, "duplicate DsError code");
    }
}
