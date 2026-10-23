//! Domain-separated moderator proof signing with actor context read from the local identity.

use super::bot_identity;
use super::error::{E_CORE_INPUT, E_CORE_NO_IDENTITY, E_CORE_STATE};
use super::{ClientCore, ClientError, groups};
use crate::bot::RemovalProof;
use crate::cbor::Encoder;
use crate::ids::{CommunityId, DeviceId, MsgId, UserId};
use crate::mls::StorageError;
use openmls_traits::signatures::Signer;
use rusqlite::OptionalExtension;

/// A manual moderation action and its encrypted, crash-safe op61 evidence payload.
/// `state`: 0 signed/not submitted, 1 submitted or outcome unknown, 2 removal accepted,
/// 3 evidence upload accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManualRemovalEvidence {
    pub proof_request_id: [u8; 16],
    pub evidence_request_id: [u8; 16],
    pub actor_user_id: [u8; 16],
    pub actor_device_id: [u8; 16],
    pub community_id: [u8; 16],
    pub group_id: [u8; 16],
    pub channel_id: [u8; 16],
    pub message_id: [u8; 16],
    pub target_sequence: u64,
    pub reason: String,
    pub excerpt: String,
    pub signed_body: Vec<u8>,
    pub state: u8,
    pub created_at: u64,
    pub expires: u64,
    pub evidence_expires: u64,
}

/// A human warning's reason is durably staged before the HTTP action. The
/// record survives reload until the accepted server receipt has been attached
/// to its encrypted Bot interaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManualWarningEvidence {
    pub request_id: [u8; 16],
    pub evidence_request_id: [u8; 16],
    pub actor_user_id: [u8; 16],
    pub actor_device_id: [u8; 16],
    pub community_id: [u8; 16],
    pub target_user_id: [u8; 16],
    pub reason: String,
    pub state: u8,
    pub created_at: u64,
    pub action_id: [u8; 16],
    pub revision: u64,
    pub accepted_at: u64,
    pub evidence_expires: u64,
}

const MANUAL_EVIDENCE_PENDING_MAX: i64 = 32;
const MANUAL_EVIDENCE_TOTAL_MAX: i64 = 256;
const MANUAL_EVIDENCE_RETENTION_SECS: u64 = 30 * 24 * 60 * 60;

fn manual_evidence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ManualRemovalEvidence> {
    use rusqlite::types::Type;
    let id = |index: usize, name: &'static str| -> rusqlite::Result<[u8; 16]> {
        let bytes: Vec<u8> = row.get(index)?;
        bytes.try_into().map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                Type::Blob,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, name)),
            )
        })
    };
    let uint = |index: usize, name: &'static str| -> rusqlite::Result<u64> {
        let value: i64 = row.get(index)?;
        u64::try_from(value).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                Type::Integer,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, name)),
            )
        })
    };
    let state: i64 = row.get(12)?;
    Ok(ManualRemovalEvidence {
        proof_request_id: id(0, "proof request id")?,
        evidence_request_id: id(1, "evidence request id")?,
        actor_user_id: id(2, "actor user id")?,
        actor_device_id: id(3, "actor device id")?,
        community_id: id(4, "community id")?,
        group_id: id(5, "group id")?,
        channel_id: id(6, "channel id")?,
        message_id: id(7, "message id")?,
        target_sequence: uint(8, "target sequence")?,
        reason: row.get(9)?,
        excerpt: row.get(10)?,
        signed_body: row.get(11)?,
        state: u8::try_from(state).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                12,
                Type::Integer,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "manual evidence state",
                )),
            )
        })?,
        created_at: uint(13, "created_at")?,
        expires: uint(14, "expires")?,
        evidence_expires: uint(15, "evidence_expires")?,
    })
}

fn manual_warning_evidence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ManualWarningEvidence> {
    use rusqlite::types::Type;
    let id = |index: usize, name: &'static str| -> rusqlite::Result<[u8; 16]> {
        let bytes: Vec<u8> = row.get(index)?;
        bytes.try_into().map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                Type::Blob,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, name)),
            )
        })
    };
    let optional_id = |index: usize| -> rusqlite::Result<[u8; 16]> {
        let bytes: Option<Vec<u8>> = row.get(index)?;
        match bytes {
            Some(bytes) => bytes.try_into().map_err(|_| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    Type::Blob,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "warning action id",
                    )),
                )
            }),
            None => Ok([0; 16]),
        }
    };
    let optional_uint = |index: usize| -> rusqlite::Result<u64> {
        let value: Option<i64> = row.get(index)?;
        value
            .map(|v| {
                u64::try_from(v).map_err(|_| {
                    rusqlite::Error::FromSqlConversionFailure(
                        index,
                        Type::Integer,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "warning receipt number",
                        )),
                    )
                })
            })
            .transpose()
            .map(|v| v.unwrap_or(0))
    };
    let uint = |index: usize, name: &'static str| -> rusqlite::Result<u64> {
        let value: i64 = row.get(index)?;
        u64::try_from(value).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                Type::Integer,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, name)),
            )
        })
    };
    let state: i64 = row.get(7)?;
    Ok(ManualWarningEvidence {
        request_id: id(0, "warning request id")?,
        evidence_request_id: id(1, "warning evidence request id")?,
        actor_user_id: id(2, "warning actor user id")?,
        actor_device_id: id(3, "warning actor device id")?,
        community_id: id(4, "warning community id")?,
        target_user_id: id(5, "warning target user id")?,
        reason: row.get(6)?,
        state: u8::try_from(state).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                Type::Integer,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "warning evidence state",
                )),
            )
        })?,
        created_at: uint(8, "warning created_at")?,
        action_id: optional_id(9)?,
        revision: optional_uint(10)?,
        accepted_at: optional_uint(11)?,
        evidence_expires: uint(12, "warning evidence expiry")?,
    })
}

impl ClientCore {
    /// Sign and persist the complete evidence record before a caller can POST the removal.
    /// Repeating the same proof request is idempotent only when every input matches.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_manual_removal_evidence(
        &mut self,
        proof_request_id: &[u8; 16],
        evidence_request_id: &[u8; 16],
        community_id: &[u8; 16],
        group_id: &[u8; 16],
        channel_id: &[u8; 16],
        message_id: &[u8; 16],
        target_sequence: u64,
        reason: &str,
        excerpt: &str,
        created_at: u64,
        expires: u64,
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        if [
            proof_request_id,
            evidence_request_id,
            community_id,
            group_id,
            channel_id,
            message_id,
        ]
        .iter()
        .any(|id| **id == [0; 16])
            || reason.trim().is_empty()
            || reason.len() > 1024
            || reason.is_empty()
            || excerpt.len() > 512
            || target_sequence == 0
        {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "manual removal evidence is outside its bounds",
            ));
        }
        let own = self.own()?;
        if own.kind != 0 {
            return Err(ClientError::new(
                E_CORE_STATE,
                "manual removal evidence requires a human identity",
            ));
        }
        let signed_body =
            self.sign_removal(proof_request_id, group_id, target_sequence, expires, now)?;
        let target_sql = i64::try_from(target_sequence)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "target sequence is out of range"))?;
        let created = i64::try_from(created_at)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "created_at is out of range"))?;
        let expires_sql = i64::try_from(expires)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "expires is out of range"))?;
        self.write(|_, unit| {
            unit.with_conn(|c| {
                let result = (|| -> Result<(), ClientError> {
                    c.execute("DELETE FROM app_manual_removal_evidence WHERE state=3 AND created_at<=?1",
                        [created.saturating_sub(MANUAL_EVIDENCE_RETENTION_SECS as i64)]).map_err(StorageError::from)?;
                    let prior: Option<ManualRemovalEvidence> = c.query_row(
                        "SELECT proof_request_id,evidence_request_id,actor_user_id,actor_device_id,community_id,group_id,channel_id,message_id,target_sequence,reason,excerpt,signed_body,state,created_at,expires,evidence_expires FROM app_manual_removal_evidence WHERE proof_request_id=?1",
                        [proof_request_id.as_slice()], manual_evidence_row,
                    ).optional().map_err(StorageError::from)?;
                    if let Some(prior) = prior {
                        if prior.evidence_request_id == *evidence_request_id && prior.actor_user_id == own.user_id && prior.actor_device_id == own.device_id && prior.community_id == *community_id
                            && prior.group_id == *group_id && prior.channel_id == *channel_id && prior.message_id == *message_id
                            && prior.target_sequence == target_sequence && prior.reason == reason && prior.excerpt == excerpt
                            && prior.signed_body == signed_body { return Ok(()); }
                        return Err(ClientError::new(E_CORE_STATE, "proof request id is already bound to other evidence"));
                    }
                    let pending: i64 = c.query_row("SELECT count(*) FROM app_manual_removal_evidence WHERE state<3", [], |r| r.get(0)).map_err(StorageError::from)?;
                    let total: i64 = c.query_row("SELECT count(*) FROM app_manual_removal_evidence", [], |r| r.get(0)).map_err(StorageError::from)?;
                    if pending >= MANUAL_EVIDENCE_PENDING_MAX || total >= MANUAL_EVIDENCE_TOTAL_MAX {
                        return Err(ClientError::new(super::error::E_CORE_LIMIT, "manual removal evidence outbox is full"));
                    }
                    c.execute(
                        "INSERT INTO app_manual_removal_evidence(proof_request_id,evidence_request_id,actor_user_id,actor_device_id,community_id,group_id,channel_id,message_id,target_sequence,reason,excerpt,signed_body,state,created_at,expires,evidence_expires) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13,?14,0)",
                        rusqlite::params![proof_request_id.as_slice(), evidence_request_id.as_slice(), own.user_id.as_slice(), own.device_id.as_slice(), community_id.as_slice(), group_id.as_slice(), channel_id.as_slice(), message_id.as_slice(), target_sql, reason, excerpt, signed_body, created, expires_sql],
                    ).map_err(StorageError::from)?;
                    Ok(())
                })();
                Ok(result)
            })?
        })?;
        Ok(signed_body)
    }

    /// Unresolved records survive reload. Completed records are retained for a bounded period.
    pub fn manual_removal_evidence(&self) -> Result<Vec<ManualRemovalEvidence>, ClientError> {
        self.read(|c| {
            let mut q = c.prepare("SELECT proof_request_id,evidence_request_id,actor_user_id,actor_device_id,community_id,group_id,channel_id,message_id,target_sequence,reason,excerpt,signed_body,state,created_at,expires,evidence_expires FROM app_manual_removal_evidence WHERE state<3 ORDER BY created_at,proof_request_id")?;
            q.query_map([], manual_evidence_row)?.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
    }

    /// Atomically reserve a fresh op61 envelope ID and expiry before request-body construction.
    /// Reuses the current reservation while it is valid; rotates it after expiry, keeping proof ID
    /// and the exact evidence bytes stable across safe server-side duplicates.
    pub fn ensure_manual_removal_evidence_request(
        &mut self,
        proof_request_id: &[u8; 16],
        candidate_request_id: &[u8; 16],
        now: u64,
    ) -> Result<([u8; 16], u64), ClientError> {
        if *candidate_request_id == [0; 16] {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "evidence request id is invalid",
            ));
        }
        let now_sql = i64::try_from(now)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "now is out of range"))?;
        let expires = now
            .checked_add(30)
            .ok_or_else(|| ClientError::new(E_CORE_INPUT, "evidence expiry is out of range"))?;
        let expires_sql = i64::try_from(expires)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "evidence expiry is out of range"))?;
        self.write(|_, unit| {
            let result = unit.with_conn(|c| {
                let result = (|| -> Result<([u8; 16], u64), ClientError> {
                    let row: Option<([u8; 16], i64, i64)> = c.query_row(
                        "SELECT evidence_request_id,evidence_expires,state FROM app_manual_removal_evidence WHERE proof_request_id=?1",
                        [proof_request_id.as_slice()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    ).optional().map_err(StorageError::from)?;
                    let Some((current, current_expiry, state)) = row else {
                        return Err(ClientError::new(super::error::E_CORE_NOT_FOUND, "manual removal evidence not found"));
                    };
                    if state != 2 { return Err(ClientError::new(E_CORE_STATE, "removal acceptance is required before evidence upload")); }
                    if current_expiry == 0 {
                        c.execute("UPDATE app_manual_removal_evidence SET evidence_expires=?2 WHERE proof_request_id=?1 AND state=2",
                            rusqlite::params![proof_request_id.as_slice(), expires_sql]).map_err(StorageError::from)?;
                        return Ok((current, expires));
                    }
                    if current_expiry > now_sql {
                        return Ok((current, u64::try_from(current_expiry).map_err(|_| ClientError::new(E_CORE_STATE, "stored evidence expiry is invalid"))?));
                    }
                    c.execute("UPDATE app_manual_removal_evidence SET evidence_request_id=?2,evidence_expires=?3 WHERE proof_request_id=?1 AND state=2",
                        rusqlite::params![proof_request_id.as_slice(), candidate_request_id.as_slice(), expires_sql]).map_err(StorageError::from)?;
                    Ok((*candidate_request_id, expires))
                })();
                Ok(result)
            })?;
            result
        })
    }

    /// Persist the attempt marker before issuing POST. State 1 is deliberately also the explicit unknown outcome.
    pub fn mark_manual_removal_submitted(
        &mut self,
        request_id: &[u8; 16],
    ) -> Result<(), ClientError> {
        self.update_manual_evidence(
            request_id,
            "UPDATE app_manual_removal_evidence SET state=1 WHERE proof_request_id=?1 AND state=0",
        )
    }

    /// The accepted POST response or a verified feed entry is authoritative for this transition.
    pub fn mark_manual_removal_accepted(
        &mut self,
        request_id: &[u8; 16],
    ) -> Result<(), ClientError> {
        self.update_manual_evidence(
            request_id,
            "UPDATE app_manual_removal_evidence SET state=2 WHERE proof_request_id=?1 AND state<3",
        )
    }

    /// Remove the record from the pending queue only after the op61 send has an accepted receipt.
    pub fn complete_manual_removal_evidence(
        &mut self,
        request_id: &[u8; 16],
        now: u64,
    ) -> Result<(), ClientError> {
        let now = i64::try_from(now)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "now is out of range"))?;
        self.write(|_, unit| {
            let result = unit.with_conn(|c| {
                let result = (|| -> Result<(), ClientError> {
                    let changed = c.execute("UPDATE app_manual_removal_evidence SET state=3 WHERE proof_request_id=?1 AND state>=2", [request_id.as_slice()]).map_err(StorageError::from)?;
                    if changed == 0 {
                        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM app_manual_removal_evidence WHERE proof_request_id=?1)", [request_id.as_slice()], |r| r.get(0)).map_err(StorageError::from)?;
                        if !exists { return Err(ClientError::new(super::error::E_CORE_NOT_FOUND, "manual removal evidence not found")); }
                    }
                    c.execute("DELETE FROM app_manual_removal_evidence WHERE state=3 AND created_at<=?1", [now.saturating_sub(MANUAL_EVIDENCE_RETENTION_SECS as i64)]).map_err(StorageError::from)?;
                    Ok(())
                })();
                Ok(result)
            })?;
            result
        })
    }

    /// A signed proof that never crossed the POST boundary and has expired is known not accepted.
    pub fn reject_unsubmitted_manual_removal(
        &mut self,
        request_id: &[u8; 16],
        now: u64,
    ) -> Result<(), ClientError> {
        let now = i64::try_from(now)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "now is out of range"))?;
        self.write(|_, unit| {
            let result = unit.with_conn(|c| {
                let result = (|| -> Result<(), ClientError> {
                    let changed = c.execute("UPDATE app_manual_removal_evidence SET state=3 WHERE proof_request_id=?1 AND state=0 AND expires<=?2",
                        rusqlite::params![request_id.as_slice(), now]).map_err(StorageError::from)?;
                    if changed == 0 {
                        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM app_manual_removal_evidence WHERE proof_request_id=?1)", [request_id.as_slice()], |r| r.get(0)).map_err(StorageError::from)?;
                        if !exists { return Err(ClientError::new(super::error::E_CORE_NOT_FOUND, "manual removal evidence not found")); }
                    }
                    c.execute("DELETE FROM app_manual_removal_evidence WHERE state=3 AND created_at<=?1", [now.saturating_sub(MANUAL_EVIDENCE_RETENTION_SECS as i64)]).map_err(StorageError::from)?;
                    Ok(())
                })();
                Ok(result)
            })?;
            result
        })
    }

    /// Retire a submitted proof only after an authoritative HTTP refusal establishes it was not accepted.
    pub fn reject_manual_removal(
        &mut self,
        request_id: &[u8; 16],
        now: u64,
    ) -> Result<(), ClientError> {
        let now = i64::try_from(now)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "now is out of range"))?;
        self.write(|_, unit| {
            let result = unit.with_conn(|c| {
                let result = (|| -> Result<(), ClientError> {
                    let changed = c.execute("UPDATE app_manual_removal_evidence SET state=3 WHERE proof_request_id=?1 AND state<2",
                        [request_id.as_slice()]).map_err(StorageError::from)?;
                    if changed == 0 {
                        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM app_manual_removal_evidence WHERE proof_request_id=?1)", [request_id.as_slice()], |r| r.get(0)).map_err(StorageError::from)?;
                        if !exists { return Err(ClientError::new(super::error::E_CORE_NOT_FOUND, "manual removal evidence not found")); }
                    }
                    c.execute("DELETE FROM app_manual_removal_evidence WHERE state=3 AND created_at<=?1", [now.saturating_sub(MANUAL_EVIDENCE_RETENTION_SECS as i64)]).map_err(StorageError::from)?;
                    Ok(())
                })();
                Ok(result)
            })?;
            result
        })
    }

    /// Persist a manual warning reason before POST. Reusing a request id is
    /// allowed only for the exact same actor, target, reason and evidence id.
    pub fn prepare_manual_warning_evidence(
        &mut self,
        request_id: &[u8; 16],
        evidence_request_id: &[u8; 16],
        community_id: &[u8; 16],
        target_user_id: &[u8; 16],
        reason: &str,
        created_at: u64,
        now: u64,
    ) -> Result<(), ClientError> {
        if [
            request_id,
            evidence_request_id,
            community_id,
            target_user_id,
        ]
        .iter()
        .any(|v| **v == [0; 16])
            || reason.trim().is_empty()
            || reason.len() > 1024
            || created_at == 0
            || created_at > now.saturating_add(300)
            || now > i64::MAX as u64
        {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "manual warning evidence is outside its bounds",
            ));
        }
        let own = self.own()?;
        if own.kind != 0 {
            return Err(ClientError::new(
                E_CORE_STATE,
                "manual warning evidence requires a human identity",
            ));
        }
        let created = i64::try_from(created_at)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "created_at is out of range"))?;
        self.write(|_, unit| {
            unit.with_conn(|c| {
                let result = (|| -> Result<(), ClientError> {
                    c.execute("DELETE FROM app_manual_warning_evidence WHERE state=2 AND created_at<=?1",
                        [created.saturating_sub(MANUAL_EVIDENCE_RETENTION_SECS as i64)]).map_err(StorageError::from)?;
                    let prior: Option<ManualWarningEvidence> = c.query_row(
                        "SELECT request_id,evidence_request_id,actor_user_id,actor_device_id,community_id,target_user_id,reason,state,created_at,action_id,revision,accepted_at,evidence_expires FROM app_manual_warning_evidence WHERE request_id=?1",
                        [request_id.as_slice()], manual_warning_evidence_row,
                    ).optional().map_err(StorageError::from)?;
                    if let Some(prior) = prior {
                        if prior.evidence_request_id == *evidence_request_id && prior.actor_user_id == own.user_id &&
                            prior.actor_device_id == own.device_id && prior.community_id == *community_id &&
                            prior.target_user_id == *target_user_id && prior.reason == reason {
                            return Ok(());
                        }
                        return Err(ClientError::new(E_CORE_STATE, "warning request id is already bound to other evidence"));
                    }
                    let pending: i64 = c.query_row("SELECT count(*) FROM app_manual_warning_evidence WHERE state<2", [], |r| r.get(0)).map_err(StorageError::from)?;
                    let total: i64 = c.query_row("SELECT count(*) FROM app_manual_warning_evidence", [], |r| r.get(0)).map_err(StorageError::from)?;
                    if pending >= MANUAL_EVIDENCE_PENDING_MAX || total >= MANUAL_EVIDENCE_TOTAL_MAX {
                        return Err(ClientError::new(super::error::E_CORE_LIMIT, "manual warning evidence outbox is full"));
                    }
                    c.execute("INSERT INTO app_manual_warning_evidence(request_id,evidence_request_id,actor_user_id,actor_device_id,community_id,target_user_id,reason,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8)",
                        rusqlite::params![request_id.as_slice(), evidence_request_id.as_slice(), own.user_id.as_slice(), own.device_id.as_slice(), community_id.as_slice(), target_user_id.as_slice(), reason, created]).map_err(StorageError::from)?;
                    Ok(())
                })();
                Ok(result)
            })?
        })
    }

    pub fn manual_warning_evidence(&self) -> Result<Vec<ManualWarningEvidence>, ClientError> {
        self.read(|c| {
            let mut q = c.prepare("SELECT request_id,evidence_request_id,actor_user_id,actor_device_id,community_id,target_user_id,reason,state,created_at,action_id,revision,accepted_at,evidence_expires FROM app_manual_warning_evidence WHERE state<2 ORDER BY created_at,request_id")?;
            q.query_map([], manual_warning_evidence_row)?.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
    }

    /// Mark the pre-action outbox only with the receipt returned by the instance.
    pub fn mark_manual_warning_accepted(
        &mut self,
        request_id: &[u8; 16],
        action_id: &[u8; 16],
        revision: u64,
        accepted_at: u64,
    ) -> Result<(), ClientError> {
        if *request_id == [0; 16]
            || *action_id == [0; 16]
            || revision == 0
            || accepted_at == 0
            || revision > i64::MAX as u64
            || accepted_at > i64::MAX as u64
        {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "warning receipt is outside its bounds",
            ));
        }
        let revision_sql = revision as i64;
        let accepted_sql = accepted_at as i64;
        self.write(|_, unit| unit.with_conn(|c| {
            let result = (|| -> Result<(), ClientError> {
                let row: Option<ManualWarningEvidence> = c.query_row(
                    "SELECT request_id,evidence_request_id,actor_user_id,actor_device_id,community_id,target_user_id,reason,state,created_at,action_id,revision,accepted_at,evidence_expires FROM app_manual_warning_evidence WHERE request_id=?1",
                    [request_id.as_slice()], manual_warning_evidence_row,
                ).optional().map_err(StorageError::from)?;
                let Some(row) = row else { return Err(ClientError::new(super::error::E_CORE_NOT_FOUND, "manual warning evidence not found")); };
                if row.state >= 1 {
                    if row.action_id == *action_id && row.revision == revision && row.accepted_at == accepted_at { return Ok(()); }
                    return Err(ClientError::new(E_CORE_STATE, "warning request is bound to another accepted action"));
                }
                c.execute("UPDATE app_manual_warning_evidence SET state=1,action_id=?2,revision=?3,accepted_at=?4 WHERE request_id=?1 AND state=0",
                    rusqlite::params![request_id.as_slice(), action_id.as_slice(), revision_sql, accepted_sql]).map_err(StorageError::from)?;
                Ok(())
            })();
            Ok(result)
        })?)
    }

    /// Reserve a stable op61 request id; a stale envelope may rotate while the warning receipt and reason stay fixed.
    pub fn ensure_manual_warning_evidence_request(
        &mut self,
        request_id: &[u8; 16],
        candidate_request_id: &[u8; 16],
        now: u64,
    ) -> Result<([u8; 16], u64), ClientError> {
        if *request_id == [0; 16] || *candidate_request_id == [0; 16] {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "warning evidence request id is invalid",
            ));
        }
        let now_sql = i64::try_from(now)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "now is out of range"))?;
        let expires = now
            .checked_add(30)
            .ok_or_else(|| ClientError::new(E_CORE_INPUT, "evidence expiry is out of range"))?;
        let expires_sql = i64::try_from(expires)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "evidence expiry is out of range"))?;
        self.write(|_, unit| unit.with_conn(|c| {
            let result = (|| -> Result<([u8; 16], u64), ClientError> {
                let row: Option<([u8; 16], i64, i64)> = c.query_row(
                    "SELECT evidence_request_id,evidence_expires,state FROM app_manual_warning_evidence WHERE request_id=?1",
                    [request_id.as_slice()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ).optional().map_err(StorageError::from)?;
                let Some((current, current_expiry, state)) = row else { return Err(ClientError::new(super::error::E_CORE_NOT_FOUND, "manual warning evidence not found")); };
                if state != 1 { return Err(ClientError::new(E_CORE_STATE, "warning acceptance is required before evidence upload")); }
                if current_expiry == 0 {
                    c.execute("UPDATE app_manual_warning_evidence SET evidence_expires=?2 WHERE request_id=?1 AND state=1",
                        rusqlite::params![request_id.as_slice(), expires_sql]).map_err(StorageError::from)?;
                    return Ok((current, expires));
                }
                if current_expiry > now_sql {
                    return Ok((current, u64::try_from(current_expiry).map_err(|_| ClientError::new(E_CORE_STATE, "stored evidence expiry is invalid"))?));
                }
                c.execute("UPDATE app_manual_warning_evidence SET evidence_request_id=?2,evidence_expires=?3 WHERE request_id=?1 AND state=1",
                    rusqlite::params![request_id.as_slice(), candidate_request_id.as_slice(), expires_sql]).map_err(StorageError::from)?;
                Ok((*candidate_request_id, expires))
            })();
            Ok(result)
        })?)
    }

    pub fn complete_manual_warning_evidence(
        &mut self,
        request_id: &[u8; 16],
        now: u64,
    ) -> Result<(), ClientError> {
        let now = i64::try_from(now)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "now is out of range"))?;
        self.write(|_, unit| unit.with_conn(|c| {
            let result = (|| -> Result<(), ClientError> {
                let changed = c.execute("UPDATE app_manual_warning_evidence SET state=2 WHERE request_id=?1 AND state=1", [request_id.as_slice()]).map_err(StorageError::from)?;
                if changed == 0 {
                    let state: Option<i64> = c.query_row("SELECT state FROM app_manual_warning_evidence WHERE request_id=?1", [request_id.as_slice()], |r| r.get(0)).optional().map_err(StorageError::from)?;
                    match state { None => return Err(ClientError::new(super::error::E_CORE_NOT_FOUND, "manual warning evidence not found")), Some(2) => (), _ => return Err(ClientError::new(E_CORE_STATE, "warning acceptance is required before completion")) }
                }
                c.execute("DELETE FROM app_manual_warning_evidence WHERE state=2 AND created_at<=?1", [now.saturating_sub(MANUAL_EVIDENCE_RETENTION_SECS as i64)]).map_err(StorageError::from)?;
                Ok(())
            })();
            Ok(result)
        })?)
    }

    fn update_manual_evidence(
        &mut self,
        request_id: &[u8; 16],
        sql: &'static str,
    ) -> Result<(), ClientError> {
        self.write(|_, unit| {
            let result = unit.with_conn(|c| {
                let result = (|| -> Result<(), ClientError> {
                    let changed = c.execute(sql, [request_id.as_slice()]).map_err(StorageError::from)?;
                    if changed == 0 {
                        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM app_manual_removal_evidence WHERE proof_request_id=?1)", [request_id.as_slice()], |r| r.get(0)).map_err(StorageError::from)?;
                        if !exists { return Err(ClientError::new(super::error::E_CORE_NOT_FOUND, "manual removal evidence not found")); }
                    }
                    Ok(())
                })();
                Ok(result)
            })?;
            result
        })
    }

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
