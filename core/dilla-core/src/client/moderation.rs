//! Domain-separated moderator proof signing with actor context read from the local identity.

use super::bot_identity;
use super::error::{E_CORE_INPUT, E_CORE_NO_IDENTITY, E_CORE_STATE};
use super::{ClientCore, ClientError, groups};
use crate::bot::RemovalProof;
use crate::cbor::Encoder;
use crate::ids::{CommunityId, DeviceId, MsgId, UserId};
use openmls_traits::signatures::Signer;

impl ClientCore {
    /// Sign the reviewed moderation-removal preimage for an active community group.
    /// Actor, device and community are taken from the ready identity and stored group binding.
    pub fn sign_removal(
        &mut self,
        request_id: &[u8; 16],
        group_id: &[u8; 16],
        target_sequence: u64,
        expires: u64,
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        if *request_id == [0; 16] || *group_id == [0; 16] {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "request_id and group_id must be nonzero",
            ));
        }
        if target_sequence == 0 {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "target_sequence must be positive",
            ));
        }
        let latest = now
            .checked_add(30)
            .ok_or_else(|| ClientError::new(E_CORE_INPUT, "expiry window overflows"))?;
        if expires <= now || expires > latest {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "expires must be within 30 seconds",
            ));
        }

        let own = self.own()?;
        if own.kind > 1 {
            return Err(ClientError::new(
                E_CORE_NO_IDENTITY,
                "identity kind is unsupported",
            ));
        }
        let row = self
            .read(|c| groups::group_row(c, group_id))?
            .ok_or_else(|| ClientError::new(E_CORE_STATE, "group is not locally joined"))?;
        if row.state != groups::STATE_ACTIVE || (row.kind != 0 && row.kind != 1) {
            return Err(ClientError::new(
                E_CORE_STATE,
                "group is not an active community text or call group",
            ));
        }
        let community = row
            .community_id
            .as_deref()
            .and_then(|bytes| <[u8; 16]>::try_from(bytes).ok())
            .ok_or_else(|| ClientError::new(E_CORE_STATE, "group is not bound to a community"))?;
        if community == [0; 16] {
            return Err(ClientError::new(E_CORE_STATE, "group community is invalid"));
        }
        if own.kind == 1 {
            let binding_raw =
                self.read(|c| super::schema::meta_get(c, super::schema::BOT_BINDING))?;
            let binding = binding_raw
                .as_deref()
                .map(bot_identity::decode_binding)
                .transpose()?
                .ok_or_else(|| {
                    ClientError::new(E_CORE_STATE, "bot installation binding is missing")
                })?;
            if !bot_identity::nonzero_ids(&binding)
                || binding.instance_id != own.instance_id
                || binding.community_id != community
            {
                return Err(ClientError::new(
                    E_CORE_STATE,
                    "group belongs to another bot community",
                ));
            }
        }

        let group = self
            .take_group(group_id)?
            .ok_or_else(|| ClientError::new(E_CORE_STATE, "group is not locally joined"))?;
        let member = group.roster().into_iter().any(|entry| {
            entry.user_id.as_bytes() == &own.user_id && entry.device_id.as_bytes() == &own.device_id
        });
        self.keep_group(*group_id, group);
        if !member {
            return Err(ClientError::new(
                E_CORE_STATE,
                "device is not a current group member",
            ));
        }

        let proof = RemovalProof {
            request_id: MsgId::from_bytes(*request_id),
            actor_user: UserId::from_bytes(own.user_id),
            actor_device: DeviceId::from_bytes(own.device_id),
            community_id: CommunityId::from_bytes(community),
            group_id: MsgId::from_bytes(*group_id),
            target_seq: target_sequence,
            expires,
        };
        proof
            .validate_context(
                CommunityId::from_bytes(community),
                MsgId::from_bytes(*group_id),
                UserId::from_bytes(own.user_id),
                DeviceId::from_bytes(own.device_id),
                now,
            )
            .map_err(|_| ClientError::new(E_CORE_INPUT, "removal proof context is invalid"))?;
        let proof_bytes = proof
            .encode()
            .map_err(|_| ClientError::new(E_CORE_INPUT, "removal proof is invalid"))?;
        let preimage = proof
            .signature_preimage()
            .map_err(|_| ClientError::new(E_CORE_INPUT, "removal proof is invalid"))?;
        let signature = self
            .signer()?
            .sign(&preimage)
            .map_err(|_| ClientError::new(super::error::E_CORE_MLS, "removal signing failed"))?;
        let signature: [u8; 64] = signature.try_into().map_err(|_| {
            ClientError::new(
                super::error::E_CORE_MLS,
                "removal signature length is invalid",
            )
        })?;
        let mut e = Encoder::new();
        e.array(2).bytes(&proof_bytes).bytes(&signature);
        Ok(e.into_vec())
    }
}
