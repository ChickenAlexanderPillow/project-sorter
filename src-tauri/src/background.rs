//! Filesystem and credential operations belong on the blocking worker pool,
//! never on the window thread or the async network executor.
pub async fn run<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn work_runs_off_the_calling_thread_and_preserves_its_result() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(super::run(|| std::thread::current().id())).unwrap();
        assert_ne!(caller, worker);
        let result: Result<(), &str> = tauri::async_runtime::block_on(super::run(|| Err("offline"))).unwrap();
        assert_eq!(result, Err("offline"));
    }
}
