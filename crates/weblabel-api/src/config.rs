use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};

use annotation_domain::{ApiError, Id};

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    pub database_url: String,
    pub object_root: std::path::PathBuf,
    pub write_timeout: Duration,
    pub production: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 48100),
            database_url: "sqlite:weblabel.db".to_owned(),
            object_root: std::path::PathBuf::from("objects"),
            write_timeout: Duration::from_secs(2),
            production: true,
        }
    }
}

impl ServerConfig {
    pub fn validate(&self) -> Result<(), ApiError> {
        let invalid = if self.production && !self.bind.ip().is_loopback() {
            Some((
                "NON_LOOPBACK_BIND",
                "Production server must bind to a loopback address",
            ))
        } else if self.write_timeout.is_zero() {
            Some((
                "INVALID_WRITE_TIMEOUT",
                "SQLite write timeout must be greater than zero",
            ))
        } else {
            None
        };
        if let Some((code, message)) = invalid {
            return Err(ApiError {
                code: code.to_owned(),
                message: message.to_owned(),
                request_id: Id::from("config"),
                details: None,
            });
        }
        Ok(())
    }
}
