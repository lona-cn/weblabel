//! Real RunDriver adapter: consent -> authorized image -> owned native worker -> prediction funnel.
use std::{collections::{BTreeMap,BTreeSet},fs::{self,OpenOptions},io::Write,path::{Path,PathBuf},sync::atomic::{AtomicBool,Ordering},time::Duration};
use annotation_domain::{AiApprovedGrants,ModelProfile,ProviderId,RunEventType};
use serde::Deserialize;
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use sqlx::Row;
use crate::{ai::{consent,runs::{self,RunRecord}},jobs::model_jobs::{ModelJobError,ProviderEvent,RunDriver,RunOutcome,RunnerError,SubmitCandidates},runtime::{agent_tools::{AgentToolService,AgentToolOutput,AuthorizedRegion},config::RuntimeConfig,run_tokens::RunTokenStore},storage::Repository};
use super::{Cancellation,DetectorError,DetectorPool,Projection,WorkerInput,WorkerRequest,MODEL_ID,WINDOWS_CPU_DLL_SHA256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {profile_id:String,lock_path:PathBuf,model_dir:PathBuf,label_map_path:PathBuf,onnxruntime_library:PathBuf,timeout_ms:u64}
struct Authorized {record:RunRecord,grants:AiApprovedGrants,expires_at_ms:i64}
fn failed(code:&str,message:&str)->RunnerError{RunnerError::new(code,message)}
fn unavailable()->RunnerError{failed("RUNTIME_CONFIGURATION_UNAVAILABLE","detector private configuration is missing, invalid or ambiguous")}
fn io_error()->RunnerError{failed("DETECTOR_ARTIFACT_IO","private detector artifact operation failed")}
impl From<DetectorError> for RunnerError {fn from(error:DetectorError)->Self{Self{code:error.code,message:error.message}}}

async fn authorize(repository:&Repository,driver:&RunDriver<'_>,expected_hash:&str)->Result<Authorized,RunnerError>{
    let mut tx=repository.begin_write().await.map_err(ModelJobError::from)?;
    let record=runs::load_record(tx.connection(),driver.run_id()).await.map_err(ModelJobError::from)?
        .ok_or_else(||failed("RUN_NOT_FOUND","detector run no longer exists"))?;
    let snapshot:ModelProfile=serde_json::from_str(&record.profile_snapshot_json).map_err(|_|failed("RUN_CONTEXT_INVALID","invalid fixed detector profile"))?;
    let context=record.context().map_err(|_|failed("RUN_CONTEXT_INVALID","invalid fixed detector context"))?;
    if record.provider_id!="detector_local"||snapshot!=*driver.profile()||context!=*driver.context()||record.profile_id!=*driver.profile().profile_id {
        return Err(failed("RUN_CONTEXT_INVALID","detector driver does not match the persisted run snapshot"));
    }
    // This validates the complete saved consent envelope and immutable scope. It is
    // deliberately NOT a comparison of execution hash with authorization envelope hash.
    let grants=consent::authorize_run(tx.connection(),&record).await.map_err(|e|failed(e.code,&e.message))?;
    let row=sqlx::query("SELECT config_json,provider_id,model_id FROM model_profiles WHERE profile_id=?")
        .bind(&record.profile_id).fetch_one(tx.connection()).await.map_err(ModelJobError::from)?;
    let stored:Value=serde_json::from_str(&row.try_get::<String,_>("config_json").map_err(ModelJobError::from)?).map_err(|_|unavailable())?;
    let stored_hash=annotation_domain::hash::execution_configuration_hash(&stored).map_err(|_|unavailable())?;
    if stored_hash!=expected_hash||row.try_get::<String,_>("provider_id").map_err(ModelJobError::from)?!="detector_local"
        ||row.try_get::<String,_>("model_id").map_err(ModelJobError::from)?!=MODEL_ID {
        return Err(failed("PROFILE_CONFIGURATION_CONFLICT","selected native detector execution configuration differs from the approved profile"));
    }
    let expires:Option<String>=sqlx::query_scalar("SELECT capability_expires_at FROM model_run_authorizations WHERE run_id=?")
        .bind(driver.run_id()).fetch_one(tx.connection()).await.map_err(ModelJobError::from)?;
    let expires_at_ms=expires.and_then(|v|chrono::DateTime::parse_from_rfc3339(&v).ok()).map(|v|v.timestamp_millis())
        .filter(|v|*v>chrono::Utc::now().timestamp_millis()).ok_or_else(||failed("RUN_CAPABILITY_EXPIRED","detector capability expired"))?;
    tx.commit().await.map_err(ModelJobError::from)?;
    Ok(Authorized{record,grants,expires_at_ms})
}
struct Capability {tokens:RunTokenStore,run_id:String,cancel:Cancellation}
impl Drop for Capability {fn drop(&mut self){self.tokens.revoke_run(&self.run_id);self.cancel.cancel();}}
fn event_id(run_id:&str,phase:&str)->String{format!("detector-{:x}",Sha256::digest(format!("{run_id}:{phase}").as_bytes()))}

/// Main's fixed provider match calls this; no Node/Python or provider registry.
/// The pool is shared across all detector profiles and holds one active inference.
pub async fn execute(repository:&Repository,tokens:&RunTokenStore,configuration:&RuntimeConfig,pool:&DetectorPool,timeout:Duration,driver:&RunDriver<'_>)->Result<RunOutcome,RunnerError>{
    if driver.profile().provider_id!=ProviderId::DetectorLocal||driver.profile().model_id!=MODEL_ID{return Err(failed("PROFILE_CONFIGURATION_CONFLICT","native detector model identity does not match the fixed source pin"));}
    let selected=configuration.selected("detector_local",&driver.profile().profile_id).map_err(|_|unavailable())?;
    let config=Configuration::deserialize(selected).map_err(|_|unavailable())?;
    if config.profile_id!=*driver.profile().profile_id||config.timeout_ms==0||timeout.is_zero(){return Err(unavailable());}
    let hash=configuration.configuration_hash("detector_local",&config.profile_id).map_err(|_|unavailable())?;
    let authorized=authorize(repository,driver,&hash).await?;
    if authorized.record.intent!="detect"{return Err(failed("unsupported_intent","the native detector only supports detect"));}
    if !authorized.grants.allow_image{return Err(failed("IMAGE_NOT_APPROVED","detector image access was not approved"));}
    let remaining=u64::try_from(authorized.expires_at_ms-chrono::Utc::now().timestamp_millis()).map_err(|_|failed("RUN_CAPABILITY_EXPIRED","detector capability expired"))?;
    let budget=timeout.min(Duration::from_millis(configuration.timeout_ms)).min(Duration::from_millis(config.timeout_ms)).min(Duration::from_millis(remaining));
    if budget.is_zero(){return Err(failed("RUN_CAPABILITY_EXPIRED","detector capability expired"));}
    let deadline=tokio::time::Instant::now().checked_add(budget).ok_or_else(unavailable)?;
    let expires=authorized.expires_at_ms.min(chrono::Utc::now().timestamp_millis().saturating_add(i64::try_from(budget.as_millis()).unwrap_or(i64::MAX)));
    let token=tokens.issue_once_until(driver.run_id(),&authorized.record.project_id,expires).ok_or_else(||failed("RUN_TOKEN_ALREADY_ISSUED","detector run is already executing or expired"))?;
    let cancel=Cancellation::default();let _capability=Capability{tokens:tokens.clone(),run_id:driver.run_id().into(),cancel:cancel.clone()};
    let tools=AgentToolService::new(repository.clone(),tokens.clone());
    let native_active=AtomicBool::new(false);
    let operation=async {
        let context=match tools.invoke(&token,"get_context",&json!({})).await.map_err(|e|failed(&e.code,&e.message))? {
            AgentToolOutput::Json(value)=>value,_=>return Err(failed("AGENT_TOOL_PROTOCOL","context tool returned image content"))};
        if context["run_id"]!=driver.run_id()||context["project_id"]!=authorized.record.project_id||context["media"]["canonical_sha256"]!=driver.context().canonical_sha256 {
            return Err(failed("RUN_CONTEXT_INVALID","authorized detector context identity changed"));
        }
        // Explicit null means approved full image. A crop is never broadened to null.
        let region=match tools.invoke(&token,"read_region",&json!({"region":authorized.grants.preview_crop})).await.map_err(|e|failed(&e.code,&e.message))? {
            AgentToolOutput::Region(region)=>region,_=>return Err(failed("AGENT_TOOL_PROTOCOL","region tool did not return authorized image bytes"))};
        let width=u32::try_from(context["media"]["width"].as_u64().ok_or_else(||failed("RUN_CONTEXT_INVALID","missing canonical dimensions"))?).map_err(|_|unavailable())?;
        let height=u32::try_from(context["media"]["height"].as_u64().ok_or_else(||failed("RUN_CONTEXT_INVALID","missing canonical dimensions"))?).map_err(|_|unavailable())?;
        let valid_labels:BTreeSet<String>=driver.labels().iter().map(|label|label.label_id.to_string()).collect();
        let object_root=repository.object_store().root();let parent=object_root.parent().ok_or_else(io_error)?.to_path_buf();let mapping=config.label_map_path.clone();
        let prepared=tokio::task::spawn_blocking(move||prepare(&parent,&mapping,valid_labels,region,width,height)).await.map_err(|_|io_error())??;
        let Prepared{spool,projection,region,image_sha256,mapping_sha256}=prepared;
        let time_left=deadline.saturating_duration_since(tokio::time::Instant::now());
        if time_left.is_zero(){return Err(failed("RUN_TIMEOUT","detector deadline elapsed before dispatch"));}
        // Revalidate after image preparation, before the process can load or infer.
        authorize(repository,driver,&hash).await?;tokens.verify(&token).map_err(|e|failed(e.code(),"detector capability revoked or expired"))?;
        driver.emit(ProviderEvent{provider_event_id:event_id(driver.run_id(),"dispatch"),provider_seq:Some(1),event_type:RunEventType::Progress,message:"native detector entering bounded execution queue".into(),data:Some(json!({"phase":"queued_for_native_worker","cost_display":"unknown","authorized_region":region,"input_width":projection.width,"input_height":projection.height,"transform_to_canonical":projection.transform_to_canonical}))}).await?;
        let request=WorkerRequest{run_id:driver.run_id().into(),artifact_root:spool.root.clone(),lock_path:config.lock_path.clone(),model_dir:config.model_dir.clone(),runtime_library:config.onnxruntime_library.clone(),runtime_sha256:WINDOWS_CPU_DLL_SHA256.into(),label_map_path:spool.root.join("label-map.json"),input:WorkerInput::Image{path:spool.root.join("authorized.png"),sha256:image_sha256},projection,region,
            timeout_ms:u64::try_from(time_left.as_millis()).map_err(|_|unavailable())?.max(1),budget_ticket:None,return_raw:false};
        let result=async {
            native_active.store(true,Ordering::Release);
            let inference=pool.execute_authorized(request,cancel.clone(),tokens,&token);tokio::pin!(inference);
            let mut poll=tokio::time::interval(Duration::from_millis(100));
            let output=loop {
                tokio::select!{biased;
                    _=tokio::time::sleep_until(deadline)=>{tokens.revoke_run(driver.run_id());cancel.cancel();let cleanup=inference.await;if cleanup.as_ref().is_err_and(|e|e.code=="worker_cleanup_failed"){return Err(cleanup.unwrap_err().into());}return Err(failed("RUN_TIMEOUT","native detector deadline exceeded; no retry"));},
                    _=poll.tick()=>{
                        let validation=async {tokens.verify(&token).map_err(|e|failed(e.code(),"detector capability revoked or expired"))?;authorize(repository,driver,&hash).await?;Ok::<(),RunnerError>(())}.await;
                        if let Err(error)=validation{tokens.revoke_run(driver.run_id());cancel.cancel();let cleanup=inference.await;if cleanup.as_ref().is_err_and(|e|e.code=="worker_cleanup_failed"){return Err(cleanup.unwrap_err().into());}return Err(error);}
                    },
                    result=&mut inference=>break result.map_err(RunnerError::from)?,
                }
            };
            native_active.store(false,Ordering::Release);
            // Preserve the old detector's genuine zero-result behavior: a real
            // completion receipt, but no invented empty prediction/candidate batch.
            let raw=if output.decoded.detections.is_empty()&&output.decoded.unsupported.is_empty(){None}else{Some(output.candidate_raw()?)};
            if let Err(error)=authorize(repository,driver,&hash).await {
                // Terminal late output enters the existing quarantine funnel, never apply.
                let mut tx=repository.begin_write().await.map_err(ModelJobError::from)?;
                let current=runs::load_record(tx.connection(),driver.run_id()).await.map_err(ModelJobError::from)?;tx.commit().await.map_err(ModelJobError::from)?;
                if current.is_some_and(|record|record.state.is_terminal()) {
                    if let Some(raw)=raw{driver.submit_candidates(SubmitCandidates{provider_event_id:event_id(driver.run_id(),"candidate"),provider_seq:Some(2),raw},Some((tokens,&token))).await?;}
                }
                return Err(error);
            }
            tokens.verify(&token).map_err(|e|failed(e.code(),"detector capability revoked or expired"))?;
            if let Some(raw)=raw{driver.submit_candidates(SubmitCandidates{provider_event_id:event_id(driver.run_id(),"candidate"),provider_seq:Some(2),raw},Some((tokens,&token))).await?;}
            let receipt=json!({"provider_id":"detector_local","requested_model_id":driver.profile().model_id,"actual_model_id":output.receipt.model_id,"auth_kind":"local_weights","response_id":driver.run_id(),"implementation":output.receipt.implementation,"runtime_version":output.receipt.runtime_version,"device":"cpu","execution_provider":output.receipt.execution_provider,"model_sha256":output.receipt.model_sha256,"label_mapping_sha256":mapping_sha256,"execution_configuration_hash":hash,"weights_loaded":true,"forward_completed":true,"decoded_detection_count":output.decoded.detections.len(),"unsupported_detection_count":output.decoded.unsupported.len(),"cost":null,"cost_display":"unknown","region":output.region,"transform_to_canonical":output.projection.transform_to_canonical});
            driver.emit(ProviderEvent{provider_event_id:event_id(driver.run_id(),"receipt"),provider_seq:Some(3),event_type:RunEventType::Succeeded,message:"Rust ORT CPU detector inference completed".into(),data:Some(json!({"receipt":receipt,"receipts":[receipt]}))}).await?;
            Ok(RunOutcome::Completed)
        }.await;
        let cleanup=tokio::task::spawn_blocking(move||spool.cleanup()).await.map_err(|_|io_error())?;
        cleanup?;result
    };
    // Preparation/tool calls are also bounded; dropping an active pool future invokes
    // its owned-tree reclamation before private artifacts are removed.
    tokio::pin!(operation);
    tokio::select!{biased;
        _=tokio::time::sleep_until(deadline)=>{
            tokens.revoke_run(driver.run_id());cancel.cancel();
            if native_active.load(Ordering::Acquire) {
                // Let the cancelled worker produce its bounded owned-Job cleanup
                // receipt. Preparation/submission futures instead drop immediately,
                // so no database candidate transaction continues past this deadline.
                match tokio::time::timeout(Duration::from_secs(6),&mut operation).await {
                    Ok(Err(error)) if error.code=="worker_cleanup_failed"=>return Err(error),
                    Err(_)=>return Err(failed("worker_cleanup_failed","detector containment cleanup did not finish within its bounded shutdown allowance")),
                    _=>{},
                }
            }
            Err(failed("RUN_TIMEOUT","native detector deadline exceeded; no retry"))
        },
        result=&mut operation=>result,
    }
}

struct Spool {root:PathBuf,cleaned:bool}
impl Spool {
    fn cleanup(mut self)->Result<(),RunnerError>{self.remove()?;self.cleaned=true;Ok(())}
    fn remove(&self)->Result<(),RunnerError>{
        for name in ["authorized.png","label-map.json"] {match fs::remove_file(self.root.join(name)){Ok(())=>{},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>return Err(io_error())}}
        match fs::remove_dir(&self.root){Ok(())=>Ok(()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(_)=>Err(io_error())}
    }
}
impl Drop for Spool {fn drop(&mut self){if !self.cleaned&&self.remove().is_err(){tracing::error!("private detector artifact cleanup failed");}}}
struct Prepared {spool:Spool,projection:Projection,region:Option<[u32;4]>,image_sha256:String,mapping_sha256:String}
fn private_directory(path:&Path)->Result<(),RunnerError>{
    #[cfg(unix)]
    let builder={use std::os::unix::fs::DirBuilderExt;let mut builder=fs::DirBuilder::new();builder.mode(0o700);builder};
    #[cfg(not(unix))]
    let builder=fs::DirBuilder::new();
    match builder.create(path){Ok(())=>Ok(()),Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{
        let metadata=fs::symlink_metadata(path).map_err(|_|io_error())?;
        #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if metadata.file_attributes()&0x400!=0{return Err(io_error());}}
        if !metadata.is_dir()||metadata.file_type().is_symlink(){return Err(io_error());}Ok(())},Err(_)=>Err(io_error())}
}
fn write_private(path:&Path,bytes:&[u8])->Result<(),RunnerError>{
    let mut options=OpenOptions::new();options.write(true).create_new(true);
    #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
    let mut file=options.open(path).map_err(|_|io_error())?;file.write_all(bytes).map_err(|_|io_error())?;file.sync_all().map_err(|_|io_error())
}
fn prepare(parent:&Path,mapping:&Path,valid_labels:BTreeSet<String>,image:AuthorizedRegion,canonical_width:u32,canonical_height:u32)->Result<Prepared,RunnerError>{
    if image.mime!="image/png"{return Err(failed("AGENT_TOOL_PROTOCOL","authorized detector image must be PNG"));}
    let raw=super::worker::bytes(mapping.parent().ok_or_else(unavailable)?,mapping,1024*1024,"mapping_missing")?;
    let labels:BTreeMap<String,String>=serde_json::from_slice(&raw).map_err(|_|failed("invalid_mapping","detector mapping is invalid JSON"))?;
    if labels.len()>4096||labels.iter().any(|(name,id)|name.is_empty()||name.chars().count()>128||id.is_empty()||id.chars().count()>128||!valid_labels.contains(id)){return Err(failed("invalid_mapping","detector mapping contains an unknown ontology label or invalid category"));}
    let parent=parent.canonicalize().map_err(|_|io_error())?;let container=parent.join(".runtime-detector");private_directory(&container)?;
    if container.canonicalize().map_err(|_|io_error())?!=container{return Err(io_error());}
    let root=container.join(uuid::Uuid::new_v4().to_string());private_directory(&root)?;
    let spool=Spool{root,cleaned:false};
    write_private(&spool.root.join("authorized.png"),&image.bytes)?;write_private(&spool.root.join("label-map.json"),&raw)?;
    let projection=Projection{width:image.width,height:image.height,canonical_width,canonical_height,transform_to_canonical:image.transform_to_canonical};projection.validate()?;
    Ok(Prepared{spool,projection,region:image.region,image_sha256:format!("{:x}",Sha256::digest(&image.bytes)),mapping_sha256:format!("{:x}",Sha256::digest(&raw))})
}
