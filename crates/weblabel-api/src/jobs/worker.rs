use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::media::{
    canonical::{canonicalize_bytes_with_mime, CanonicalImage},
    limits::MediaError,
};

#[derive(Clone)]
pub struct MediaWorker {
    decode_slot: Arc<Semaphore>,
}

impl Default for MediaWorker {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaWorker {
    pub fn new() -> Self {
        Self {
            decode_slot: Arc::new(Semaphore::new(1)),
        }
    }

    pub async fn canonicalize(
        &self,
        bytes: Arc<[u8]>,
        declared_mime: Option<String>,
    ) -> Result<CanonicalImage, MediaError> {
        let _decode = self
            .decode_slot
            .acquire()
            .await
            .map_err(|_| MediaError::Storage)?;
        tokio::task::spawn_blocking(move || {
            canonicalize_bytes_with_mime(&bytes, declared_mime.as_deref())
        })
        .await
        .map_err(|_| MediaError::InvalidImage)?
    }

    pub async fn canonicalize_items(
        &self,
        inputs: Vec<Vec<u8>>,
    ) -> Vec<Result<CanonicalImage, MediaError>> {
        let mut output = Vec::with_capacity(inputs.len());
        for bytes in inputs {
            output.push(self.canonicalize(Arc::from(bytes), None).await);
        }
        output
    }
}
