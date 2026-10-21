use librespot::core::Session;

pub struct ShutdownGuard(Session);

impl ShutdownGuard {
    pub fn new(session: Session) -> Self {
        Self(session)
    }

    pub fn session(&self) -> &Session {
        &self.0
    }
}

impl Drop for ShutdownGuard {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use librespot::core::config::SessionConfig;

    #[tokio::test]
    async fn shutdown_guard_invalidates_session_when_post_connect_work_fails() {
        let session = Session::new(SessionConfig::default(), None);
        let observer = session.clone();

        let result: Result<(), &'static str> = {
            let _guard = ShutdownGuard::new(session);
            Err("forced credential persistence failure")
        };

        assert_eq!(result, Err("forced credential persistence failure"));
        assert!(observer.is_invalid());
    }
}
