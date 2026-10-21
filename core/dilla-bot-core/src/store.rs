#![allow(unsafe_code)] // geteuid is the Linux ownership check for protected state files.

use rusqlite::{Connection, OpenFlags, params};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use zeroize::{Zeroize, Zeroizing};

const STORE_VERSION: i64 = 1;

pub(crate) fn cbor_shape() -> dilla_core::cbor::CborError {
    dilla_core::cbor::CborError::TypeMismatch {
        expected: "state transaction",
        offset: 0,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("state directory is invalid or insecure")]
    Directory,
    #[error("state file is invalid or insecure")]
    File,
    #[error("state is locked by another helper")]
    Locked,
    #[error("database key is invalid or database cannot be decrypted")]
    Key,
    #[error("stored identity binding does not match")]
    Binding,
    #[error("state store version is unsupported")]
    Version,
    #[error("database operation failed")]
    Database,
}

pub struct Store {
    pub(crate) conn: dilla_core::mls::ConnHandle,
    // Keep the verified directory open and address files through this descriptor.
    // This prevents a later rename or symlink swap in an ancestor from redirecting
    // SQLite or the lock-file checks to another directory.
    _dir: File,
    _lock: File,
}

impl Store {
    pub fn open(
        dir: &Path,
        instance: [u8; 16],
        community: [u8; 16],
        installation: [u8; 16],
        key: &[u8; 32],
    ) -> Result<Self, StoreError> {
        if key.iter().all(|b| *b == 0) {
            return Err(StoreError::Key);
        }
        let dir_fd = secure_dir(dir)?;
        let lock_path = dir.join("state.lock");
        let (lock, _) = secure_file(&lock_path)?;
        lock.try_lock().map_err(|_| StoreError::Locked)?;

        let db_path = dir.join("state.db");
        let (_db, db_created) = secure_file(&db_path)?;
        check_optional_sidecar(&dir.join("state.db-wal"))?;
        check_optional_sidecar(&dir.join("state.db-shm"))?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX;
        let mut conn =
            Connection::open_with_flags(&db_path, flags).map_err(|_| StoreError::Database)?;
        let mut key_hex = Zeroizing::new(String::with_capacity(64));
        for b in key {
            use std::fmt::Write;
            let _ = write!(key_hex, "{b:02x}");
        }
        let mut key_pragma = Zeroizing::new(format!("PRAGMA key = \"x'{}'\"", *key_hex));
        let key_result = conn.execute_batch(&key_pragma).map_err(|_| StoreError::Key);
        key_pragma.zeroize();
        key_result?;
        key_hex.zeroize();
        let cipher: String = conn
            .query_row("PRAGMA cipher_version", [], |r| r.get(0))
            .map_err(|_| StoreError::Key)?;
        if cipher.is_empty() {
            return Err(StoreError::Key);
        }
        let _: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get(0))
            .map_err(|_| StoreError::Key)?;
        conn.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA cipher_memory_security=ON;")
            .map_err(|_| StoreError::Key)?;

        let has_meta: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='bot_helper_meta')", [], |r| r.get(0)).map_err(|_| StoreError::Database)?;
        if !has_meta {
            if !db_created {
                return Err(StoreError::Binding);
            }
            conn.execute_batch(
                "PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
            )
            .map_err(|_| StoreError::Database)?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|_| StoreError::Database)?;
            tx.execute_batch("CREATE TABLE bot_helper_meta (k TEXT PRIMARY KEY, v BLOB NOT NULL); CREATE TABLE bot_state (area INTEGER NOT NULL, key BLOB NOT NULL, revision INTEGER NOT NULL, value BLOB, PRIMARY KEY(area,key)); CREATE TABLE bot_state_receipts (id BLOB PRIMARY KEY, digest BLOB NOT NULL, result BLOB NOT NULL);")
                .map_err(|_| StoreError::Database)?;
            tx.execute("INSERT INTO bot_helper_meta(k,v) VALUES('version',?1),('instance',?2),('community',?3),('installation',?4)", params![STORE_VERSION, instance.as_slice(), community.as_slice(), installation.as_slice()]).map_err(|_| StoreError::Database)?;
            tx.commit().map_err(|_| StoreError::Database)?;
        } else {
            let version: i64 = conn
                .query_row(
                    "SELECT CAST(v AS INTEGER) FROM bot_helper_meta WHERE k='version'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| StoreError::Version)?;
            if version != STORE_VERSION {
                return Err(StoreError::Version);
            }
            let found: (Vec<u8>, Vec<u8>, Vec<u8>) = conn.query_row("SELECT (SELECT v FROM bot_helper_meta WHERE k='instance'),(SELECT v FROM bot_helper_meta WHERE k='community'),(SELECT v FROM bot_helper_meta WHERE k='installation')", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_| StoreError::Binding)?;
            if found.0.as_slice() != instance
                || found.1.as_slice() != community
                || found.2.as_slice() != installation
            {
                return Err(StoreError::Binding);
            }
            for name in ["bot_state", "bot_state_receipts"] {
                let exists: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                        [name],
                        |r| r.get(0),
                    )
                    .map_err(|_| StoreError::Database)?;
                if !exists {
                    return Err(StoreError::Version);
                }
            }
            conn.execute_batch(
                "PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
            )
            .map_err(|_| StoreError::Database)?;
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            _dir: dir_fd,
            _lock: lock,
        })
    }

    pub(crate) fn bind(&self) -> ([u8; 16], [u8; 16], [u8; 16]) {
        let conn = self.conn.lock().expect("single-threaded store lock");
        let read = |k: &str| {
            conn.query_row("SELECT v FROM bot_helper_meta WHERE k=?1", [k], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .expect("validated metadata")
        };
        (
            read("instance").try_into().expect("validated instance"),
            read("community").try_into().expect("validated community"),
            read("installation")
                .try_into()
                .expect("validated installation"),
        )
    }
}

fn secure_dir(path: &Path) -> Result<File, StoreError> {
    if !path.is_absolute() {
        return Err(StoreError::Directory);
    }
    let mut cursor = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => cursor.push("/"),
            Component::Normal(p) => {
                cursor.push(p);
                let m = match fs::symlink_metadata(&cursor) {
                    Ok(m) => m,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return Err(StoreError::Directory),
                };
                if m.file_type().is_symlink() || !m.is_dir() {
                    return Err(StoreError::Directory);
                }
                // A sticky shared directory such as /tmp is safe for a private
                // child; other writable ancestors permit path replacement.
                if m.mode() & 0o022 != 0 && m.mode() & 0o1000 == 0 {
                    return Err(StoreError::Directory);
                }
            }
            Component::CurDir => {}
            _ => return Err(StoreError::Directory),
        }
    }
    if !path.exists() {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| StoreError::Directory)?;
    }
    let m = fs::symlink_metadata(path).map_err(|_| StoreError::Directory)?;
    if !m.is_dir()
        || m.file_type().is_symlink()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o777 != 0o700
    {
        return Err(StoreError::Directory);
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| StoreError::Directory)?;
    let m = directory.metadata().map_err(|_| StoreError::Directory)?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o777 != 0o700 {
        return Err(StoreError::Directory);
    }
    Ok(directory)
}

fn secure_file(path: &Path) -> Result<(File, bool), StoreError> {
    let (file, created) = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(f) => (f, true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (
            OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
                .map_err(|_| StoreError::File)?,
            false,
        ),
        Err(_) => return Err(StoreError::File),
    };
    let m = file.metadata().map_err(|_| StoreError::File)?;
    if !m.is_file() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o777 != 0o600 {
        return Err(StoreError::File);
    }
    Ok((file, created))
}

fn check_optional_sidecar(path: &Path) -> Result<(), StoreError> {
    match fs::symlink_metadata(path) {
        Ok(m)
            if m.file_type().is_symlink()
                || !m.is_file()
                || m.uid() != unsafe { libc::geteuid() }
                || m.mode() & 0o777 != 0o600 =>
        {
            Err(StoreError::File)
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(StoreError::File),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "dilla-store-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        p
    }
    fn open(p: &Path) -> Result<Store, StoreError> {
        Store::open(p, [1; 16], [2; 16], [3; 16], &[0x41; 32])
    }

    #[test]
    fn store_lock_and_identity_binding_are_exclusive() {
        let p = dir();
        let first = open(&p).unwrap();
        assert!(matches!(open(&p), Err(StoreError::Locked)));
        drop(first);
        drop(open(&p).unwrap());
        assert!(matches!(
            Store::open(&p, [1; 16], [9; 16], [3; 16], &[0x41; 32]),
            Err(StoreError::Binding)
        ));
        let _ = fs::remove_dir_all(p);
    }

    #[test]
    fn absent_state_directory_is_created_with_private_mode() {
        let parent = dir();
        let path = parent.join("helper-state");
        let s = open(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        drop(s);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn insecure_directory_database_sidecar_and_symlink_are_refused() {
        let p = dir();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o711)).unwrap();
        assert!(matches!(open(&p), Err(StoreError::Directory)));
        let _ = fs::remove_dir_all(p);
        let p = dir();
        let db = p.join("state.db");
        fs::write(&db, b"untrusted").unwrap();
        fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(open(&p), Err(StoreError::File)));
        let _ = fs::remove_dir_all(p);
        let p = dir();
        let wal = p.join("state.db-wal");
        fs::write(&wal, b"untrusted").unwrap();
        fs::set_permissions(&wal, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(open(&p), Err(StoreError::File)));
        let _ = fs::remove_dir_all(p);
        let p = dir();
        let shm = p.join("state.db-shm");
        fs::write(&shm, b"untrusted").unwrap();
        fs::set_permissions(&shm, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(open(&p), Err(StoreError::File)));
        let _ = fs::remove_dir_all(p);
        let p = dir();
        let lock = p.join("state.lock");
        fs::write(&lock, b"untrusted").unwrap();
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(open(&p), Err(StoreError::File)));
        let _ = fs::remove_dir_all(p);
        let p = dir();
        let target = p.join("elsewhere");
        fs::write(&target, b"untrusted").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&target, p.join("state.db")).unwrap();
        assert!(matches!(open(&p), Err(StoreError::File)));
        let _ = fs::remove_dir_all(p);
    }

    #[test]
    fn preexisting_unbound_encrypted_database_is_not_adopted() {
        let p = dir();
        let db = p.join("state.db");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("PRAGMA key = \"x'4141414141414141414141414141414141414141414141414141414141414141'\"; CREATE TABLE foreign_state(value BLOB);").unwrap();
        drop(c);
        fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(open(&p), Err(StoreError::Binding)));
        let verify = Connection::open(&db).unwrap();
        verify.execute_batch("PRAGMA key = \"x'4141414141414141414141414141414141414141414141414141414141414141'\"").unwrap();
        assert_eq!(
            verify
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name='foreign_state'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(verify);
        let _ = fs::remove_dir_all(p);
    }

    #[test]
    fn preexisting_plaintext_database_is_refused_without_modification() {
        use sha2::{Digest, Sha256};

        let p = dir();
        let db = p.join("state.db");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE plaintext_marker(value TEXT); INSERT INTO plaintext_marker VALUES('keep');")
            .unwrap();
        drop(c);
        fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
        let before = Sha256::digest(fs::read(&db).unwrap()).to_vec();
        assert!(matches!(
            open(&p),
            Err(StoreError::Key | StoreError::Binding)
        ));
        assert_eq!(Sha256::digest(fs::read(&db).unwrap()).as_slice(), before);
        let verify = Connection::open(&db).unwrap();
        assert_eq!(
            verify
                .query_row("SELECT value FROM plaintext_marker", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        drop(verify);
        let _ = fs::remove_dir_all(p);
    }

    #[test]
    fn refused_version_and_binding_leave_database_bytes_and_journal_mode_untouched() {
        use sha2::{Digest, Sha256};

        fn hash(path: &Path) -> Vec<u8> {
            Sha256::digest(fs::read(path).unwrap()).to_vec()
        }
        fn assert_unchanged(change: &str, expected: StoreError) {
            let p = dir();
            drop(open(&p).unwrap());
            let db = p.join("state.db");
            {
                let c = Connection::open(&db).unwrap();
                c.execute_batch("PRAGMA key = \"x'4141414141414141414141414141414141414141414141414141414141414141'\"; PRAGMA journal_mode=DELETE;")
                    .unwrap();
                c.execute_batch(change).unwrap();
            }
            let before = hash(&db);
            assert!(
                matches!(open(&p), Err(e) if std::mem::discriminant(&e) == std::mem::discriminant(&expected))
            );
            assert_eq!(hash(&db), before);
            let verify = Connection::open(&db).unwrap();
            verify.execute_batch("PRAGMA key = \"x'4141414141414141414141414141414141414141414141414141414141414141'\"").unwrap();
            let mode: String = verify
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode, "delete");
            drop(verify);
            let _ = fs::remove_dir_all(p);
        }

        assert_unchanged(
            "UPDATE bot_helper_meta SET v=99 WHERE k='version'",
            StoreError::Version,
        );
        assert_unchanged(
            "UPDATE bot_helper_meta SET v=zeroblob(16) WHERE k='community'",
            StoreError::Binding,
        );
    }
}
