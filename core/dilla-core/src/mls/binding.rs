//! `dilla_binding`: the GroupContext extension that nails a group to one instance, one target and
//! one protocol version (protocol/01-groups.md "dilla_binding"). It is immutable for the group's
//! life, and every Welcome, GroupInfo, Proposal and Commit is checked against it.

use crate::cbor::{Encoder, decode_strict};
use crate::error::ProtocolError;
use crate::ids::{CommunityId, DeviceId, InstanceId};
use openmls::extensions::{ExternalSender, ExternalSendersExtension, SenderExtensionIndex};
use openmls::prelude::*;

/// Private-use extension type. 0xF000-0xFFFF is "Reserved for Private Use" in the live IANA
/// registry for RFC 9420, and 0xF001 is not a GREASE value (gap-4 section 1.1).
pub const DILLA_BINDING_ID: u16 = 0xF001;
pub const DILLA_BINDING: ExtensionType = ExtensionType::Unknown(DILLA_BINDING_ID);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum GroupKind {
    Text = 0,
    Call = 1,
    Pairing = 2,
    Interaction = 3,
}

impl GroupKind {
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u64(v: u64) -> Result<Self, ProtocolError> {
        Ok(match v {
            0 => Self::Text,
            1 => Self::Call,
            2 => Self::Pairing,
            3 => Self::Interaction,
            _ => return Err(ProtocolError::Binding),
        })
    }

    /// Only text and call groups carry the instance as an external sender; pairing and interaction
    /// groups must not (`E_EXTERNAL_SENDER_FORBIDDEN`).
    pub const fn has_external_sender(self) -> bool {
        matches!(self, Self::Text | Self::Call)
    }

    pub const fn media_version(self) -> u64 {
        match self {
            Self::Call => 1,
            _ => 0,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DillaBinding {
    pub v: u64,
    pub instance_id: InstanceId,
    /// `None` for DMs, group DMs, pairing and interaction groups.
    pub community_id: Option<CommunityId>,
    /// channel_id, dm_id, the new device_id (pairing) or the bot's user_id (interaction).
    pub target_id: [u8; 16],
    pub kind: GroupKind,
    /// The instance's policy version at group creation. A snapshot, not an identity field.
    pub policy_version: u64,
    pub e2ee_version: u64,
    pub media_version: u64,
}

impl DillaBinding {
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(96);
        e.array(8)
            .uint(self.v)
            .bytes(self.instance_id.as_bytes())
            .opt_bytes(self.community_id.as_ref().map(|c| &c.0[..]))
            .bytes(&self.target_id)
            .uint(u64::from(self.kind.as_u8()))
            .uint(self.policy_version)
            .uint(self.e2ee_version)
            .uint(self.media_version);
        e.into_vec()
    }

    /// Rejects trailing bytes itself: OpenMLS does not re-parse or length-check unknown-extension
    /// payloads beyond the outer `opaque<V>` (gap-4 section 3), so without this an attacker can
    /// append padding to a valid binding and still round-trip it.
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(8)?;
            let v = d.uint()?;
            let instance_id = InstanceId::from_bytes(d.bytes_exact::<16>()?);
            let community_id = d.opt_bytes_exact::<16>()?.map(CommunityId::from_bytes);
            let target_id = d.bytes_exact::<16>()?;
            let kind = d.uint()?;
            Ok((
                v,
                instance_id,
                community_id,
                target_id,
                kind,
                d.uint()?,
                d.uint()?,
                d.uint()?,
            ))
        })
        .map_err(|_| ProtocolError::Binding)
        .and_then(
            |(v, instance_id, community_id, target_id, kind, policy_version, e2ee, media)| {
                if v != 1 {
                    return Err(ProtocolError::Binding);
                }
                Ok(Self {
                    v,
                    instance_id,
                    community_id,
                    target_id,
                    kind: GroupKind::from_u64(kind)?,
                    policy_version,
                    e2ee_version: e2ee,
                    media_version: media,
                })
            },
        )
    }

    pub fn to_extension(&self) -> Extension {
        Extension::Unknown(DILLA_BINDING_ID, UnknownExtension(self.encode()))
    }

    pub fn from_group_context(ctx: &GroupContext) -> Result<Self, ProtocolError> {
        Self::from_extensions(ctx.extensions())
    }

    pub fn from_extensions<T>(exts: &Extensions<T>) -> Result<Self, ProtocolError> {
        let raw = exts
            .unknown(DILLA_BINDING_ID)
            .ok_or(ProtocolError::Binding)?;
        Self::decode(&raw.0)
    }

    /// Everything immutable must match. `policy_version` is deliberately excluded: it is the
    /// instance's policy snapshot at creation and moves on without the group changing identity.
    pub fn matches(&self, expected: &DillaBinding) -> Result<(), ProtocolError> {
        let same = self.instance_id == expected.instance_id
            && self.community_id == expected.community_id
            && self.target_id == expected.target_id
            && self.kind == expected.kind
            && self.e2ee_version == expected.e2ee_version
            && self.media_version == expected.media_version;
        if same {
            Ok(())
        } else {
            Err(ProtocolError::Binding)
        }
    }
}

/// Version-2 binding for a Bot interaction group. The original `community_id` slot in the
/// eight-field `DillaBinding` remains null for kind 3; this typed extension adds the
/// installation's community scope and the one human participant as immutable GroupContext data.
/// Keeping this separate preserves v1 bindings (including legacy kind-3 groups) and avoids
/// treating a caller-supplied participant as authenticated before a group actually carries v2.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DillaInteractionBinding {
    pub instance_id: InstanceId,
    /// The Bot account, retained as the interaction group's v1 target.
    pub bot_user_id: [u8; 16],
    pub installation_id: [u8; 16],
    pub community_id: CommunityId,
    pub participant_user_id: [u8; 16],
    /// The specific authenticated participant device whose leaf is admitted to the group.
    pub participant_device_id: DeviceId,
    pub policy_version: u64,
    pub e2ee_version: u64,
    pub media_version: u64,
}

impl DillaInteractionBinding {
    /// Encode v2 as `[2, instance, null, bot, 3, policy, e2ee, media, installation,
    /// community, participant_user, participant_device]`. The null in position 2 preserves the established kind-3
    /// semantics; the appended community is the installation scope.
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(128);
        e.array(12)
            .uint(2)
            .bytes(self.instance_id.as_bytes())
            .null()
            .bytes(&self.bot_user_id)
            .uint(u64::from(GroupKind::Interaction.as_u8()))
            .uint(self.policy_version)
            .uint(self.e2ee_version)
            .uint(self.media_version)
            .bytes(&self.installation_id)
            .bytes(self.community_id.as_bytes())
            .bytes(&self.participant_user_id)
            .bytes(self.participant_device_id.as_bytes());
        e.into_vec()
    }

    /// Compare an inspected v2 binding with an expected admission tuple. The caller must source
    /// `expected` from an authenticated server admission result; this comparison is structural
    /// and does not authenticate either value or authorize group admission by itself.
    pub fn matches_admission(&self, expected: &Self) -> Result<(), ProtocolError> {
        let same = self.instance_id == expected.instance_id
            && self.bot_user_id == expected.bot_user_id
            && self.installation_id == expected.installation_id
            && self.community_id == expected.community_id
            && self.participant_user_id == expected.participant_user_id
            && self.participant_device_id == expected.participant_device_id
            && self.policy_version == expected.policy_version
            && self.e2ee_version == expected.e2ee_version
            && self.media_version == expected.media_version;
        if same {
            Ok(())
        } else {
            Err(ProtocolError::Binding)
        }
    }

    /// Check the locally known instance and Welcome recipient against an authenticated v2
    /// interaction binding. This is only a recipient check: it does not authorize the Bot,
    /// installation, community membership, or admission. Callers must still obtain and validate
    /// the server-side admission context before storing or activating an interaction group.
    pub fn matches_recipient(
        &self,
        instance_id: &InstanceId,
        user_id: &[u8; 16],
        device_id: &DeviceId,
    ) -> Result<(), ProtocolError> {
        if self.instance_id == *instance_id
            && self.participant_user_id == *user_id
            && self.participant_device_id == *device_id
        {
            Ok(())
        } else {
            Err(ProtocolError::Binding)
        }
    }

    /// Decode only the v2 interaction shape. Exact length, null legacy community scope, kind,
    /// protocol versions and all identity IDs are checked before returning a typed value.
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(12)?;
            let version = d.uint()?;
            let instance_id = InstanceId::from_bytes(d.bytes_exact::<16>()?);
            let legacy_community_id = d.opt_bytes_exact::<16>()?;
            let bot_user_id = d.bytes_exact::<16>()?;
            let kind = d.uint()?;
            let policy_version = d.uint()?;
            let e2ee_version = d.uint()?;
            let media_version = d.uint()?;
            let installation_id = d.bytes_exact::<16>()?;
            let community_id = CommunityId::from_bytes(d.bytes_exact::<16>()?);
            let participant_user_id = d.bytes_exact::<16>()?;
            let participant_device_id = DeviceId::from_bytes(d.bytes_exact::<16>()?);
            Ok((
                version,
                instance_id,
                legacy_community_id,
                bot_user_id,
                kind,
                policy_version,
                e2ee_version,
                media_version,
                installation_id,
                community_id,
                participant_user_id,
                participant_device_id,
            ))
        })
        .map_err(|_| ProtocolError::Binding)
        .and_then(
            |(
                version,
                instance_id,
                legacy_community_id,
                bot_user_id,
                kind,
                policy_version,
                e2ee_version,
                media_version,
                installation_id,
                community_id,
                participant_user_id,
                participant_device_id,
            )| {
                let ids_nonzero = instance_id.as_bytes() != &[0; 16]
                    && bot_user_id != [0; 16]
                    && installation_id != [0; 16]
                    && community_id.as_bytes() != &[0; 16]
                    && participant_user_id != [0; 16]
                    && participant_device_id.as_bytes() != &[0; 16];
                if version != 2
                    || legacy_community_id.is_some()
                    || kind != u64::from(GroupKind::Interaction.as_u8())
                    || e2ee_version != 1
                    || media_version != 0
                    || !ids_nonzero
                {
                    return Err(ProtocolError::Binding);
                }
                Ok(Self {
                    instance_id,
                    bot_user_id,
                    installation_id,
                    community_id,
                    participant_user_id,
                    participant_device_id,
                    policy_version,
                    e2ee_version,
                    media_version,
                })
            },
        )
    }

    pub fn to_extension(&self) -> Extension {
        Extension::Unknown(DILLA_BINDING_ID, UnknownExtension(self.encode()))
    }

    /// Decode the typed v2 interaction binding carried by the authenticated GroupContext.
    pub fn from_group_context(ctx: &GroupContext) -> Result<Self, ProtocolError> {
        let raw = ctx
            .extensions()
            .unknown(DILLA_BINDING_ID)
            .ok_or(ProtocolError::Binding)?;
        Self::decode(&raw.0)
    }

    /// The v1 projection retained by native group bookkeeping. The v2 value remains the
    /// authority for the interaction participant and installation scope.
    pub(crate) fn group_binding(&self) -> DillaBinding {
        DillaBinding {
            v: 1,
            instance_id: self.instance_id,
            community_id: None,
            target_id: self.bot_user_id,
            kind: GroupKind::Interaction,
            policy_version: self.policy_version,
            e2ee_version: self.e2ee_version,
            media_version: self.media_version,
        }
    }

    pub fn from_extensions<T>(exts: &Extensions<T>) -> Result<Self, ProtocolError> {
        let raw = exts
            .unknown(DILLA_BINDING_ID)
            .ok_or(ProtocolError::Binding)?;
        Self::decode(&raw.0)
    }
}

/// The instance external sender's basic-credential identity: CBOR `[1, "instance", instance_id]`.
pub fn instance_credential_identity(instance_id: &InstanceId) -> Vec<u8> {
    let mut e = Encoder::with_capacity(32);
    e.array(3)
        .uint(1)
        .text("instance")
        .bytes(instance_id.as_bytes());
    e.into_vec()
}

pub fn instance_credential(instance_id: &InstanceId) -> Credential {
    BasicCredential::new(instance_credential_identity(instance_id)).into()
}

pub fn external_senders(
    instance_key: SignaturePublicKey,
    instance_id: &InstanceId,
) -> ExternalSendersExtension {
    vec![ExternalSender::new(
        instance_key,
        instance_credential(instance_id),
    )]
}

/// The instance is always at position 0 and is never reordered (gap-5 section 2.3).
pub fn instance_sender_index() -> SenderExtensionIndex {
    SenderExtensionIndex::new(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{ChannelId, CommunityId, DeviceId, InstanceId};
    use tls_codec::Serialize as _;

    fn binding() -> DillaBinding {
        DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            community_id: Some(CommunityId::from_bytes([0x22; 16])),
            target_id: *ChannelId::from_bytes([0x33; 16]).as_bytes(),
            kind: GroupKind::Text,
            policy_version: 7,
            e2ee_version: 1,
            media_version: 0,
        }
    }

    #[test]
    fn binding_encodes_an_eight_element_array_and_round_trips() {
        let b = binding();
        let bytes = b.encode();
        assert_eq!(bytes[0], 0x88, "an 8-element array head");
        assert_eq!(DillaBinding::decode(&bytes).unwrap(), b);

        let mut dm = b.clone();
        dm.community_id = None;
        assert_eq!(DillaBinding::decode(&dm.encode()).unwrap(), dm);
    }

    #[test]
    fn binding_decode_rejects_trailing_bytes() {
        // OpenMLS does not validate unknown-extension payloads (gap-4 section 3), so an attacker
        // can append padding unless dilla rejects it here.
        let mut bytes = binding().encode();
        bytes.push(0x00);
        assert_eq!(DillaBinding::decode(&bytes), Err(ProtocolError::Binding));
        assert_eq!(DillaBinding::decode(&[]), Err(ProtocolError::Binding));
    }

    fn interaction_v2() -> DillaInteractionBinding {
        DillaInteractionBinding {
            instance_id: InstanceId::from_bytes([0x11; 16]),
            bot_user_id: [0x22; 16],
            installation_id: [0x33; 16],
            community_id: CommunityId::from_bytes([0x44; 16]),
            participant_user_id: [0x55; 16],
            participant_device_id: DeviceId::from_bytes([0x66; 16]),
            policy_version: 9,
            e2ee_version: 1,
            media_version: 0,
        }
    }

    #[test]
    fn interaction_v2_binding_round_trips_and_keeps_legacy_community_null() {
        let b = interaction_v2();
        let bytes = b.encode();
        assert_eq!(bytes[0], 0x8c, "a 12-element array head");
        assert_eq!(DillaInteractionBinding::decode(&bytes).unwrap(), b);
        assert_eq!(
            DillaInteractionBinding::decode(&bytes)
                .unwrap()
                .matches_admission(&b),
            Ok(())
        );

        // The earlier in-development 11-field v2 shape did not bind a device. It must not be
        // accepted as an authenticated participant-device binding.
        let mut missing_device = crate::cbor::Encoder::new();
        missing_device
            .array(11)
            .uint(2)
            .bytes(b.instance_id.as_bytes())
            .null()
            .bytes(&b.bot_user_id)
            .uint(3)
            .uint(b.policy_version)
            .uint(1)
            .uint(0)
            .bytes(&b.installation_id)
            .bytes(b.community_id.as_bytes())
            .bytes(&b.participant_user_id);
        assert_eq!(
            DillaInteractionBinding::decode(&missing_device.into_vec()),
            Err(ProtocolError::Binding)
        );

        // Legacy kind-3 bindings remain readable for existing human interaction groups. Bot
        // admission must separately require the typed v2 contract.
        let legacy = DillaBinding {
            v: 1,
            instance_id: b.instance_id,
            community_id: None,
            target_id: b.bot_user_id,
            kind: GroupKind::Interaction,
            policy_version: b.policy_version,
            e2ee_version: 1,
            media_version: 0,
        };
        assert_eq!(DillaBinding::decode(&legacy.encode()).unwrap(), legacy);
        assert_eq!(
            DillaInteractionBinding::decode(&legacy.encode()),
            Err(ProtocolError::Binding)
        );
    }

    #[test]
    fn interaction_v2_admission_comparison_fails_closed_on_every_tuple_field() {
        let actual = interaction_v2();
        for mutate in [
            |x: &mut DillaInteractionBinding| x.instance_id = InstanceId::from_bytes([0x91; 16]),
            |x: &mut DillaInteractionBinding| x.bot_user_id = [0x92; 16],
            |x: &mut DillaInteractionBinding| x.installation_id = [0x93; 16],
            |x: &mut DillaInteractionBinding| x.community_id = CommunityId::from_bytes([0x94; 16]),
            |x: &mut DillaInteractionBinding| x.participant_user_id = [0x95; 16],
            |x: &mut DillaInteractionBinding| {
                x.participant_device_id = DeviceId::from_bytes([0x96; 16])
            },
            |x: &mut DillaInteractionBinding| x.policy_version += 1,
            |x: &mut DillaInteractionBinding| x.e2ee_version += 1,
            |x: &mut DillaInteractionBinding| x.media_version += 1,
        ] {
            let mut expected = actual.clone();
            mutate(&mut expected);
            assert_eq!(
                actual.matches_admission(&expected),
                Err(ProtocolError::Binding)
            );
        }
    }

    #[test]
    fn interaction_v2_recipient_check_requires_the_local_instance_user_and_device() {
        let binding = interaction_v2();
        assert_eq!(
            binding.matches_recipient(
                &binding.instance_id,
                &binding.participant_user_id,
                &binding.participant_device_id,
            ),
            Ok(())
        );
        assert_eq!(
            binding.matches_recipient(
                &InstanceId::from_bytes([0x91; 16]),
                &binding.participant_user_id,
                &binding.participant_device_id,
            ),
            Err(ProtocolError::Binding)
        );
        assert_eq!(
            binding.matches_recipient(
                &binding.instance_id,
                &[0x92; 16],
                &binding.participant_device_id,
            ),
            Err(ProtocolError::Binding)
        );
        assert_eq!(
            binding.matches_recipient(
                &binding.instance_id,
                &binding.participant_user_id,
                &DeviceId::from_bytes([0x93; 16]),
            ),
            Err(ProtocolError::Binding)
        );
    }

    #[test]
    fn interaction_v2_binding_rejects_scope_kind_version_and_identity_mismatches() {
        let b = interaction_v2();
        let valid = b.encode();
        assert_eq!(
            DillaInteractionBinding::decode(&[]),
            Err(ProtocolError::Binding)
        );
        let mut trailing = valid.clone();
        trailing.push(0x00);
        assert_eq!(
            DillaInteractionBinding::decode(&trailing),
            Err(ProtocolError::Binding)
        );

        for mutate in [
            |x: &mut DillaInteractionBinding| x.instance_id = InstanceId::from_bytes([0; 16]),
            |x: &mut DillaInteractionBinding| x.bot_user_id = [0; 16],
            |x: &mut DillaInteractionBinding| x.installation_id = [0; 16],
            |x: &mut DillaInteractionBinding| x.community_id = CommunityId::from_bytes([0; 16]),
            |x: &mut DillaInteractionBinding| x.participant_user_id = [0; 16],
            |x: &mut DillaInteractionBinding| {
                x.participant_device_id = DeviceId::from_bytes([0; 16])
            },
            |x: &mut DillaInteractionBinding| x.e2ee_version = 2,
            |x: &mut DillaInteractionBinding| x.media_version = 1,
        ] {
            let mut invalid = b.clone();
            mutate(&mut invalid);
            assert_eq!(
                DillaInteractionBinding::decode(&invalid.encode()),
                Err(ProtocolError::Binding)
            );
        }

        // In this canonical fixed-width layout, byte 1 is the version and byte 37 is kind.
        let mut wrong_version = valid.clone();
        wrong_version[1] = 1;
        assert_eq!(
            DillaInteractionBinding::decode(&wrong_version),
            Err(ProtocolError::Binding)
        );
        let mut wrong_kind = valid.clone();
        wrong_kind[37] = 2;
        assert_eq!(
            DillaInteractionBinding::decode(&wrong_kind),
            Err(ProtocolError::Binding)
        );

        // The original community slot must stay null; the installation community is appended.
        let mut wrong_slot = crate::cbor::Encoder::new();
        wrong_slot
            .array(12)
            .uint(2)
            .bytes(b.instance_id.as_bytes())
            .bytes(b.community_id.as_bytes())
            .bytes(&b.bot_user_id)
            .uint(3)
            .uint(b.policy_version)
            .uint(1)
            .uint(0)
            .bytes(&b.installation_id)
            .bytes(b.community_id.as_bytes())
            .bytes(&b.participant_user_id)
            .bytes(b.participant_device_id.as_bytes());
        assert_eq!(
            DillaInteractionBinding::decode(&wrong_slot.into_vec()),
            Err(ProtocolError::Binding)
        );
    }

    #[test]
    fn matches_compares_every_immutable_field() {
        let b = binding();
        assert_eq!(b.matches(&b), Ok(()));
        for mutate in [
            |x: &mut DillaBinding| x.instance_id = InstanceId::from_bytes([0x99; 16]),
            |x: &mut DillaBinding| x.community_id = None,
            |x: &mut DillaBinding| x.target_id = [0x99; 16],
            |x: &mut DillaBinding| x.kind = GroupKind::Call,
            |x: &mut DillaBinding| x.e2ee_version = 2,
            |x: &mut DillaBinding| x.media_version = 1,
        ] {
            let mut other = b.clone();
            mutate(&mut other);
            assert_eq!(b.matches(&other), Err(ProtocolError::Binding));
        }
        // policy_version is a snapshot, not an identity field
        let mut later = b.clone();
        later.policy_version = 99;
        assert_eq!(b.matches(&later), Ok(()));
    }

    /// `Extension`'s TLS codec is hand-written and emits `F0 01 || varint len || payload`.
    /// `UnknownExtension`'s own derived codec adds a second length prefix; never use it for wire
    /// bytes (gap-4 section 3).
    #[test]
    fn the_extension_serialises_without_a_second_length_prefix() {
        let ext = Extension::Unknown(DILLA_BINDING_ID, UnknownExtension(vec![1, 2, 3]));
        assert_eq!(
            ext.tls_serialize_detached().unwrap(),
            vec![0xf0, 0x01, 0x03, 0x01, 0x02, 0x03]
        );
    }

    #[test]
    fn group_kinds_carry_their_external_sender_and_media_rules() {
        assert!(GroupKind::Text.has_external_sender());
        assert!(GroupKind::Call.has_external_sender());
        assert!(!GroupKind::Pairing.has_external_sender());
        assert!(!GroupKind::Interaction.has_external_sender());
        assert_eq!(GroupKind::Call.media_version(), 1);
        for k in [GroupKind::Text, GroupKind::Pairing, GroupKind::Interaction] {
            assert_eq!(k.media_version(), 0);
        }
        assert_eq!(GroupKind::from_u64(4), Err(ProtocolError::Binding));
    }

    #[test]
    fn the_instance_credential_identity_is_the_three_element_array() {
        let id = InstanceId::from_bytes([0x11; 16]);
        let bytes = instance_credential_identity(&id);
        let mut want = crate::cbor::Encoder::new();
        want.array(3).uint(1).text("instance").bytes(id.as_bytes());
        assert_eq!(bytes, want.into_vec());
    }
}
