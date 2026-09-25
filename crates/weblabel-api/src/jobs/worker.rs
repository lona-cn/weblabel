use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::media::{
    canonical::{canonicalize_bytes_with_mime, CanonicalImage},
    limits::MediaError,
};

#[derive(Clone)]
pub struct MediaWorker {
    job_slots: Arc<Semaphore>,
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
            job_slots: Arc::new(Semaphore::new(2)),
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
    pub async fn process_next(
        &self,
        repository: &crate::storage::Repository,
        queue: &super::queue::JobQueue,
        worker_id: &str,
        lease_for: std::time::Duration,
    ) -> Result<Option<String>, super::queue::QueueError> {
        let _job = self
            .job_slots
            .acquire()
            .await
            .map_err(|_| super::queue::QueueError::InvalidRequest)?;
        let Some(lease) = queue.lease_next(worker_id, lease_for).await? else {
            return Ok(None);
        };
        let job_id = lease.job_id.clone();
        if lease.kind == "media_import" {
            crate::media::ingest::process_import_job(repository, self, queue, &lease).await?;
        } else {
            queue
                .finish(
                    &lease,
                    false,
                    &serde_json::json!({"code":"UNSUPPORTED_JOB_KIND"}),
                )
                .await?;
        }
        Ok(Some(job_id))
    }
}
