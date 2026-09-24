//! `OpenMlsProvider` = `openmls_rust_crypto::RustCrypto` (crypto and randomness) plus dilla's own
//! storage. `RustCrypto` implements `OpenMlsCrypto` and `OpenMlsRand` and is `Default`, so the
//! composition needs no fork of anything upstream.

use super::{ConnHandle, DillaStorage};
use openmls_rust_crypto::RustCrypto;

pub struct DillaProvider {
    crypto: RustCrypto,
    storage: DillaStorage,
}

impl DillaProvider {
    pub fn new(conn: ConnHandle) -> Self {
        Self {
            crypto: RustCrypto::default(),
            storage: DillaStorage::new(conn),
        }
    }

    pub fn storage(&self) -> &DillaStorage {
        &self.storage
    }
}

impl openmls_traits::OpenMlsProvider for DillaProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = DillaStorage;

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }
}
