use std::{error::Error, fs, path::Path};

use annotation_domain::{
    ActivityCheckpoint, ActivityInterval, ActivityKind, ActivitySession, ActivitySessionPage,
    AiApprovedGrants, AiConsentRequest, AiConsentResponse, AiPreviewRequest, AiPreviewResponse,
    AnnotationDocument, AnnotationRevision, ApiError, BootstrapMode, BootstrapStatus,
    EditorCommand, EditorDelta, ExternalProcessingPolicy, MediaRevision, ModelProfile,
    OntologyVersion, RunEvent, SaveRequest, SaveResponse, StartRunRequest, SuggestionSet,
};
use schemars::JsonSchema;
use serde::Serialize;
use ts_rs::TS;

fn write_schema<T: JsonSchema>(directory: &Path, file: &str) -> Result<(), Box<dyn Error>> {
    let schema = schemars::schema_for!(T);
    write_json(directory, file, &schema)
}

fn write_json<T: Serialize>(directory: &Path, file: &str, value: &T) -> Result<(), Box<dyn Error>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    fs::write(directory.join(file), bytes)?;
    Ok(())
}

/// Generate the committed wire artifacts exclusively from annotation-domain Rust declarations.
pub fn generate(output: &Path) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(output)?;
    BootstrapMode::export_all_to(output)?;
    BootstrapStatus::export_all_to(output)?;
    write_schema::<BootstrapStatus>(output, "bootstrap_status.schema.json")?;
    ActivityKind::export_all_to(output)?;
    ActivityInterval::export_all_to(output)?;
    ActivityCheckpoint::export_all_to(output)?;
    ActivitySession::export_all_to(output)?;
    ActivitySessionPage::export_all_to(output)?;
    AnnotationDocument::export_all_to(output)?;
    OntologyVersion::export_all_to(output)?;
    MediaRevision::export_all_to(output)?;
    AnnotationRevision::export_all_to(output)?;
    SaveRequest::export_all_to(output)?;
    SaveResponse::export_all_to(output)?;
    ApiError::export_all_to(output)?;
    ModelProfile::export_all_to(output)?;
    StartRunRequest::export_all_to(output)?;
    SuggestionSet::export_all_to(output)?;
    RunEvent::export_all_to(output)?;
    EditorCommand::export_all_to(output)?;
    EditorDelta::export_all_to(output)?;
    AiApprovedGrants::export_all_to(output)?;
    AiPreviewRequest::export_all_to(output)?;
    AiPreviewResponse::export_all_to(output)?;
    AiConsentRequest::export_all_to(output)?;
    AiConsentResponse::export_all_to(output)?;
    ExternalProcessingPolicy::export_all_to(output)?;

    write_schema::<AnnotationDocument>(output, "annotation_document.schema.json")?;
    write_schema::<ActivityCheckpoint>(output, "activity_checkpoint.schema.json")?;
    write_schema::<ActivitySession>(output, "activity_session.schema.json")?;
    write_schema::<ActivitySessionPage>(output, "activity_session_page.schema.json")?;
    write_schema::<OntologyVersion>(output, "ontology_version.schema.json")?;
    write_schema::<MediaRevision>(output, "media_revision.schema.json")?;
    write_schema::<AnnotationRevision>(output, "annotation_revision.schema.json")?;
    write_schema::<SaveRequest>(output, "save_request.schema.json")?;
    write_schema::<SaveResponse>(output, "save_response.schema.json")?;
    write_schema::<ApiError>(output, "api_error.schema.json")?;
    write_schema::<ModelProfile>(output, "model_profile.schema.json")?;
    write_schema::<StartRunRequest>(output, "start_run_request.schema.json")?;
    write_schema::<SuggestionSet>(output, "suggestion_set.schema.json")?;
    write_schema::<RunEvent>(output, "run_event.schema.json")?;
    write_schema::<EditorCommand>(output, "editor_command.schema.json")?;
    write_schema::<EditorDelta>(output, "editor_delta.schema.json")?;
    write_schema::<AiApprovedGrants>(output, "ai_approved_grants.schema.json")?;
    write_schema::<AiPreviewRequest>(output, "ai_preview_request.schema.json")?;
    write_schema::<AiPreviewResponse>(output, "ai_preview_response.schema.json")?;
    write_schema::<AiConsentRequest>(output, "ai_consent_request.schema.json")?;
    write_schema::<AiConsentResponse>(output, "ai_consent_response.schema.json")?;
    write_schema::<ExternalProcessingPolicy>(output, "external_processing_policy.schema.json")?;
    Ok(())
}

/// Check mode writes into a caller-owned temporary directory; callers compare that tree to the committed artifacts.
pub fn check(committed: &Path, temporary: &Path) -> Result<bool, Box<dyn Error>> {
    if temporary.exists() {
        return Err("contract output directory must be a fresh temporary path".into());
    }
    generate(temporary)?;
    let mut expected = fs::read_dir(committed)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut actual = fs::read_dir(temporary)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()?;
    expected.sort();
    actual.sort();
    if expected != actual {
        return Ok(false);
    }
    for filename in expected {
        if fs::read(committed.join(&filename))? != fs::read(temporary.join(&filename))? {
            return Ok(false);
        }
    }
    Ok(true)
}
