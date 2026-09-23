use openmls_traits::public_storage::PublicStorageProvider;
use openmls_traits::storage::{CURRENT_VERSION, StorageProvider};

#[derive(Debug, thiserror::Error)]
#[error("both")]
struct BothError;

struct Both;

impl StorageProvider<CURRENT_VERSION> for Both {
    type Error = BothError;
}

impl PublicStorageProvider<CURRENT_VERSION> for Both {
    type PublicError = BothError;
}

fn main() {}
