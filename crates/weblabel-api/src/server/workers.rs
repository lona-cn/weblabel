use std::{net::SocketAddr, sync::Arc, time::Duration};
use crate::{AppState, jobs::{model_jobs::{self, RunDriver, RunOutcome, RunRunner, RunnerError}, queue::JobQueue}, runtime::{config::{configuration_location_from_environment, ProfileConfiguration, RuntimeConfigurationError}, runner::ProductionRunner}};
use std::{future::Future, pin::Pin};

struct ServiceRunner { production: Result<Arc<ProductionRunner>, RunnerError>, mock: Option<model_jobs::MockRunner> }
impl RunRunner for ServiceRunner {
    fn execute<'a>(&'a self, driver: &'a RunDriver) -> Pin<Box<dyn Future<Output = Result<RunOutcome, RunnerError>> + Send + 'a>> {
        if driver.profile().provider_id == annotation_domain::ProviderId::Mock {
            if let Some(mock) = &self.mock { return mock.execute(driver); }
        }
        match &self.production {
            Ok(production) => production.execute(driver),
            Err(error) => Box::pin(std::future::ready(Err(error.clone()))),
        }
    }
}

pub fn configure(state: &mut AppState, address: SocketAddr) -> Result<Arc<ProductionRunner>, RunnerError> {
    let configuration = match configuration_location_from_environment() {
        Ok(Some(location)) => ProductionRunner::new(
            state.repository.clone(), address, &location.path, &location.allowed_secret_env,
            state.run_tokens.clone(), Duration::from_secs(300),
        ),
        Ok(None) => {
            state.profile_configuration = ProfileConfiguration::Native(Ok(None));
            return Ok(Arc::new(ProductionRunner::unconfigured(state.run_tokens.clone())));
        }
        Err(_) => Err(RunnerError::new("RUNTIME_CONFIGURATION_UNAVAILABLE", "Native runtime configuration is invalid")),
    };
    match configuration {
        Ok(runner) => {
            state.profile_configuration = ProfileConfiguration::Native(Ok(runner.configuration().cloned()));
            Ok(Arc::new(runner))
        }
        Err(error) => {
            state.profile_configuration = ProfileConfiguration::Native(Err(RuntimeConfigurationError));
            Err(error)
        }
    }
}


pub fn start(state: &AppState, production: Result<Arc<ProductionRunner>, RunnerError>, shutdown: tokio::sync::watch::Receiver<bool>) -> Vec<tokio::task::JoinHandle<()>> {
    let mut workers = Vec::with_capacity(3);
    let model_runner = Arc::new(ServiceRunner { production, mock: state.allow_mock_runs.then(model_jobs::MockRunner::standard) });
    for kind in 0..3 {
        let repository = state.repository.clone();
        let queue = JobQueue::new(repository.clone());
        let runner = (kind == 2).then(|| Arc::clone(&model_runner));
        let mut shutdown = shutdown.clone();
        let manual = kind == 2 && cfg!(debug_assertions) && std::env::var("WEBLABEL_TEST_MANUAL_MODEL_WORKER").as_deref() == Ok("1");
        workers.push(tokio::spawn(async move {
            if manual { while !*shutdown.borrow() { if shutdown.changed().await.is_err() { break; } } return; }
            loop {
                if *shutdown.borrow() { break; }
                // Never cancel an in-flight job future: its transaction and owned work must settle.
                let result = match kind {
                    0 => model_jobs::process_dataset_export_next(&repository, &queue, "native-export-worker").await,
                    1 => model_jobs::process_media_import_next(&repository, &queue, "native-media-worker").await,
                    _ => model_jobs::process_model_next(&repository, &queue, "native-model-worker", Duration::from_secs(300), runner.as_deref().expect("model worker owns its runner")).await,
                };
                let delay = match result {
                    Ok(Some(_)) => continue,
                    Ok(None) => Duration::from_millis(500),
                    Err(_) => { tracing::error!(code="NATIVE_WORKER_FAILED", worker_kind=kind, "background job failed"); Duration::from_secs(2) }
                };
                tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = shutdown.changed() => {} }
            }
        }));
    }
    workers
}
