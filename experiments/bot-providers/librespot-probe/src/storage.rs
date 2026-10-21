#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_dir() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("dilla-probe-{}-{n}", std::process::id()));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        p
    }

    #[test]
    fn creates_private_state_and_rejects_symlink_or_loose_state() {
        let root = temp_dir();
        let state = root.join("state");
        ensure_state_dir(&state).unwrap();
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let loose = root.join("loose");
        fs::create_dir(&loose).unwrap();
        assert!(ensure_state_dir(&loose).is_err());
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(ensure_state_dir(&link).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn protected_file_read_rejects_symlink_and_oversize() {
        let root = temp_dir();
        let good = root.join("good");
        write_new(&good, b"small").unwrap();
        assert_eq!(read_protected(&good, MAX_FILE_BYTES).unwrap(), b"small");
        let target = root.join("target");
        write_new(&target, b"ok").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read_protected(&link, MAX_FILE_BYTES).is_err());
        let fifo = root.join("fifo");
        nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
        assert!(read_protected(&fifo, MAX_FILE_BYTES).is_err());
        let large = root.join("large");
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&large)
            .unwrap();
        f.write_all(&vec![0; MAX_FILE_BYTES + 1]).unwrap();
        assert!(read_protected(&large, MAX_FILE_BYTES).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_write_is_private_and_round_trips() {
        let root = temp_dir();
        let path = root.join("credentials.json");
        atomic_write(&path, b"{}\n").unwrap();
        assert_eq!(read_protected(&path, MAX_FILE_BYTES).unwrap(), b"{}\n");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(write_new(&path, b"replace").is_err());
        let target = root.join("target");
        write_new(&target, b"safe").unwrap();
        let link = root.join("credential-link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(atomic_write(&link, b"replace").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn consume_removes_a_pending_file_before_reuse() {
        let root = temp_dir();
        let pending = root.join("pending.json");
        write_new(&pending, b"pending").unwrap();
        assert_eq!(consume(&pending).unwrap(), b"pending");
        assert!(consume(&pending).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub const MAX_FILE_BYTES: usize = 64 * 1024;

pub fn ensure_state_dir(path: &Path) -> Result<(), &'static str> {
    let created = match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => return Err("storage unavailable"),
    };
    let dir = open_dir(path)?;
    if created {
        dir.set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "storage unavailable")?;
    }
    validate_private_dir(&dir)?;
    drop(dir);
    Ok(())
}

pub fn read_protected(path: &Path, limit: usize) -> Result<Vec<u8>, &'static str> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "storage unavailable")?;
    fd_is_owned_private_regular(&file)?;
    let len = file.metadata().map_err(|_| "storage unavailable")?.len();
    if len > limit as u64 {
        return Err("storage unavailable");
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take((limit as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "storage unavailable")?;
    if bytes.len() > limit {
        return Err("storage unavailable");
    }
    Ok(bytes)
}

pub fn write_new(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err("storage unavailable");
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "storage unavailable")?;
    normalize_new_private_file(&file)?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    if result.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err("storage unavailable");
    }
    Ok(())
}

pub fn consume(path: &Path) -> Result<Vec<u8>, &'static str> {
    let bytes = read_protected(path, MAX_FILE_BYTES)?;
    std::fs::remove_file(path).map_err(|_| "storage unavailable")?;
    Ok(bytes)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err("storage unavailable");
    }
    let parent = path.parent().ok_or("storage unavailable")?;
    let _dir = open_private_dir(parent)?;
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            read_protected(path, MAX_FILE_BYTES)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("storage unavailable"),
    }
    let mut temp = None;
    for _ in 0..8 {
        let suffix: u64 = rand::random();
        let candidate = parent.join(format!(".dilla-probe-{suffix:016x}.tmp"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&candidate)
        {
            Ok(mut file) => {
                if normalize_new_private_file(&file).is_err() {
                    drop(file);
                    let _ = std::fs::remove_file(&candidate);
                    return Err("storage unavailable");
                }
                if file.write_all(bytes).is_err() || file.sync_all().is_err() {
                    drop(file);
                    let _ = std::fs::remove_file(&candidate);
                    return Err("storage unavailable");
                }
                temp = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("storage unavailable"),
        }
    }
    let temp = temp.ok_or("storage unavailable")?;
    let result: Result<(), &'static str> = (|| {
        std::fs::rename(&temp, path).map_err(|_| "storage unavailable")?;
        _dir.sync_all().map_err(|_| "storage unavailable")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result?;
    Ok(())
}

pub fn initialize_private_tmp(state: &Path) -> Result<PathBuf, &'static str> {
    ensure_state_dir(state)?;
    let path = state.join("tmp");
    ensure_state_dir(&path)?;
    Ok(path)
}

fn open_private_dir(path: &Path) -> Result<File, &'static str> {
    let dir = open_dir(path)?;
    validate_private_dir(&dir)?;
    Ok(dir)
}

fn open_dir(path: &Path) -> Result<File, &'static str> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "storage unavailable")?;
    Ok(file)
}

fn validate_private_dir(file: &File) -> Result<(), &'static str> {
    let metadata = file.metadata().map_err(|_| "storage unavailable")?;
    let uid = nix::unistd::geteuid().as_raw();
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o777 != 0o700 {
        return Err("storage unavailable");
    }
    Ok(())
}

fn fd_is_owned_private_regular(file: &File) -> Result<(), &'static str> {
    let metadata = file.metadata().map_err(|_| "storage unavailable")?;
    let uid = nix::unistd::geteuid().as_raw();
    if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o777 != 0o600 {
        return Err("storage unavailable");
    }
    Ok(())
}

fn normalize_new_private_file(file: &File) -> Result<(), &'static str> {
    let metadata = file.metadata().map_err(|_| "storage unavailable")?;
    if !metadata.is_file() || metadata.uid() != nix::unistd::geteuid().as_raw() {
        return Err("storage unavailable");
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| "storage unavailable")?;
    fd_is_owned_private_regular(file)
}
