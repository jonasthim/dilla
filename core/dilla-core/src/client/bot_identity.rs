//! Installation-bound native bot bootstrap. Human signup remains its own fixed User/Browser path.

use super::error::{E_CORE_INPUT, E_CORE_STATE, E_CORE_STORAGE};
use super::identity::{
    self, AAD_STATE, IdentityRecord, Phase, load_phase, random, seal, state_list,
};
use super::{ClientCore, ClientError, schema, wire};
use crate::cbor::{Encoder, decode_strict};
use crate::identity::{
    CredentialIdentity, DeviceEntry, DeviceList, DeviceListUnsigned, Kind, SignerTier, SskSigner,
    Tier, UmkSigner,
};
use crate::ids::{DeviceId, UserId};
use crate::mls::{CIPHERSUITE, DillaGroup, GroupKind};
use openmls::prelude::{BasicCredential, GroupId};
use openmls_basic_credential::SignatureKeyPair;
use rusqlite::OptionalExtension;
use zeroize::Zeroizing;

const MAX_BOT_INTERACTION_GROUP_DESCRIPTORS: usize = 2048;

#[derive(Clone, Copy)]
pub(super) struct BotBinding {
    pub instance_id: [u8; 16],
    pub community_id: [u8; 16],
    pub installation_id: [u8; 16],
}

pub(super) struct PendingBot {
    pub binding: BotBinding,
    device_id: [u8; 16],
    dsk_pub: [u8; 32],
    umk_pub: [u8; 32],
    ssk_pub: [u8; 32],
    sig_umk_ssk: [u8; 64],
    sig_ssk_dev: [u8; 64],
    ssk_priv: Zeroizing<[u8; 32]>,
    k_backup: Zeroizing<[u8; 32]>,
}

/// Locally persisted kind-3 interaction group and its authenticated MLS context binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BotInteractionGroupDescriptor {
    pub group: [u8; 16],
    pub instance: [u8; 16],
    pub installation: [u8; 16],
    pub community: [u8; 16],
    pub bot_user: [u8; 16],
    pub bot_device: [u8; 16],
    pub participant_user: [u8; 16],
    pub participant_device: [u8; 16],
    pub policy_version: u64,
    pub e2ee_version: u64,
    pub media_version: u64,
    pub epoch: u64,
    pub state: u64,
}
impl core::fmt::Debug for PendingBot {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("PendingBot { binding, device_id, public_keys, signatures, secret_keys } ")
    }
}
impl PendingBot {
    fn encode(&self) -> Zeroizing<Vec<u8>> {
        let mut e = Encoder::new();
        e.array(12)
            .uint(1)
            .bytes(&self.binding.instance_id)
            .bytes(&self.binding.community_id)
            .bytes(&self.binding.installation_id)
            .bytes(&self.device_id)
            .bytes(&self.dsk_pub)
            .bytes(&self.umk_pub)
            .bytes(&self.ssk_pub)
            .bytes(&self.sig_umk_ssk)
            .bytes(&self.sig_ssk_dev)
            .bytes(&*self.ssk_priv)
            .bytes(&*self.k_backup);
        Zeroizing::new(e.into_vec())
    }

    fn decode(bytes: &[u8]) -> Result<Self, ClientError> {
        let record = decode_strict(bytes, |d| {
            d.array(12)?;
            if d.uint()? != 1 {
                return Err(shape());
            }
            Ok(Self {
                binding: BotBinding {
                    instance_id: d.bytes_exact()?,
                    community_id: d.bytes_exact()?,
                    installation_id: d.bytes_exact()?,
                },
                device_id: d.bytes_exact()?,
                dsk_pub: d.bytes_exact()?,
                umk_pub: d.bytes_exact()?,
                ssk_pub: d.bytes_exact()?,
                sig_umk_ssk: d.bytes_exact()?,
                sig_ssk_dev: d.bytes_exact()?,
                ssk_priv: Zeroizing::new(d.bytes_exact()?),
                k_backup: Zeroizing::new(d.bytes_exact()?),
            })
        })
        .map_err(|_| malformed(schema::BOT_PENDING))?;
        record.validate()?;
        Ok(record)
    }

    fn validate(&self) -> Result<(), ClientError> {
        let invalid = || ClientError::new(E_CORE_STATE, "pending bot identity does not verify");
        if !nonzero_ids(&self.binding) || self.device_id == [0; 16] {
            return Err(invalid());
        }
        if SskSigner::from_bytes(&self.ssk_priv).public() != self.ssk_pub {
            return Err(invalid());
        }
        self.placeholder_credential()
            .verify_signatures(&self.dsk_pub)
            .map_err(|_| invalid())
    }

    fn placeholder_credential(&self) -> CredentialIdentity {
        CredentialIdentity {
            v: 1,
            umk_pub: self.umk_pub,
            user_id: UserId::from_bytes([0; 16]),
            device_id: DeviceId::from_bytes(self.device_id),
            kind: Kind::Bot,
            tier: Tier::Native,
            signer_tier: SignerTier::Native,
            ssk_pub: self.ssk_pub,
            sig_umk_ssk: self.sig_umk_ssk,
            sig_ssk_dev: self.sig_ssk_dev,
        }
    }

    fn registration(&self) -> Vec<u8> {
        let mut device = Encoder::new();
        device
            .array(5)
            .bytes(&self.device_id)
            .bytes(&self.dsk_pub)
            .uint(u64::from(Tier::Native.as_u8()))
            .uint(u64::from(SignerTier::Native.as_u8()))
            .bytes(&self.placeholder_credential().encode());
        let mut e = Encoder::new();
        e.array(4)
            .bytes(&self.umk_pub)
            .bytes(&self.ssk_pub)
            .bytes(&self.sig_umk_ssk)
            .raw(&device.into_vec());
        e.into_vec()
    }
}

fn shape() -> crate::cbor::CborError {
    crate::cbor::CborError::TypeMismatch {
        expected: "bot record",
        offset: 0,
    }
}
fn malformed(key: &str) -> ClientError {
    ClientError::new(E_CORE_STORAGE, format!("app_meta {key} is malformed"))
}
fn binding_mismatch() -> ClientError {
    ClientError::new(E_CORE_STATE, "bot installation binding does not match")
}
pub(super) fn nonzero_ids(binding: &BotBinding) -> bool {
    binding.instance_id != [0; 16]
        && binding.community_id != [0; 16]
        && binding.installation_id != [0; 16]
}

pub(super) fn validate_open(
    provider: &crate::mls::DillaProvider,
    phase: &Phase,
) -> Result<Option<[u8; 32]>, ClientError> {
    let (pending, binding) = provider
        .storage()
        .read(|c| {
            Ok((
                schema::meta_get(c, schema::BOT_PENDING)?,
                schema::meta_get(c, schema::BOT_BINDING)?,
            ))
        })
        .map_err(ClientError::from)?;
    let conflict = || ClientError::new(E_CORE_STATE, "identity phase metadata conflicts");
    match phase {
        Phase::None => match (pending, binding) {
            (Some(bytes), None) => {
                let rec = PendingBot::decode(&bytes)?;
                if !nonzero_ids(&rec.binding) {
                    return Err(malformed(schema::BOT_PENDING));
                }
                Ok(Some(rec.dsk_pub))
            }
            (None, None) => Ok(None),
            _ => Err(conflict()),
        },
        Phase::Pending(_) | Phase::Enrolling(_) => {
            if pending.is_some() || binding.is_some() {
                Err(conflict())
            } else {
                Ok(None)
            }
        }
        Phase::Ready(rec) => {
            if pending.is_some() {
                return Err(conflict());
            }
            let credential = CredentialIdentity::decode(&rec.credential)
                .map_err(|_| malformed(schema::IDENTITY))?;
            match (credential.kind, binding) {
                (Kind::Bot, Some(bytes)) => {
                    let binding = decode_binding(&bytes)?;
                    if !nonzero_ids(&binding) || binding.instance_id != rec.instance_id {
                        return Err(malformed(schema::BOT_BINDING));
                    }
                    validate_ready(rec)?;
                    Ok(None)
                }
                (Kind::Bot, None) | (Kind::User, Some(_)) => Err(conflict()),
                (Kind::User, None) => Ok(None),
            }
        }
    }
}

pub(super) fn decode_binding(bytes: &[u8]) -> Result<BotBinding, ClientError> {
    decode_strict(bytes, |d| {
        d.array(4)?;
        if d.uint()? != 1 {
            return Err(shape());
        }
        Ok(BotBinding {
            instance_id: d.bytes_exact()?,
            community_id: d.bytes_exact()?,
            installation_id: d.bytes_exact()?,
        })
    })
    .map_err(|_| malformed(schema::BOT_BINDING))
}

fn encode_binding(binding: &BotBinding) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(4)
        .uint(1)
        .bytes(&binding.instance_id)
        .bytes(&binding.community_id)
        .bytes(&binding.installation_id);
    e.into_vec()
}

fn identity_registration(rec: &IdentityRecord) -> Result<Vec<u8>, ClientError> {
    let cred =
        CredentialIdentity::decode(&rec.credential).map_err(|_| malformed(schema::IDENTITY))?;
    validate_bot_credential(&cred, &rec.dsk_pub, &rec.ssk_pub)?;
    let mut placeholder = cred;
    placeholder.user_id = UserId::from_bytes([0; 16]);
    let mut device = Encoder::new();
    device
        .array(5)
        .bytes(&rec.device_id)
        .bytes(&rec.dsk_pub)
        .uint(u64::from(Tier::Native.as_u8()))
        .uint(u64::from(SignerTier::Native.as_u8()))
        .bytes(&placeholder.encode());
    let mut e = Encoder::new();
    e.array(4)
        .bytes(&rec.umk_pub)
        .bytes(&rec.ssk_pub)
        .bytes(&placeholder.sig_umk_ssk)
        .raw(&device.into_vec());
    Ok(e.into_vec())
}

fn validate_bot_credential(
    credential: &CredentialIdentity,
    dsk_pub: &[u8; 32],
    ssk_pub: &[u8; 32],
) -> Result<(), ClientError> {
    if credential.kind != Kind::Bot
        || credential.tier != Tier::Native
        || credential.signer_tier != SignerTier::Native
        || &credential.ssk_pub != ssk_pub
    {
        return Err(ClientError::new(
            E_CORE_STATE,
            "identity is not a native bot",
        ));
    }
    credential.verify_signatures(dsk_pub)?;
    Ok(())
}

pub(super) fn validate_ready(rec: &IdentityRecord) -> Result<DeviceList, ClientError> {
    let credential =
        CredentialIdentity::decode(&rec.credential).map_err(|_| malformed(schema::IDENTITY))?;
    validate_bot_credential(&credential, &rec.dsk_pub, &rec.ssk_pub)?;
    if credential.umk_pub != rec.umk_pub
        || credential.user_id.as_bytes() != &rec.user_id
        || credential.device_id.as_bytes() != &rec.device_id
    {
        return Err(malformed(schema::IDENTITY));
    }
    let body = wire::decode_device_list_body(&rec.device_list_body)
        .map_err(|_| malformed(schema::IDENTITY))?;
    let list = DeviceList::decode(&body.blob).map_err(|_| malformed(schema::IDENTITY))?;
    list.verify(&rec.ssk_pub)?;
    if body.version != list.unsigned.version
        || body.ssk_signature != list.sig_ssk
        || body.prev_hash != list.unsigned.prev_hash
        || rec.device_list != list.encode()
        || list.unsigned.user_id.as_bytes() != &rec.user_id
        || list.unsigned.entries.len() != 1
        || list.unsigned.entries[0].device_id.as_bytes() != &rec.device_id
        || list.unsigned.entries[0].dsk_pub != rec.dsk_pub
        || list.unsigned.entries[0].tier != Tier::Native
        || list.unsigned.entries[0].revoked_at.is_some()
    {
        return Err(malformed(schema::IDENTITY));
    }
    Ok(list)
}

impl ClientCore {
    /// Discover locally persisted kind-3 groups and read their authenticated context binding.
    /// Generic group enumeration remains deliberately unaware of kind-3 groups.
    pub fn bot_interaction_group_descriptors(
        &self,
        expected_instance: &[u8; 16],
        expected_community: &[u8; 16],
        expected_installation: &[u8; 16],
    ) -> Result<Vec<BotInteractionGroupDescriptor>, ClientError> {
        let own = self.own()?;
        if &own.instance_id != expected_instance {
            return Err(binding_mismatch());
        }
        // Bound candidate work in SQLite before loading OpenMLS state. The extra row is a
        // sentinel: discovery fails closed if the complete result would exceed the wire cap.
        let candidates = self.read(|c| {
            let mut stmt = c.prepare(
                "SELECT group_id,target_id,state,epoch FROM app_groups \
                 WHERE kind=3 AND community_id=?1 AND state<4 ORDER BY group_id LIMIT 2049",
            )?;
            let rows = stmt.query_map([expected_community.as_slice()], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })?;
        if candidates.len() > MAX_BOT_INTERACTION_GROUP_DESCRIPTORS {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "interaction group discovery exceeds native descriptor limit",
            ));
        }
        let mut out = Vec::new();
        for (group_id, target, state, epoch) in candidates {
            let group_id: [u8; 16] = group_id.try_into().map_err(|_| {
                ClientError::new(E_CORE_STORAGE, "interaction group identifier rejected")
            })?;
            let target: [u8; 16] = target.try_into().map_err(|_| {
                ClientError::new(E_CORE_STORAGE, "interaction group target rejected")
            })?;
            let state = u64::try_from(state).map_err(|_| {
                ClientError::new(E_CORE_STORAGE, "interaction group state rejected")
            })?;
            let epoch = u64::try_from(epoch).map_err(|_| {
                ClientError::new(E_CORE_STORAGE, "interaction group epoch rejected")
            })?;
            let group = DillaGroup::load(&self.provider, &GroupId::from_slice(&group_id))
                .map_err(|_| {
                    ClientError::new(E_CORE_STATE, "interaction group could not be loaded")
                })?
                .ok_or_else(|| {
                    ClientError::new(E_CORE_STATE, "interaction group is unavailable")
                })?;
            let binding = group.interaction_binding().map_err(|_| {
                ClientError::new(E_CORE_INPUT, "interaction group binding rejected")
            })?;
            if group.kind() != GroupKind::Interaction
                || target != own.user_id
                || binding.instance_id.as_bytes() != expected_instance
                || binding.community_id.as_bytes() != expected_community
                || binding.installation_id != *expected_installation
                || binding.bot_user_id != own.user_id
            {
                return Err(binding_mismatch());
            }
            out.push(BotInteractionGroupDescriptor {
                group: group_id,
                instance: *binding.instance_id.as_bytes(),
                installation: binding.installation_id,
                community: *binding.community_id.as_bytes(),
                bot_user: binding.bot_user_id,
                bot_device: own.device_id,
                participant_user: binding.participant_user_id,
                participant_device: *binding.participant_device_id.as_bytes(),
                policy_version: binding.policy_version,
                e2ee_version: binding.e2ee_version,
                media_version: binding.media_version,
                epoch,
                state,
            });
        }
        out.sort_by_key(|v| v.group);
        Ok(out)
    }

    /// Inspect an already-persisted interaction group using OpenMLS's authenticated GroupContext
    /// and member view, then bind that evidence to a verified signed snapshot. This is read-only
    /// and diagnostic: it creates no group, intent, or Welcome state and does not authorize
    /// creation. It cannot inspect transaction-local state before persistence, and never treats a
    /// caller-provided roster as authority.
    pub fn bot_inspect_stored_interaction_group(
        &self,
        group_id: &[u8; 16],
        snapshot_wire: &[u8],
        expected: &crate::bot::interaction_admission::Expected,
    ) -> Result<crate::bot::interaction_admission::Admission, ClientError> {
        if group_id != expected.group.as_bytes() {
            return Err(binding_mismatch());
        }
        let snapshot = self.bot_verify_interaction_snapshot(snapshot_wire, expected)?;
        let group = DillaGroup::load(&self.provider, &GroupId::from_slice(group_id))
            .map_err(|_| ClientError::new(E_CORE_STATE, "candidate MLS group could not be loaded"))?
            .ok_or_else(|| ClientError::new(E_CORE_STATE, "candidate MLS group is unavailable"))?;
        let own = self.own()?;
        let admission = verify_interaction_group_snapshot(
            &group,
            &snapshot,
            expected,
            &own.user_id,
            &own.device_id,
        )?;
        let row = self.read(|c| super::groups::group_row(c, group_id))?;
        let Some(row) = row else {
            return Err(ClientError::new(
                E_CORE_STATE,
                "stored interaction group row is unavailable",
            ));
        };
        if row.kind != GroupKind::Interaction.as_u8() as i64
            || row.state < super::groups::STATE_REGISTERING
            || row.state >= super::groups::STATE_GONE
            || row.community_id.as_deref() != Some(expected.community.as_bytes().as_slice())
            || row.target_id.as_slice() != admission.participant_user.as_bytes()
        {
            return Err(binding_mismatch());
        }
        // Expected.server_now is merely bound to the signed snapshot; it is caller supplied.
        // Recheck against the shared host clock immediately before returning authenticated
        // inspection evidence so an old or future signed snapshot cannot be replayed.
        let local_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| {
                ClientError::new(E_CORE_INPUT, "interaction snapshot clock is unavailable")
            })?
            .as_secs();
        if !super::bot_interaction_create::snapshot_is_fresh(
            snapshot.now,
            snapshot.not_after,
            local_now,
        ) {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "interaction snapshot is stale or from the future",
            ));
        }
        Ok(admission)
    }

    /// Verify an already-authenticated snapshot against an OpenMLS group object. Creation code
    /// may call this inside its outer storage transaction before writing app rows or intents.
    /// `snapshot` must come from `bot_verify_interaction_snapshot`; this helper derives all member
    /// evidence from the group and accepts no caller roster.
    fn bot_verify_interaction_group(
        group: &DillaGroup,
        snapshot: &crate::bot::interaction_snapshot::Snapshot,
        expected: &crate::bot::interaction_admission::Expected,
        bot_user_id: &[u8; 16],
        bot_device_id: &[u8; 16],
    ) -> Result<crate::bot::interaction_admission::Admission, ClientError> {
        if group.group_id().as_slice() != expected.group.as_bytes()
            || bot_user_id.as_slice() != expected.bot_user.as_bytes()
            || bot_device_id.as_slice() != expected.bot_device.as_bytes()
        {
            return Err(binding_mismatch());
        }
        if group.kind() != GroupKind::Interaction || group.member_count() != 2 {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "candidate interaction group must have exactly two members",
            ));
        }
        let interaction_binding = group.interaction_binding().map_err(|_| {
            ClientError::new(E_CORE_INPUT, "candidate interaction binding rejected")
        })?;
        let bot_list = DeviceList::decode(&snapshot.bot.blob)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "snapshot Bot device list rejected"))?;
        let participant_list = DeviceList::decode(&snapshot.participant.blob).map_err(|_| {
            ClientError::new(E_CORE_INPUT, "snapshot participant device list rejected")
        })?;

        let own_leaf = group.own_leaf_index().u32();
        let mut leaves = Vec::with_capacity(2);
        for member in group.members() {
            let basic = BasicCredential::try_from(member.credential).map_err(|_| {
                ClientError::new(E_CORE_INPUT, "candidate member credential rejected")
            })?;
            let credential = CredentialIdentity::decode(basic.identity()).map_err(|_| {
                ClientError::new(E_CORE_INPUT, "candidate member credential rejected")
            })?;
            let dsk: [u8; 32] = member.signature_key.as_slice().try_into().map_err(|_| {
                ClientError::new(E_CORE_INPUT, "candidate member signature key rejected")
            })?;
            credential.verify_signatures(&dsk).map_err(|_| {
                ClientError::new(E_CORE_INPUT, "candidate member credential rejected")
            })?;
            if member.index.u32() == own_leaf
                && (credential.user_id.as_bytes().as_slice() != bot_user_id.as_slice()
                    || credential.device_id.as_bytes().as_slice() != bot_device_id.as_slice())
            {
                return Err(ClientError::new(
                    E_CORE_INPUT,
                    "candidate own leaf does not match the enrolled Bot",
                ));
            }
            if (credential.user_id.as_bytes() == expected.bot_user.as_bytes()
                && (credential.kind != Kind::Bot
                    || credential.tier != Tier::Native
                    || credential.signer_tier != SignerTier::Native))
                || (credential.user_id.as_bytes() == expected.participant_user.as_bytes()
                    && credential.kind != Kind::User)
            {
                return Err(ClientError::new(
                    E_CORE_INPUT,
                    "candidate member identity rejected",
                ));
            }
            leaves.push(crate::bot::interaction_admission::AuthenticatedRosterLeaf {
                user: credential.user_id,
                device: credential.device_id,
                dsk_pub: dsk,
                tier: credential.tier,
            });
        }
        let mut proof = Encoder::new();
        proof
            .array(2)
            .bytes(&snapshot.admission_payload)
            .bytes(&snapshot.admission_signature);
        crate::bot::interaction_admission::prepare_creation(
            &proof.into_vec(),
            &snapshot.instance_signer,
            expected,
            &interaction_binding,
            &leaves,
            &bot_list,
            &snapshot.bot.ssk,
            &participant_list,
            &snapshot.participant.ssk,
        )
        .map_err(|_| ClientError::new(E_CORE_INPUT, "candidate interaction admission rejected"))
    }

    /// Validate that this open client is the fully enrolled native Bot bound to the helper's
    /// installation tuple. The tuple is public scope metadata; no signing or recovery material is
    /// exposed by this check.
    pub fn bot_validate_binding(
        &self,
        instance_id: &[u8; 16],
        community_id: &[u8; 16],
        installation_id: &[u8; 16],
    ) -> Result<(), ClientError> {
        let own = self.own()?;
        if own.kind != Kind::Bot.as_u8() || own.tier != Tier::Native.as_u8() {
            return Err(binding_mismatch());
        }
        let raw = self.read(|c| schema::meta_get(c, schema::BOT_BINDING))?;
        let Some(raw) = raw else {
            return Err(binding_mismatch());
        };
        let binding = decode_binding(&raw)?;
        if !nonzero_ids(&binding)
            || binding.instance_id != *instance_id
            || binding.community_id != *community_id
            || binding.installation_id != *installation_id
            || own.instance_id != *instance_id
        {
            return Err(binding_mismatch());
        }
        Ok(())
    }

    /// Check the external-sender key pinned during the native bootstrap. The
    /// key itself is never returned to callers; this is a continuity check for
    /// the Go lifecycle after its authenticated `/v1/instance` discovery.
    pub fn bot_instance_key_matches(&self, observed_key: &[u8; 32]) -> Result<(), ClientError> {
        if observed_key.iter().all(|byte| *byte == 0) {
            return Err(ClientError::new(E_CORE_INPUT, "instance key is all zero"));
        }
        let pinned = self.read(|c| schema::meta_get(c, schema::BOT_INSTANCE_KEY))?;
        if pinned.as_deref() != Some(observed_key.as_slice()) {
            return Err(ClientError::new(
                E_CORE_STATE,
                "instance external-sender key changed or is not pinned",
            ));
        }
        Ok(())
    }

    /// Verify a signed interaction context against the instance key and existing user-key/list
    /// trust state persisted in this Bot store. This is read-only preparation evidence; it does
    /// not authenticate a candidate MLS roster and cannot authorize group creation.
    pub fn bot_verify_interaction_snapshot(
        &self,
        wire: &[u8],
        expected: &crate::bot::interaction_admission::Expected,
    ) -> Result<crate::bot::interaction_snapshot::Snapshot, ClientError> {
        let own = self.own()?;
        if own.kind != Kind::Bot.as_u8()
            || own.tier != Tier::Native.as_u8()
            || expected.instance.0 != own.instance_id
            || expected.bot_user.0 != own.user_id
            || expected.bot_device.0 != own.device_id
        {
            return Err(binding_mismatch());
        }
        let binding_raw = self.read(|c| schema::meta_get(c, schema::BOT_BINDING))?;
        let stored = decode_binding(&binding_raw.ok_or_else(binding_mismatch)?)?;
        if expected.community.0 != stored.community_id
            || expected.installation.0 != stored.installation_id
        {
            return Err(binding_mismatch());
        }
        let pinned = self
            .read(|c| schema::meta_get(c, schema::BOT_INSTANCE_KEY))?
            .ok_or_else(|| ClientError::new(E_CORE_STATE, "Bot instance key is not pinned"))?;
        let pinned: [u8; 32] = pinned
            .try_into()
            .map_err(|_| ClientError::new(E_CORE_STORAGE, "malformed pinned instance key"))?;
        let snapshot = crate::bot::interaction_snapshot::verify(wire, &pinned, expected)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "interaction context snapshot rejected"))?;
        for list in [&snapshot.bot, &snapshot.participant] {
            let user = list.user.as_bytes();
            let pin: Option<(Vec<u8>, i64, Option<Vec<u8>>)> = self.read(|c| {
                Ok(c.query_row(
                    "SELECT umk_pub,verified,changed_umk FROM app_trust_pins WHERE user_id=?1",
                    [user.as_slice()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?)
            })?;
            let Some((umk, verified, changed)) = pin else {
                return Err(ClientError::new(
                    E_CORE_STATE,
                    "interaction user-key pin is unavailable",
                ));
            };
            let cached: Option<(i64, Vec<u8>, Vec<u8>, Vec<u8>)> = if list.user.as_bytes()
                == &own.user_id
            {
                let raw = self
                    .read(|c| schema::meta_get(c, schema::IDENTITY))?
                    .ok_or_else(|| {
                        ClientError::new(E_CORE_STATE, "Bot identity record is unavailable")
                    })?;
                let record = identity::IdentityRecord::decode(&raw)?;
                let current = DeviceList::decode(&record.device_list)
                    .map_err(|_| malformed(schema::IDENTITY))?;
                if record.instance_id != own.instance_id || record.user_id != own.user_id {
                    return Err(binding_mismatch());
                }
                Some((
                    current.unsigned.version as i64,
                    record.device_list,
                    record.umk_pub.to_vec(),
                    record.ssk_pub.to_vec(),
                ))
            } else {
                self.read(|c| {
                        Ok(c.query_row(
                            "SELECT version,list,umk_pub,ssk_pub FROM app_device_lists WHERE user_id=?1",
                            [user.as_slice()],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                        )
                        .optional()?)
                    })?
            };
            let Some((version, blob, cached_umk, cached_ssk)) = cached else {
                return Err(ClientError::new(
                    E_CORE_STATE,
                    "interaction device-list pin is unavailable",
                ));
            };
            // A first-seen participant pin is bounded TOFU: the signed snapshot below must
            // match its exact ingested list and unchanged UMK. The Bot's own pin stays verified.
            let is_bot = list.user.as_bytes() == &own.user_id;
            if (is_bot && verified != 1)
                || changed.is_some()
                || umk.as_slice() != list.umk
                || cached_umk.as_slice() != list.umk
                || cached_ssk.as_slice() != list.ssk
                || version < 0
                || version as u64 != list.version
                || blob != list.blob
            {
                return Err(ClientError::new(
                    E_CORE_INPUT,
                    "interaction device-list trust state changed",
                ));
            }
        }
        Ok(snapshot)
    }

    /// Start (or resume) the one native bot identity bound to an installation and community.
    /// The returned CBOR is the public `[umk_pub, ssk_pub, sig_umk_ssk, device]` registration tuple.
    pub fn bot_bootstrap_begin(
        &mut self,
        instance_id: &[u8; 16],
        community_id: &[u8; 16],
        installation_id: &[u8; 16],
        external_sender_key: &[u8; 32],
    ) -> Result<Vec<u8>, ClientError> {
        let binding = BotBinding {
            instance_id: *instance_id,
            community_id: *community_id,
            installation_id: *installation_id,
        };
        if !nonzero_ids(&binding) {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "bot binding ids must be nonzero",
            ));
        }
        if external_sender_key.iter().all(|byte| *byte == 0) {
            return Err(ClientError::new(E_CORE_INPUT, "instance key is all zero"));
        }

        let (body, new_signer) = self.write(|ctx, u| {
            let (identity_raw, signup, enrol) = u.with_conn(load_phase)?;
            let phase = identity::decode_phase(identity_raw, signup, enrol)?;
            let pin = u.with_conn(|c| schema::meta_get(c, schema::BOT_INSTANCE_KEY))?;
            match pin {
                Some(pinned) if pinned.as_slice() != external_sender_key => {
                    return Err(ClientError::new(
                        E_CORE_STATE,
                        "instance external-sender key changed",
                    ));
                }
                Some(_) => {}
                None if matches!(&phase, Phase::Ready(_)) => {
                    return Err(ClientError::new(
                        E_CORE_STATE,
                        "existing Bot has no pinned instance key; operator recovery required",
                    ));
                }
                None => {
                    u.with_conn(|c| {
                        schema::meta_put(c, schema::BOT_INSTANCE_KEY, external_sender_key)
                    })?;
                }
            }
            match phase {
                Phase::None => {
                    if let Some(raw) = u.with_conn(|c| schema::meta_get(c, schema::BOT_PENDING))? {
                        if u.with_conn(|c| schema::meta_get(c, schema::BOT_BINDING))?
                            .is_some()
                        {
                            return Err(ClientError::new(
                                E_CORE_STATE,
                                "bot identity metadata conflicts",
                            ));
                        }
                        let pending = PendingBot::decode(&raw)?;
                        if pending.binding.instance_id != binding.instance_id
                            || pending.binding.community_id != binding.community_id
                            || pending.binding.installation_id != binding.installation_id
                        {
                            return Err(binding_mismatch());
                        }
                        return Ok((pending.registration(), None));
                    }
                    if u.with_conn(|c| schema::meta_get(c, schema::BOT_BINDING))?
                        .is_some()
                    {
                        return Err(ClientError::new(
                            E_CORE_STATE,
                            "a bot identity already exists",
                        ));
                    }
                    let umk_seed = random::<32>(ctx.provider)?;
                    let ssk_seed = random::<32>(ctx.provider)?;
                    let device_id = random::<16>(ctx.provider)?;
                    let signer =
                        SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(|e| {
                            ClientError::new(super::error::E_CORE_MLS, format!("keygen: {e:?}"))
                        })?;
                    signer.store(ctx.provider.storage())?;
                    let dsk_pub: [u8; 32] = signer
                        .public()
                        .try_into()
                        .map_err(|_| ClientError::new(E_CORE_STATE, "dsk is not 32 bytes"))?;
                    let umk = UmkSigner::from_bytes(&umk_seed);
                    let ssk = SskSigner::from_bytes(&ssk_seed);
                    let pending = PendingBot {
                        binding,
                        device_id: *device_id,
                        dsk_pub,
                        umk_pub: umk.public(),
                        ssk_pub: ssk.public(),
                        sig_umk_ssk: umk.sign_ssk(&ssk.public()),
                        sig_ssk_dev: ssk.sign_device(
                            &DeviceId::from_bytes(*device_id),
                            &dsk_pub,
                            Kind::Bot,
                            Tier::Native,
                            SignerTier::Native,
                        ),
                        ssk_priv: ssk_seed,
                        k_backup: random::<32>(ctx.provider)?,
                    };
                    pending.validate()?;
                    let body = pending.registration();
                    let encoded = pending.encode();
                    u.with_conn(|c| schema::meta_put(c, schema::BOT_PENDING, &encoded))?;
                    Ok((body, Some(signer)))
                }
                Phase::Ready(rec) => {
                    let credential = CredentialIdentity::decode(&rec.credential)
                        .map_err(|_| malformed(schema::IDENTITY))?;
                    if credential.kind != Kind::Bot {
                        return Err(ClientError::new(
                            E_CORE_STATE,
                            "a human identity already exists",
                        ));
                    }
                    let binding_raw = u.with_conn(|c| schema::meta_get(c, schema::BOT_BINDING))?;
                    let current = binding_raw
                        .as_deref()
                        .map(decode_binding)
                        .transpose()?
                        .ok_or_else(|| {
                            ClientError::new(E_CORE_STATE, "a human identity already exists")
                        })?;
                    if current.instance_id != binding.instance_id
                        || current.community_id != binding.community_id
                        || current.installation_id != binding.installation_id
                        || rec.instance_id != current.instance_id
                    {
                        return Err(binding_mismatch());
                    }
                    validate_ready(&rec)?;
                    Ok((identity_registration(&rec)?, None))
                }
                Phase::Pending(_) => Err(ClientError::new(E_CORE_STATE, "human signup is pending")),
                Phase::Enrolling(_) => {
                    Err(ClientError::new(E_CORE_STATE, "human enrolment is pending"))
                }
            }
        })?;
        if let Some(signer) = new_signer {
            self.signer = Some(signer);
        }
        Ok(body)
    }

    /// Complete a bot account enrollment and return its credential and signed list body.
    pub fn bot_bootstrap_complete(
        &mut self,
        user_id: &[u8; 16],
        username: &str,
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        if *user_id == [0; 16] {
            return Err(ClientError::new(E_CORE_INPUT, "user_id is all zero"));
        }
        self.write(|ctx, u| {
            let (identity_raw, signup, enrol) = u.with_conn(load_phase)?;
            match identity::decode_phase(identity_raw, signup, enrol)? {
                Phase::Ready(rec) => {
                    if rec.user_id != *user_id {
                        return Err(ClientError::new(
                            E_CORE_STATE,
                            "another account is already bound",
                        ));
                    }
                    let binding_raw = u.with_conn(|c| schema::meta_get(c, schema::BOT_BINDING))?;
                    let binding = binding_raw
                        .as_deref()
                        .map(decode_binding)
                        .transpose()?
                        .ok_or_else(|| {
                            ClientError::new(E_CORE_STATE, "a human identity already exists")
                        })?;
                    if binding.instance_id != rec.instance_id {
                        return Err(malformed(schema::BOT_BINDING));
                    }
                    if !nonzero_ids(&binding) {
                        return Err(malformed(schema::BOT_BINDING));
                    }
                    validate_ready(&rec)?;
                    let mut e = Encoder::new();
                    e.array(2)
                        .bytes(&rec.credential)
                        .bytes(&rec.device_list_body);
                    return Ok(e.into_vec());
                }
                Phase::None => {}
                Phase::Pending(_) => {
                    return Err(ClientError::new(E_CORE_STATE, "human signup is pending"));
                }
                Phase::Enrolling(_) => {
                    return Err(ClientError::new(E_CORE_STATE, "human enrolment is pending"));
                }
            }
            let raw = u
                .with_conn(|c| schema::meta_get(c, schema::BOT_PENDING))?
                .ok_or_else(|| ClientError::new(E_CORE_STATE, "no bot bootstrap is pending"))?;
            if u.with_conn(|c| schema::meta_get(c, schema::BOT_BINDING))?
                .is_some()
            {
                return Err(ClientError::new(
                    E_CORE_STATE,
                    "bot identity metadata conflicts",
                ));
            }
            let pending = PendingBot::decode(&raw)?;
            if !nonzero_ids(&pending.binding) {
                return Err(malformed(schema::BOT_PENDING));
            }
            let signer = SskSigner::from_bytes(&pending.ssk_priv);
            let credential = CredentialIdentity {
                v: 1,
                umk_pub: pending.umk_pub,
                user_id: UserId::from_bytes(*user_id),
                device_id: DeviceId::from_bytes(pending.device_id),
                kind: Kind::Bot,
                tier: Tier::Native,
                signer_tier: SignerTier::Native,
                ssk_pub: pending.ssk_pub,
                sig_umk_ssk: pending.sig_umk_ssk,
                sig_ssk_dev: pending.sig_ssk_dev,
            };
            validate_bot_credential(&credential, &pending.dsk_pub, &pending.ssk_pub)?;
            let unsigned = DeviceListUnsigned {
                v: 1,
                user_id: UserId::from_bytes(*user_id),
                version: 1,
                prev_hash: [0; 32],
                entries: vec![DeviceEntry {
                    device_id: DeviceId::from_bytes(pending.device_id),
                    dsk_pub: pending.dsk_pub,
                    tier: Tier::Native,
                    added_at: now,
                    revoked_at: None,
                }],
            };
            let list = DeviceList {
                sig_ssk: signer.sign_device_list(&unsigned),
                unsigned,
            };
            list.verify(&pending.ssk_pub)?;
            let device_list = list.encode();
            let device_list_body = wire::device_list_put_body(&list);
            let mut state_plain = Encoder::new();
            state_plain.array(3).uint(1).bytes(&device_list).array(0);
            let state_plain = Zeroizing::new(state_plain.into_vec());
            let state = seal(ctx.provider, &pending.k_backup, AAD_STATE, &state_plain)?;
            let rec = IdentityRecord {
                instance_id: pending.binding.instance_id,
                user_id: *user_id,
                device_id: pending.device_id,
                dsk_pub: pending.dsk_pub,
                umk_pub: pending.umk_pub,
                ssk_pub: pending.ssk_pub,
                username: username.to_owned(),
                credential: credential.encode(),
                device_list_body: device_list_body.clone(),
                list_published: false,
                device_list,
                state_uploaded: false,
            };
            validate_ready(&rec)?;
            let binding = encode_binding(&pending.binding);
            let identity = rec.encode();
            u.with_conn(|c| {
                schema::meta_put(c, schema::STATE_SEALED, &state)?;
                schema::meta_put(c, schema::STATE_LIST, &state_list(1))?;
                schema::meta_put(c, schema::IDENTITY, &identity)?;
                schema::meta_put(c, schema::BOT_BINDING, &binding)?;
                super::trust::pin_own(
                    c,
                    user_id,
                    &pending.umk_pub,
                    now.min(i64::MAX as u64) as i64,
                )?;
                schema::meta_del(c, schema::BOT_PENDING)
            })?;
            let mut e = Encoder::new();
            e.array(2).bytes(&rec.credential).bytes(&device_list_body);
            Ok(e.into_vec())
        })
    }
}

/// Transaction-local verifier shared with the Bot interaction creation path. The caller must
/// verify `snapshot` against persisted instance and user pins before invoking it, and must supply
/// the Bot identity IDs read from the encrypted store. This function reads no storage and accepts
/// no roster input, so it is safe to run against a transient `DillaGroup` inside the write unit.
pub(crate) fn verify_interaction_group_snapshot(
    group: &DillaGroup,
    snapshot: &crate::bot::interaction_snapshot::Snapshot,
    expected: &crate::bot::interaction_admission::Expected,
    bot_user_id: &[u8; 16],
    bot_device_id: &[u8; 16],
) -> Result<crate::bot::interaction_admission::Admission, ClientError> {
    ClientCore::bot_verify_interaction_group(group, snapshot, expected, bot_user_id, bot_device_id)
}

#[cfg(test)]
mod interaction_snapshot_tests {
    use super::*;
    use crate::{
        bot::{
            interaction_admission::Expected,
            interaction_snapshot::{
                SnapshotList,
                tests::{make_snapshot, signed_list},
            },
        },
        ids::{DeviceId, MsgId},
        mls::{CIPHERSUITE, ConnHandle, build_key_package},
    };
    use ed25519_dalek::SigningKey;
    use openmls::prelude::{BasicCredential, GroupId, MlsGroup, MlsMessageOut};
    use openmls_basic_credential::SignatureKeyPair;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};
    use tls_codec::Serialize;

    const INSTANCE: [u8; 16] = [0x11; 16];
    const COMMUNITY: [u8; 16] = [0x22; 16];
    const INSTALLATION: [u8; 16] = [0x33; 16];
    const BOT_USER: [u8; 16] = [0x44; 16];
    const HUMAN_USER: [u8; 16] = [0x77; 16];
    const HUMAN_DEVICE: [u8; 16] = [0x78; 16];

    fn conn() -> ConnHandle {
        Arc::new(Mutex::new(Connection::open_in_memory().unwrap()))
    }
    fn mid(bytes: [u8; 16]) -> MsgId {
        MsgId::from_bytes(bytes)
    }
    fn counts(c: &Connection) -> (i64, i64, i64, i64) {
        c.query_row("SELECT (SELECT count(*) FROM app_groups),(SELECT count(*) FROM app_bot_intents),(SELECT count(*) FROM app_bot_keypackage_intents),(SELECT count(*) FROM app_meta WHERE k LIKE 'bot_welcome/v1/%')", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
    }
    fn openmls_row_count(c: &Connection) -> i64 {
        let mut statement = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'openmls_%'")
            .unwrap();
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        tables
            .into_iter()
            .try_fold(0_i64, |total, table| {
                let quoted = table.replace('"', "\"\"");
                let count =
                    c.query_row(&format!("SELECT count(*) FROM \"{quoted}\""), [], |row| {
                        row.get::<_, i64>(0)
                    })?;
                Ok::<_, rusqlite::Error>(total + count)
            })
            .unwrap()
    }

    #[test]
    fn interaction_discovery_rejects_overflow_before_loading_any_group() {
        let connection = conn();
        let instance_key = SigningKey::from_bytes(&[42; 32]);
        let mut core = ClientCore::open(connection.clone()).unwrap();
        core.bot_bootstrap_begin(
            &INSTANCE,
            &COMMUNITY,
            &INSTALLATION,
            &instance_key.verifying_key().to_bytes(),
        )
        .unwrap();
        core.bot_bootstrap_complete(&BOT_USER, "bot", 100).unwrap();
        {
            let db = connection.lock().unwrap();
            for n in 1_u32..=2049 {
                let mut group = [0u8; 16];
                group[12..].copy_from_slice(&n.to_be_bytes());
                let mut target = [0u8; 16];
                target[12..].copy_from_slice(&n.to_be_bytes());
                db.execute(
                    "INSERT INTO app_groups(group_id,kind,community_id,target_id,state) VALUES(?1,3,?2,?3,0)",
                    rusqlite::params![group.as_slice(), COMMUNITY.as_slice(), target.as_slice()],
                ).unwrap();
            }
        }

        let err = core
            .bot_interaction_group_descriptors(&INSTANCE, &COMMUNITY, &INSTALLATION)
            .expect_err("descriptor overflow must stop before MLS lookup");
        assert_eq!(err.code, E_CORE_INPUT);
        assert!(
            err.detail.contains("exceeds native descriptor limit"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn signed_snapshot_uses_stored_instance_and_user_pins_without_writing() {
        let connection = conn();
        let instance_key = SigningKey::from_bytes(&[42; 32]);
        let mut core = ClientCore::open(connection.clone()).unwrap();
        core.bot_bootstrap_begin(
            &INSTANCE,
            &COMMUNITY,
            &INSTALLATION,
            &instance_key.verifying_key().to_bytes(),
        )
        .unwrap();
        let completion = core.bot_bootstrap_complete(&BOT_USER, "bot", 100).unwrap();
        let (credential_bytes, list_body) = crate::cbor::decode_strict(&completion, |d| {
            d.array(2)?;
            Ok((d.bytes()?.to_vec(), d.bytes()?.to_vec()))
        })
        .unwrap();
        let credential = CredentialIdentity::decode(&credential_bytes).unwrap();
        let (version, blob, _signature, _prev_hash) = crate::cbor::decode_strict(&list_body, |d| {
            d.array(4)?;
            Ok((
                d.uint()?,
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
            ))
        })
        .unwrap();
        let bot_list = DeviceList::decode(&blob).unwrap();
        let bot_snapshot_list = SnapshotList {
            user: mid(BOT_USER),
            umk: credential.umk_pub,
            ssk: credential.ssk_pub,
            binding_signature: credential.sig_umk_ssk,
            version,
            blob: blob.clone(),
            signature: bot_list.sig_ssk,
            prev_hash: bot_list.unsigned.prev_hash,
            hash: bot_list.hash(),
        };
        let human_snapshot_list = signed_list(mid(HUMAN_USER), mid(HUMAN_DEVICE), 91, 92);
        {
            let c = connection.lock().unwrap();
            // A first-seen participant remains unverified until a human compares safety numbers.
            c.execute("INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,100,0,NULL)", rusqlite::params![HUMAN_USER.as_slice(), human_snapshot_list.umk.as_slice()]).unwrap();
            c.execute("INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub,credential) VALUES(?1,?2,?3,?4,?5,NULL)", rusqlite::params![HUMAN_USER.as_slice(), human_snapshot_list.version as i64, human_snapshot_list.blob, human_snapshot_list.umk.as_slice(), human_snapshot_list.ssk.as_slice()]).unwrap();
        }
        let expected = Expected {
            instance: mid(INSTANCE),
            installation: mid(INSTALLATION),
            community: mid(COMMUNITY),
            bot_user: mid(BOT_USER),
            bot_device: mid(credential.device_id.0),
            participant_user: mid(HUMAN_USER),
            participant_device: mid(HUMAN_DEVICE),
            group: mid([0x99; 16]),
            minimum_eligibility_revision: 11,
            server_now: 100,
            policy_version: 3,
        };
        let wire = make_snapshot(
            &expected,
            &bot_snapshot_list,
            &human_snapshot_list,
            &instance_key,
            101,
        );
        let before = counts(&connection.lock().unwrap());
        let accepted = core
            .bot_verify_interaction_snapshot(&wire, &expected)
            .unwrap();
        assert_eq!(accepted.admission_id, mid([1; 16]));
        {
            let c = connection.lock().unwrap();
            c.execute(
                "UPDATE app_trust_pins SET changed_umk=?1 WHERE user_id=?2",
                rusqlite::params![[0x55u8; 32].as_slice(), HUMAN_USER.as_slice()],
            )
            .unwrap();
        }
        assert!(
            core.bot_verify_interaction_snapshot(&wire, &expected)
                .is_err(),
            "changed participant UMK must remain blocked"
        );
        {
            let c = connection.lock().unwrap();
            c.execute(
                "UPDATE app_trust_pins SET changed_umk=NULL WHERE user_id=?1",
                [HUMAN_USER.as_slice()],
            )
            .unwrap();
            c.execute(
                "UPDATE app_device_lists SET version=version+1 WHERE user_id=?1",
                [HUMAN_USER.as_slice()],
            )
            .unwrap();
        }
        assert!(
            core.bot_verify_interaction_snapshot(&wire, &expected)
                .is_err(),
            "changed participant list must remain blocked"
        );
        {
            let c = connection.lock().unwrap();
            c.execute(
                "UPDATE app_device_lists SET version=?1 WHERE user_id=?2",
                rusqlite::params![human_snapshot_list.version as i64, HUMAN_USER.as_slice()],
            )
            .unwrap();
            c.execute(
                "DELETE FROM app_trust_pins WHERE user_id=?1",
                [HUMAN_USER.as_slice()],
            )
            .unwrap();
        }
        assert!(
            core.bot_verify_interaction_snapshot(&wire, &expected)
                .is_err(),
            "missing participant pin must remain blocked"
        );
        {
            let c = connection.lock().unwrap();
            c.execute("INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,100,0,NULL)", rusqlite::params![HUMAN_USER.as_slice(), human_snapshot_list.umk.as_slice()]).unwrap();
            c.execute(
                "UPDATE app_trust_pins SET verified=0 WHERE user_id=?1",
                [BOT_USER.as_slice()],
            )
            .unwrap();
        }
        assert!(
            core.bot_verify_interaction_snapshot(&wire, &expected)
                .is_err(),
            "Bot own pin must still require verification"
        );
        let mut bad = wire.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(
            core.bot_verify_interaction_snapshot(&bad, &expected)
                .is_err()
        );
        assert!(
            core.bot_inspect_stored_interaction_group(expected.group.as_bytes(), &wire, &expected)
                .is_err(),
            "inspection requires a pre-existing candidate group"
        );
        assert_eq!(counts(&connection.lock().unwrap()), before);
    }

    #[test]
    fn interaction_create_authenticates_two_leaves_and_retries_after_expiry() {
        let connection = conn();
        let instance_key = SigningKey::from_bytes(&[42; 32]);
        let mut core = ClientCore::open(connection.clone()).unwrap();
        core.bot_bootstrap_begin(
            &INSTANCE,
            &COMMUNITY,
            &INSTALLATION,
            &instance_key.verifying_key().to_bytes(),
        )
        .unwrap();
        let completion = core.bot_bootstrap_complete(&BOT_USER, "bot", 100).unwrap();
        let (credential_bytes, list_body) = crate::cbor::decode_strict(&completion, |d| {
            d.array(2)?;
            Ok((d.bytes()?.to_vec(), d.bytes()?.to_vec()))
        })
        .unwrap();
        let bot_credential = CredentialIdentity::decode(&credential_bytes).unwrap();
        let (version, bot_blob, _, _) = crate::cbor::decode_strict(&list_body, |d| {
            d.array(4)?;
            Ok((
                d.uint()?,
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
            ))
        })
        .unwrap();
        let bot_list = DeviceList::decode(&bot_blob).unwrap();
        let bot_snapshot_list = SnapshotList {
            user: mid(BOT_USER),
            umk: bot_credential.umk_pub,
            ssk: bot_credential.ssk_pub,
            binding_signature: bot_credential.sig_umk_ssk,
            version,
            blob: bot_blob,
            signature: bot_list.sig_ssk,
            prev_hash: bot_list.unsigned.prev_hash,
            hash: bot_list.hash(),
        };

        let participant_umk = UmkSigner::from_bytes(&[0x51; 32]);
        let participant_ssk = SskSigner::from_bytes(&[0x52; 32]);
        let participant_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).unwrap();
        participant_signer.store(core.provider.storage()).unwrap();
        let participant_dsk: [u8; 32] = participant_signer.public().try_into().unwrap();
        let participant_identity = CredentialIdentity {
            v: 1,
            umk_pub: participant_umk.public(),
            user_id: UserId::from_bytes(HUMAN_USER),
            device_id: DeviceId::from_bytes(HUMAN_DEVICE),
            kind: Kind::User,
            tier: Tier::Native,
            signer_tier: SignerTier::Native,
            ssk_pub: participant_ssk.public(),
            sig_umk_ssk: participant_umk.sign_ssk(&participant_ssk.public()),
            sig_ssk_dev: participant_ssk.sign_device(
                &DeviceId::from_bytes(HUMAN_DEVICE),
                &participant_dsk,
                Kind::User,
                Tier::Native,
                SignerTier::Native,
            ),
        };
        let participant_unsigned = DeviceListUnsigned {
            v: 1,
            user_id: UserId::from_bytes(HUMAN_USER),
            version: 1,
            prev_hash: [0; 32],
            entries: vec![DeviceEntry {
                device_id: DeviceId::from_bytes(HUMAN_DEVICE),
                dsk_pub: participant_dsk,
                tier: Tier::Native,
                added_at: 100,
                revoked_at: None,
            }],
        };
        let participant_list = DeviceList {
            sig_ssk: participant_ssk.sign_device_list(&participant_unsigned),
            unsigned: participant_unsigned,
        };
        let participant_blob = participant_list.encode();
        let participant_snapshot_list = SnapshotList {
            user: mid(HUMAN_USER),
            umk: participant_umk.public(),
            ssk: participant_ssk.public(),
            binding_signature: participant_umk.sign_ssk(&participant_ssk.public()),
            version: 1,
            blob: participant_blob.clone(),
            signature: participant_list.sig_ssk,
            prev_hash: participant_list.unsigned.prev_hash,
            hash: participant_list.hash(),
        };
        {
            let c = connection.lock().unwrap();
            c.execute("INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,100,1,NULL)", rusqlite::params![HUMAN_USER.as_slice(), participant_umk.public().as_slice()]).unwrap();
            c.execute("INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub,credential) VALUES(?1,1,?2,?3,?4,NULL)", rusqlite::params![HUMAN_USER.as_slice(), participant_blob, participant_umk.public().as_slice(), participant_ssk.public().as_slice()]).unwrap();
        }

        let fixture_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expected = Expected {
            instance: mid(INSTANCE),
            installation: mid(INSTALLATION),
            community: mid(COMMUNITY),
            bot_user: mid(BOT_USER),
            bot_device: mid(bot_credential.device_id.0),
            participant_user: mid(HUMAN_USER),
            participant_device: mid(HUMAN_DEVICE),
            group: mid([0x99; 16]),
            minimum_eligibility_revision: 11,
            server_now: fixture_now,
            policy_version: 3,
        };
        let wire = make_snapshot(
            &expected,
            &bot_snapshot_list,
            &participant_snapshot_list,
            &instance_key,
            fixture_now + 8,
        );
        let group_id = GroupId::from_slice(expected.group.as_bytes());
        let kp = build_key_package(
            &core.provider,
            &participant_signer,
            openmls::prelude::CredentialWithKey {
                credential: BasicCredential::new(participant_identity.encode()).into(),
                signature_key: participant_signer.public().into(),
            },
            false,
        )
        .unwrap();
        let kp_wire = MlsMessageOut::from(kp.key_package().clone())
            .tls_serialize_detached()
            .unwrap();
        let operation = [0x98; 16];
        let created = core
            .bot_interaction_group_create(
                &operation,
                expected.group.as_bytes(),
                &wire,
                &expected,
                &kp_wire,
            )
            .unwrap();
        let result_fields = crate::cbor::decode_strict(&created, |d| {
            d.array(5)?;
            Ok((
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
            ))
        })
        .unwrap();
        assert_eq!(result_fields.0, expected.group.as_bytes());
        assert!(result_fields.1.len() > 0 && result_fields.2.len() > 0);
        assert!(result_fields.3.len() > 0 && result_fields.4.len() > 0);

        std::thread::sleep(std::time::Duration::from_secs(14));
        let replay = core
            .bot_interaction_group_create(
                &operation,
                expected.group.as_bytes(),
                &wire,
                &expected,
                &kp_wire,
            )
            .expect("exact operation replay survives snapshot expiry");
        assert_eq!(replay, created);
        let mut changed_time = expected.clone();
        changed_time.server_now = fixture_now + 9;
        assert_eq!(
            core.bot_interaction_group_create(
                &operation,
                expected.group.as_bytes(),
                &wire,
                &changed_time,
                &kp_wire,
            )
            .expect_err("changed Expected server time conflicts on operation reuse")
            .code,
            E_CORE_STATE
        );
        let mut conflicting_expected = expected.clone();
        conflicting_expected.participant_user = mid([0x79; 16]);
        assert_eq!(
            core.bot_interaction_group_create(
                &operation,
                expected.group.as_bytes(),
                &wire,
                &conflicting_expected,
                &kp_wire,
            )
            .expect_err("reused operation with changed expected tuple conflicts")
            .code,
            E_CORE_STATE
        );

        let app_counts: (i64, i64) = connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT (SELECT count(*) FROM app_groups),(SELECT count(*) FROM app_bot_intents)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(app_counts, (1, 1));
        let group = MlsGroup::load(core.provider.storage(), &group_id)
            .unwrap()
            .unwrap();
        assert_eq!(group.epoch().as_u64(), 1);
        assert_eq!(group.members().count(), 2);

        // The server can prove the old registration absent while the native side
        // still owns a staged create. Discard that exact pending native operation
        // before rebuilding with a fresh admission snapshot and operation ID.
        core.bot_group_discard(&operation, expected.group.as_bytes())
            .expect("discard proven-absent pending registration");
        let discarded_state: (i64, i64) = connection.lock().unwrap().query_row(
            "SELECT (SELECT count(*) FROM app_groups),(SELECT state FROM app_bot_intents WHERE operation_id=?1)",
            rusqlite::params![operation.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(discarded_state, (0, 2));
        let renewed_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut renewed_expected = expected.clone();
        renewed_expected.server_now = renewed_now;
        let renewed_wire = make_snapshot(
            &renewed_expected,
            &bot_snapshot_list,
            &participant_snapshot_list,
            &instance_key,
            renewed_now + 8,
        );
        let renewed_operation = [0x97; 16];
        core.bot_interaction_group_create(
            &renewed_operation,
            renewed_expected.group.as_bytes(),
            &renewed_wire,
            &renewed_expected,
            &kp_wire,
        )
        .expect("fresh native create after proven absence");
        let rebuilt_state: (i64, i64) = connection.lock().unwrap().query_row(
            "SELECT (SELECT count(*) FROM app_groups),(SELECT count(*) FROM app_bot_intents WHERE group_id=?1 AND state=0)",
            rusqlite::params![expected.group.as_bytes().as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(rebuilt_state, (1, 1));

        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        for (group_bytes, snapshot_now, expiry) in [
            ([0xa1; 16], current_time - 100, current_time - 99),
            ([0xa2; 16], current_time + 100, current_time + 200),
        ] {
            let mut stale_expected = expected.clone();
            stale_expected.group = mid(group_bytes);
            stale_expected.server_now = snapshot_now;
            let stale_wire = make_snapshot(
                &stale_expected,
                &bot_snapshot_list,
                &participant_snapshot_list,
                &instance_key,
                expiry,
            );
            let before_counts = counts(&connection.lock().unwrap());
            let before_openmls = openmls_row_count(&connection.lock().unwrap());
            assert!(
                core.bot_interaction_group_create(
                    &[group_bytes[0]; 16],
                    &group_bytes,
                    &stale_wire,
                    &stale_expected,
                    &kp_wire,
                )
                .is_err()
            );
            assert_eq!(counts(&connection.lock().unwrap()), before_counts);
            assert_eq!(
                openmls_row_count(&connection.lock().unwrap()),
                before_openmls
            );
        }

        let inspect_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut inspect_expected = expected.clone();
        inspect_expected.server_now = inspect_now;
        let inspect_wire = make_snapshot(
            &inspect_expected,
            &bot_snapshot_list,
            &participant_snapshot_list,
            &instance_key,
            inspect_now + 8,
        );
        let before = counts(&connection.lock().unwrap());
        let admission = core
            .bot_inspect_stored_interaction_group(
                inspect_expected.group.as_bytes(),
                &inspect_wire,
                &inspect_expected,
            )
            .unwrap();
        assert_eq!(admission.participant_user, mid(HUMAN_USER));
        assert_eq!(counts(&connection.lock().unwrap()), before);

        for (snapshot_now, expiry) in [
            (inspect_now - 100, inspect_now - 99),
            (inspect_now + 100, inspect_now + 200),
        ] {
            let mut stale_expected = inspect_expected.clone();
            stale_expected.server_now = snapshot_now;
            let stale_wire = make_snapshot(
                &stale_expected,
                &bot_snapshot_list,
                &participant_snapshot_list,
                &instance_key,
                expiry,
            );
            assert!(
                core.bot_inspect_stored_interaction_group(
                    stale_expected.group.as_bytes(),
                    &stale_wire,
                    &stale_expected,
                )
                .is_err(),
                "inspection must reject snapshots outside local clock tolerance"
            );
            assert_eq!(counts(&connection.lock().unwrap()), before);
        }

        let mut wrong_participant = inspect_expected.clone();
        wrong_participant.participant_user = mid([0x79; 16]);
        assert!(
            core.bot_inspect_stored_interaction_group(
                wrong_participant.group.as_bytes(),
                &inspect_wire,
                &wrong_participant,
            )
            .is_err()
        );
        assert_eq!(counts(&connection.lock().unwrap()), before);

        connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE app_groups SET target_id=?2 WHERE group_id=?1",
                rusqlite::params![expected.group.as_bytes().as_slice(), BOT_USER.as_slice()],
            )
            .unwrap();
        let target_check_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut target_check_expected = inspect_expected.clone();
        target_check_expected.server_now = target_check_now;
        let target_check_wire = make_snapshot(
            &target_check_expected,
            &bot_snapshot_list,
            &participant_snapshot_list,
            &instance_key,
            target_check_now + 8,
        );
        assert!(
            core.bot_inspect_stored_interaction_group(
                target_check_expected.group.as_bytes(),
                &target_check_wire,
                &target_check_expected,
            )
            .is_err(),
            "the app row must target the authenticated participant"
        );
        connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE app_groups SET target_id=?2 WHERE group_id=?1",
                rusqlite::params![expected.group.as_bytes().as_slice(), HUMAN_USER.as_slice()],
            )
            .unwrap();

        let mut group = MlsGroup::load(core.provider.storage(), &group_id)
            .unwrap()
            .unwrap();
        let third_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).unwrap();
        third_signer.store(core.provider.storage()).unwrap();
        let third_device = DeviceId::from_bytes([0x7a; 16]);
        let third_dsk: [u8; 32] = third_signer.public().try_into().unwrap();
        let mut third_identity = participant_identity.clone();
        third_identity.device_id = third_device;
        third_identity.sig_ssk_dev = participant_ssk.sign_device(
            &third_device,
            &third_dsk,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        );
        let third_kp = build_key_package(
            &core.provider,
            &third_signer,
            openmls::prelude::CredentialWithKey {
                credential: BasicCredential::new(third_identity.encode()).into(),
                signature_key: third_signer.public().into(),
            },
            false,
        )
        .unwrap();
        group
            .add_members(
                &core.provider,
                core.signer.as_ref().unwrap(),
                &[third_kp.key_package().clone()],
            )
            .unwrap();
        group.merge_pending_commit(&core.provider).unwrap();
        assert_eq!(group.members().count(), 3);
        let roster_check_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut roster_check_expected = inspect_expected.clone();
        roster_check_expected.server_now = roster_check_now;
        let roster_check_wire = make_snapshot(
            &roster_check_expected,
            &bot_snapshot_list,
            &participant_snapshot_list,
            &instance_key,
            roster_check_now + 8,
        );
        assert!(
            core.bot_inspect_stored_interaction_group(
                roster_check_expected.group.as_bytes(),
                &roster_check_wire,
                &roster_check_expected,
            )
            .is_err(),
            "a third OpenMLS leaf must be refused"
        );
        assert_eq!(counts(&connection.lock().unwrap()), before);
    }
}
