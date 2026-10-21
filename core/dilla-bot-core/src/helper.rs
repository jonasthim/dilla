use crate::transfer::{self, Command as TransferCommand, Transfer};
use crate::{
    state::{self, StateError},
    store::{Store, StoreError},
};
use dilla_core::{
    bot::{HELPER_MAX, HELPER_PAYLOAD_MAX, HelperRequest, HelperResponse},
    cbor::{Encoder, decode_strict},
    client::ClientCore,
    ids::MsgId,
};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, thiserror::Error)]
pub enum HelperError {
    #[error("invalid helper request")]
    Invalid,
    #[error("helper operation is unavailable")]
    Unavailable,
    #[error("helper operation failed")]
    Internal,
}

pub struct Helper {
    state_dir: PathBuf,
    store: Option<Store>,
    core: Option<ClientCore>,
    transfer: Option<Transfer>,
}

impl Helper {
    pub fn new(state_dir: impl AsRef<Path>) -> Self {
        Self {
            state_dir: state_dir.as_ref().to_path_buf(),
            store: None,
            core: None,
            transfer: None,
        }
    }

    pub(crate) fn dispatch(
        &mut self,
        input: &[u8],
    ) -> Result<(u64, Zeroizing<Vec<u8>>, bool), HelperError> {
        let (id, operation, payload) = decode_request(input).map_err(|_| HelperError::Invalid)?;
        let result = self.dispatch_operation(operation, &payload, *id.as_bytes());
        if operation == 16 && matches!(result, Err(DispatchError::Invalid)) {
            self.transfer = None;
        }
        let (status, payload, shutdown) = match result {
            Ok((body, stop)) => (0, body, stop),
            Err(DispatchError::Invalid) => (1, empty(), false),
            Err(DispatchError::Conflict) => (4, empty(), false),
            Err(DispatchError::Unavailable) => (5, empty(), false),
            Err(DispatchError::Busy) => (6, empty(), false),
            Err(DispatchError::Upgrade) => (8, empty(), false),
            Err(DispatchError::Internal) => (9, empty(), false),
        };
        let mut response = HelperResponse {
            request_id: id,
            status,
            payload: payload.to_vec(),
        };
        let encoded = match response.encode() {
            Ok(encoded) => encoded,
            Err(_) => {
                response.payload.zeroize();
                return Err(HelperError::Internal);
            }
        };
        response.payload.zeroize();
        Ok((status, Zeroizing::new(encoded), shutdown))
    }

    fn dispatch_operation(
        &mut self,
        op: u64,
        payload: &[u8],
        request_id: [u8; 16],
    ) -> Result<(Zeroizing<Vec<u8>>, bool), DispatchError> {
        if self.transfer.is_some()
            && op != 15
            && op != 16
            && !(op == 6 && self.transfer.as_ref().is_some_and(Transfer::is_running))
        {
            return Err(DispatchError::Busy);
        }
        if op == 1 {
            return self.open(payload).map(|b| (b, false));
        }
        if op == 15 {
            decode_strict(payload, |d| {
                d.array(0)?;
                Ok(())
            })
            .map_err(|_| DispatchError::Invalid)?;
            if self.core.is_none() {
                return Err(DispatchError::Invalid);
            }
            return Ok((empty(), true));
        }
        if self.core.is_none() {
            return Err(DispatchError::Invalid);
        }
        match op {
            2 => self.bootstrap(payload),
            3 => self.complete(payload),
            4 => self.session(payload),
            5 => self.key_packages(payload),
            10 => self.removal(payload),
            11 => state::get(self.store.as_ref().expect("opened"), payload)
                .map(|v| (Zeroizing::new(v), false))
                .map_err(Into::into),
            12 => state::transaction(self.store.as_mut().expect("opened"), payload)
                .map(|v| (Zeroizing::new(v), false))
                .map_err(Into::into),
            6 | 7 | 8 | 9 | 13 | 14 => Err(DispatchError::Unavailable),
            16 => self.group_transfer(payload, request_id),
            _ => Err(DispatchError::Invalid),
        }
    }

    fn group_transfer(
        &mut self,
        payload: &[u8],
        request_id: [u8; 16],
    ) -> Result<(Zeroizing<Vec<u8>>, bool), DispatchError> {
        let command = transfer::decode_command(payload).map_err(|_| DispatchError::Invalid)?;
        let now = Instant::now();
        if self.transfer.as_ref().is_some_and(|t| t.expired(now)) {
            self.transfer = None;
        }
        match command {
            TransferCommand::Begin { len, digest } => {
                if self.transfer.is_some() {
                    return Err(DispatchError::Busy);
                }
                let (transfer, id) = Transfer::begin(request_id, len, digest, now)
                    .map_err(|_| DispatchError::Invalid)?;
                self.transfer = Some(transfer);
                Ok((transfer::enc_id(&id), false))
            }
            TransferCommand::Chunk { id, offset, bytes } => {
                let transfer = self.transfer.as_mut().ok_or(DispatchError::Invalid)?;
                let next = transfer
                    .append(id, offset, &bytes, now)
                    .map_err(|_| DispatchError::Invalid)?;
                Ok((transfer::enc_next(next), false))
            }
            TransferCommand::Execute { id } => {
                let mut transfer = self.transfer.take().ok_or(DispatchError::Invalid)?;
                let descriptor = transfer.execute_with(id, now, |input| {
                    match self.dispatch_operation(6, input, request_id) {
                        Ok((body, _)) => (0, body),
                        Err(error) => (dispatch_status(error), empty()),
                    }
                });
                self.transfer = Some(transfer);
                let (target_status, len, digest) =
                    descriptor.map_err(|_| DispatchError::Invalid)?;
                Ok((transfer::enc_descriptor(target_status, len, &digest), false))
            }
            TransferCommand::Read { id, offset, len } => {
                let transfer = self.transfer.as_mut().ok_or(DispatchError::Invalid)?;
                let bytes = transfer
                    .read(id, offset, len, now)
                    .map_err(|_| DispatchError::Invalid)?;
                Ok((transfer::enc_chunk(&bytes), false))
            }
            TransferCommand::Drop { id } => {
                if !self.transfer.as_ref().is_some_and(|t| t.drop_id(&id)) {
                    return Err(DispatchError::Invalid);
                }
                self.transfer = None;
                Ok((transfer::enc_empty(), false))
            }
        }
    }

    pub(crate) fn expire_transfer(&mut self) {
        if self
            .transfer
            .as_ref()
            .is_some_and(|t| t.expired(Instant::now()))
        {
            self.transfer = None;
        }
    }

    pub(crate) fn transfer_timeout(&self) -> Option<std::time::Duration> {
        self.transfer
            .as_ref()
            .and_then(|t| t.time_left(Instant::now()))
    }

    #[cfg(test)]
    pub(crate) fn test_transfer_deadline(&mut self, deadline: Instant) {
        let digest = [0; 32];
        let (mut transfer, _) = Transfer::begin([1; 16], 1, digest, Instant::now()).unwrap();
        transfer.test_expire_at(deadline);
        self.transfer = Some(transfer);
    }

    #[cfg(test)]
    pub(crate) fn test_completed_transfer_deadline(&mut self, deadline: Instant) {
        let now = Instant::now();
        let input = [0x81, 0x11];
        let digest: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(input).into();
        let (mut transfer, id) = Transfer::begin([1; 16], input.len(), digest, now).unwrap();
        transfer.append(id, 0, &input, now).unwrap();
        transfer
            .execute_with(id, now, |_| (0, Zeroizing::new(vec![0x80])))
            .unwrap();
        transfer.test_expire_at(deadline);
        self.transfer = Some(transfer);
    }

    fn open(&mut self, payload: &[u8]) -> Result<Zeroizing<Vec<u8>>, DispatchError> {
        if self.core.is_some() {
            return Err(DispatchError::Invalid);
        }
        let (instance, community, installation, mut key) = decode_strict(payload, |d| {
            d.array(4)?;
            Ok((
                d.bytes_exact::<16>()?,
                d.bytes_exact::<16>()?,
                d.bytes_exact::<16>()?,
                Zeroizing::new(d.bytes_exact::<32>()?),
            ))
        })
        .map_err(|_| DispatchError::Invalid)?;
        if instance == [0; 16]
            || community == [0; 16]
            || installation == [0; 16]
            || key.iter().all(|b| *b == 0)
        {
            return Err(DispatchError::Invalid);
        }
        let store = Store::open(&self.state_dir, instance, community, installation, &key)
            .map_err(map_store)?;
        key.zeroize();
        let core = ClientCore::open(store.conn.clone()).map_err(map_client)?;
        let identity = core.identity().map_err(map_client)?;
        let mut e = Encoder::new();
        e.array(2).uint(1).bytes(&identity);
        self.store = Some(store);
        self.core = Some(core);
        Ok(Zeroizing::new(e.into_vec()))
    }

    fn bootstrap(&mut self, payload: &[u8]) -> Result<(Zeroizing<Vec<u8>>, bool), DispatchError> {
        let (i, c, n) = decode_strict(payload, |d| {
            d.array(3)?;
            Ok((
                d.bytes_exact::<16>()?,
                d.bytes_exact::<16>()?,
                d.bytes_exact::<16>()?,
            ))
        })
        .map_err(|_| DispatchError::Invalid)?;
        let bind = self.store.as_ref().expect("opened").bind();
        if (i, c, n) != bind {
            return Err(DispatchError::Invalid);
        }
        let v = self
            .core
            .as_mut()
            .expect("opened")
            .bot_bootstrap_begin(&i, &c, &n)
            .map_err(map_client)?;
        Ok((Zeroizing::new(v), false))
    }
    fn complete(&mut self, payload: &[u8]) -> Result<(Zeroizing<Vec<u8>>, bool), DispatchError> {
        let (u, name, now) = decode_strict(payload, |d| {
            d.array(3)?;
            Ok((d.bytes_exact::<16>()?, d.text()?.to_owned(), d.uint()?))
        })
        .map_err(|_| DispatchError::Invalid)?;
        if name.is_empty() || name.len() > 256 {
            return Err(DispatchError::Invalid);
        }
        let v = self
            .core
            .as_mut()
            .expect("opened")
            .bot_bootstrap_complete(&u, &name, now)
            .map_err(map_client)?;
        Ok((Zeroizing::new(v), false))
    }
    fn session(&mut self, payload: &[u8]) -> Result<(Zeroizing<Vec<u8>>, bool), DispatchError> {
        let core = self.core.as_mut().expect("opened");
        let result = decode_strict(payload, |d| {
            let n = d.array_len()?;
            let sub = d.uint()?;
            let v = match (sub, n) {
                (0, 1) => core.identity().map(Some),
                (1, 3) => {
                    let nonce = d.bytes_exact::<32>()?;
                    let purpose = d.uint()?;
                    if purpose > 1 {
                        return Err(crate::store::cbor_shape());
                    }
                    core.session_sign(&nonce, purpose as u8).map(Some)
                }
                (2, 4) => {
                    let token = Zeroizing::new(d.text()?.to_owned());
                    let expires = d.uint()?;
                    let idle = d.uint()?;
                    core.session_store(&token, expires, idle).map(|_| None)
                }
                (3, 1) => core.session().map(Some),
                (4, 1) => core.session_clear().map(|_| None),
                (5, 1) => core.device_list_body().map(Some),
                (6, 1) => core.device_list_published().map(|_| None),
                _ => return Err(crate::store::cbor_shape()),
            };
            v.map_err(|_| crate::store::cbor_shape())
        })
        .map_err(|_| DispatchError::Invalid)?;
        Ok((result.map_or_else(empty, body), false))
    }
    fn key_packages(
        &mut self,
        payload: &[u8],
    ) -> Result<(Zeroizing<Vec<u8>>, bool), DispatchError> {
        let (count, last) = decode_strict(payload, |d| {
            d.array(2)?;
            let c = d.uint()?;
            let l = d.uint()?;
            Ok((c, l))
        })
        .map_err(|_| DispatchError::Invalid)?;
        if !(1..=32).contains(&count) || last > 1 {
            return Err(DispatchError::Invalid);
        }
        let v = self
            .core
            .as_mut()
            .expect("opened")
            .key_packages(count as u32, last == 1)
            .map_err(map_client)?;
        Ok((body(v), false))
    }
    fn removal(&mut self, payload: &[u8]) -> Result<(Zeroizing<Vec<u8>>, bool), DispatchError> {
        let (r, g, seq, expires, now) = decode_strict(payload, |d| {
            d.array(5)?;
            Ok((
                d.bytes_exact::<16>()?,
                d.bytes_exact::<16>()?,
                d.uint()?,
                d.uint()?,
                d.uint()?,
            ))
        })
        .map_err(|_| DispatchError::Invalid)?;
        let v = self
            .core
            .as_mut()
            .expect("opened")
            .sign_removal(&r, &g, seq, expires, now)
            .map_err(map_client)?;
        Ok((Zeroizing::new(v), false))
    }
}

fn decode_request(input: &[u8]) -> Result<(MsgId, u64, Zeroizing<Vec<u8>>), ()> {
    if input.len() > HELPER_MAX {
        return Err(());
    }
    let (raw_id, operation, payload) = decode_strict(input, |d| {
        d.array(4)?;
        if d.uint()? != 1 {
            return Err(crate::store::cbor_shape());
        }
        let raw_id = d.bytes_exact::<16>()?;
        if raw_id == [0; 16] {
            return Err(crate::store::cbor_shape());
        }
        let operation = d.uint()?;
        let payload = d.bytes()?;
        if payload.is_empty() || payload.len() > HELPER_PAYLOAD_MAX {
            return Err(crate::store::cbor_shape());
        }
        decode_strict(payload, |body| {
            body.skip()?;
            Ok(())
        })
        .map_err(|_| crate::store::cbor_shape())?;
        Ok((raw_id, operation, Zeroizing::new(payload.to_vec())))
    })
    .map_err(|_| ())?;
    if (1..=16).contains(&operation) {
        let request = HelperRequest::decode(input).map_err(|_| ())?;
        Ok((
            request.request_id,
            request.operation,
            Zeroizing::new(request.payload),
        ))
    } else {
        Ok((MsgId::from_bytes(raw_id), operation, payload))
    }
}

fn body(mut v: Vec<u8>) -> Zeroizing<Vec<u8>> {
    let mut e = Encoder::new();
    e.array(1).bytes(&v);
    v.zeroize();
    Zeroizing::new(e.into_vec())
}
fn empty() -> Zeroizing<Vec<u8>> {
    let mut e = Encoder::new();
    e.array(0);
    Zeroizing::new(e.into_vec())
}
fn dispatch_status(error: DispatchError) -> u64 {
    match error {
        DispatchError::Invalid => 1,
        DispatchError::Conflict => 4,
        DispatchError::Unavailable => 5,
        DispatchError::Busy => 6,
        DispatchError::Upgrade => 8,
        DispatchError::Internal => 9,
    }
}
#[derive(Debug)]
pub(crate) enum DispatchError {
    Invalid,
    Conflict,
    Unavailable,
    Busy,
    Upgrade,
    Internal,
}
impl From<StateError> for DispatchError {
    fn from(e: StateError) -> Self {
        match e {
            StateError::Invalid => Self::Invalid,
            StateError::Conflict => Self::Conflict,
            StateError::Internal => Self::Internal,
        }
    }
}
fn map_store(e: StoreError) -> DispatchError {
    match e {
        StoreError::Binding => DispatchError::Conflict,
        StoreError::Locked => DispatchError::Busy,
        StoreError::Version => DispatchError::Upgrade,
        StoreError::Database => DispatchError::Internal,
        _ => DispatchError::Invalid,
    }
}
fn map_client(e: dilla_core::client::ClientError) -> DispatchError {
    match e.code {
        "E_STORE_NEWER" => DispatchError::Upgrade,
        "E_CORE_STATE" => DispatchError::Conflict,
        "E_CORE_INPUT" => DispatchError::Invalid,
        "E_CORE_NO_IDENTITY" => DispatchError::Unavailable,
        _ => DispatchError::Internal,
    }
}
