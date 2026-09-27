pub(crate) mod export;
pub mod snapshot;
pub mod split;

use crate::{auth::AuthState, storage::Repository};
use axum::{middleware, routing::post, Router};

#[derive(Clone)]
pub struct DatasetState {
    pub(crate) repository: Repository,
}

pub fn router(repository: Repository, auth: AuthState) -> Router {
    let state = DatasetState { repository };
    Router::new()
        .route(
            "/api/projects/{project_id}/dataset-versions",
            post(snapshot::create),
        )
        .route(
            "/api/dataset-versions/{dataset_version_id}/exports",
            post(export::create),
        )
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            crate::auth::authenticate,
        ))
        .route_layer(middleware::from_fn_with_state(
            auth,
            crate::auth::csrf_and_origin,
        ))
        .with_state(state)
}
