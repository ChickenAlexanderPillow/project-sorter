use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
};

/// Report actual bytes written, and never leave a partial copy on failure.
pub(crate) fn copy(
    source: &Path,
    destination: &Path,
    mut progress: impl FnMut(u64),
) -> io::Result<u64> {
    let mut input = fs::File::open(source)?;
    let metadata = input.metadata()?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = (|| {
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut copied = 0u64;
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            copied += count as u64;
            progress(copied);
        }
        output.sync_all()?;
        filetime::set_file_mtime(destination, filetime::FileTime::from_last_modification_time(&metadata))?;
        fs::set_permissions(destination, metadata.permissions())?;
        Ok(copied)
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_intermediate_bytes_and_preserves_source_and_existing_destinations() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.mov");
        let destination = temp.path().join("copy.mov");
        let data = vec![73u8; 3 * 1024 * 1024 + 17];
        fs::write(&source, &data).unwrap();
        let mut updates = vec![];
        assert_eq!(
            copy(&source, &destination, |bytes| updates.push(bytes)).unwrap(),
            data.len() as u64
        );
        assert!(updates.len() > 1);
        assert!(updates.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(updates.last().copied(), Some(data.len() as u64));
        assert_eq!(fs::read(&destination).unwrap(), data);
        assert_eq!(fs::read(&source).unwrap(), data);
        assert!(copy(&source, &destination, |_| {}).is_err());
        assert_eq!(fs::read(&destination).unwrap(), data);
    }

    #[test]
    fn background_transfer_finishes_after_progress_observer_disconnects() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.mov");
        let destination = temp.path().join("copy.mov");
        let data = vec![29u8; 3 * 1024 * 1024];
        fs::write(&source, &data).unwrap();
        let (updates, observer) = std::sync::mpsc::channel();
        let (resume, wait) = std::sync::mpsc::channel();
        let target = destination.clone();
        let worker = std::thread::spawn(move || copy(&source, &target, |bytes| {
            let _ = updates.send(bytes);
            if bytes == 1024 * 1024 { wait.recv().unwrap(); }
        }));
        assert_eq!(observer.recv().unwrap(), 1024 * 1024);
        drop(observer);
        resume.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), data.len() as u64);
        assert_eq!(fs::read(destination).unwrap(), data);
    }
}
