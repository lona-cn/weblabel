//! Synthetic control evidence only; these tests never load a model or spend forwards.
use std::{collections::BTreeMap, future::Future, io::{Cursor, Read, Write}, process::{Command, Stdio}};
use serde_json::{json, Value};
use weblabel_api::runtime::detector::{decode, preprocess_rgb, read_frame, Projection, MAX_FRAME};

#[test]
fn maps_original_pixels_once_then_mirrors_to_canonical() {
    let mut logits = vec![-20.0; 300 * 80]; logits[0] = 20.0;
    let mut boxes = vec![0.0; 300 * 4]; boxes[..4].copy_from_slice(&[0.25,0.25,0.25,0.25]);
    let geometry = Projection { width:800,height:400,canonical_width:800,canonical_height:400,transform_to_canonical:[-1.,0.,800.,0.,1.,0.,0.,0.,1.] };
    let labels = BTreeMap::from([(0,"person".into())]);
    let mapping = BTreeMap::from([("person".into(),"human".into())]);
    let result = decode(&logits,&boxes,&labels,&mapping,&geometry).unwrap();
    assert_eq!(result.detections.len(),1); assert_eq!(result.detections[0].bbox_xyxy,[500.,50.,700.,150.]);
    assert_eq!(result.detections[0].label_id,"human");
}

#[test]
fn nonfinite_queries_drop_and_unmapped_categories_are_issues() {
    let mut logits=vec![-20.;300*80]; logits[0]=0.; logits[80]=f32::NAN;
    let boxes=vec![0.25;300*4];
    let geometry=Projection {width:800,height:400,canonical_width:800,canonical_height:400,transform_to_canonical:[1.,0.,0.,0.,1.,0.,0.,0.,1.]};
    let result=decode(&logits,&boxes,&BTreeMap::from([(0,"person".into())]),&BTreeMap::new(),&geometry).unwrap();
    assert!(result.detections.is_empty()); assert_eq!(result.unsupported.len(),1);
    assert_eq!(result.unsupported[0].detector_index,0); assert_eq!(result.dropped_non_finite,1);
}

#[test]
fn framing_caps_before_decode_and_rejects_truncation() {
    assert_eq!(read_frame(&mut Cursor::new(vec![b'x';MAX_FRAME+1])).unwrap_err().code,"message_too_large");
    assert_eq!(read_frame(&mut Cursor::new(b"{}".as_slice())).unwrap_err().code,"truncated_message");
    assert_eq!(read_frame(&mut Cursor::new(b"{}\r\n".as_slice())).unwrap(),Some(b"{}".to_vec()));
}

#[test]
fn rgb_constant_stays_exact_without_normalization_or_padding() {
    let tensor=preprocess_rgb(&[255,128,0,255,128,0],2,1).unwrap();
    assert_eq!(tensor.len(),3*640*640); assert!(tensor[..640*640].iter().all(|v|*v==1.));
    assert!(tensor[640*640..2*640*640].iter().all(|v|*v==(128.0f64/255.0) as f32));
    assert!(tensor[2*640*640..].iter().all(|v|*v==0.));
}

fn worker(input: &[u8]) -> (bool, Vec<u8>) {
    let mut child=Command::new(env!("CARGO_BIN_EXE_weblabel")).arg("detector-worker")
        .env_remove("WEBLABEL_RUNTIME_CONFIG").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut stdin=child.stdin.take().unwrap();let stdout=child.stdout.take().unwrap();let stderr=child.stderr.take().unwrap();
    std::thread::scope(|scope| {
        let writer=scope.spawn(move||stdin.write_all(input));
        let out=scope.spawn(move||{let mut bytes=Vec::new();stdout.take((MAX_FRAME+3) as u64).read_to_end(&mut bytes).unwrap();bytes});
        let err=scope.spawn(move||{let mut bytes=Vec::new();stderr.take(64*1024).read_to_end(&mut bytes).unwrap();bytes});
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(15);
        let (status,timed_out)=loop {
            if let Some(status)=child.try_wait().unwrap(){break (status,false);}
            if std::time::Instant::now()>=deadline{child.kill().unwrap();break(child.wait().unwrap(),true);}
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let written=writer.join().unwrap();let output=out.join().unwrap();let errors=err.join().unwrap();
        assert!(!timed_out,"real native worker did not settle within its no-model control deadline; stderr={}",String::from_utf8_lossy(&errors));
        written.unwrap();(status.success(),output)
    })
}

#[test]
fn real_product_worker_rejects_missing_configuration_without_fake_prediction() {
    let request=json!({"protocol_version":1,"id":"synthetic-no-model","kind":"request","method":"start_run","payload":{}});
    let (_,stdout)=worker(format!("{request}\n").as_bytes());
    let value:Value=serde_json::from_slice(&stdout).unwrap();
    assert_eq!(value["protocol_version"],1); assert_eq!(value["id"],"synthetic-no-model");
    assert_eq!(value["payload"]["error"]["code"],"invalid_request");
    assert!(value["payload"].get("result").is_none());
}

#[test]
fn real_product_worker_rejects_oversize_and_truncated_input() {
    for bytes in [vec![b'x';MAX_FRAME+1],b"{\"protocol_version\":1".to_vec()] {
        let (success,stdout)=worker(&bytes); assert!(!success); assert!(stdout.is_empty());
    }
}

fn scratch()->tempfile::TempDir {
    let root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/test-artifacts/R05");
    std::fs::create_dir_all(&root).unwrap();tempfile::tempdir_in(root).unwrap()
}
fn sha(bytes:&[u8])->String {use sha2::{Sha256,Digest};format!("{:x}",Sha256::digest(bytes))}
fn payload(root:&std::path::Path)->Value {
    let lock:Value=serde_json::from_str(include_str!("../../../models/detector/source-lock.json")).unwrap();
    std::fs::write(root.join("source-lock.json"),serde_json::to_vec(&lock).unwrap()).unwrap();
    std::fs::write(root.join("labels.json"),b"{}").unwrap();
    // Synthetic protobuf IR/opset header only. It is NOT a model and every test
    // fails before native library loading; no weights/ORT execution is allowed.
    let graph=[8u8,11,66,2,16,18];std::fs::write(root.join("model.onnx"),graph).unwrap();
    std::fs::write(root.join("manifest.json"),serde_json::to_vec(&json!({"schema_version":1,"model_id":lock["model_id"],
        "source_files":lock["files"],"onnx":{"path":"model.onnx","bytes":graph.len(),"sha256":sha(&graph)},
        "id2label":{"0":"person"},"ir_version":11,"opset":18})).unwrap()).unwrap();
    let tensor=vec![0u8;3*640*640*4];std::fs::write(root.join("input.f32"),&tensor).unwrap();
    json!({"run_id":"synthetic-errors","artifact_root":root,"lock_path":root.join("source-lock.json"),"model_dir":root,
        "runtime_library":root.join("absent-runtime.dll"),"runtime_sha256":"0".repeat(64),"label_map_path":root.join("labels.json"),
        "input":{"kind":"tensor","path":root.join("input.f32"),"sha256":sha(&tensor)},
        "projection":{"width":1,"height":1,"canonical_width":1,"canonical_height":1,"transform_to_canonical":[1.,0.,0.,0.,1.,0.,0.,0.,1.]},
        "timeout_ms":1000,"budget_ticket":null,"return_raw":false})
}
fn error_code(payload:Value)->String {
    let request=json!({"protocol_version":1,"id":"synthetic-errors","kind":"request","method":"start_run","payload":payload});
    let (_,out)=worker(format!("{request}\n").as_bytes());let result:Value=serde_json::from_slice(&out).unwrap();
    assert!(result["payload"].get("result").is_none());result["payload"]["error"]["code"].as_str().unwrap().into()
}
#[test]
fn real_worker_distinguishes_missing_model_library_and_hash_without_loading_native_code() {
    let temp=scratch();let input=payload(temp.path());
    assert_eq!(error_code(input.clone()),"runtime_library_missing");
    std::fs::write(temp.path().join("model.onnx"),b"corrupt").unwrap();
    assert_eq!(error_code(input.clone()),"artifact_hash_mismatch");
    std::fs::remove_file(temp.path().join("model.onnx")).unwrap();
    assert_eq!(error_code(input),"model_missing");
}
#[test]
fn real_worker_refuses_tensor_shape_nonfinite_and_confined_path_before_native_code() {
    let temp=scratch();let mut input=payload(temp.path());let path=temp.path().join("input.f32");
    std::fs::write(&path,[0u8;4]).unwrap();input["input"]["sha256"]=json!(sha(&[0u8;4]));
    assert_eq!(error_code(input.clone()),"shape_mismatch");
    let mut tensor=vec![0u8;3*640*640*4];tensor[..4].copy_from_slice(&f32::NAN.to_le_bytes());
    std::fs::write(&path,&tensor).unwrap();input["input"]["sha256"]=json!(sha(&tensor));
    assert_eq!(error_code(input.clone()),"nonfinite_input");
    let outside=scratch();std::fs::write(outside.path().join("outside.f32"),[0u8;4]).unwrap();
    input["input"]["path"]=json!(outside.path().join("outside.f32"));
    assert_eq!(error_code(input),"artifact_path_escape");
}
#[test]
fn invalid_mapping_and_actual_ir_are_refused_before_native_loading() {
    let temp=scratch();let input=payload(temp.path());
    std::fs::write(temp.path().join("labels.json"),br#"{"person":""}"#).unwrap();
    assert_eq!(error_code(input.clone()),"invalid_mapping");
    std::fs::write(temp.path().join("labels.json"),b"{}").unwrap();
    let graph=[8u8,12,66,2,16,18];std::fs::write(temp.path().join("model.onnx"),graph).unwrap();
    let mut manifest:Value=serde_json::from_slice(&std::fs::read(temp.path().join("manifest.json")).unwrap()).unwrap();
    manifest["onnx"]["sha256"]=json!(sha(&graph));std::fs::write(temp.path().join("manifest.json"),serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert_eq!(error_code(input),"model_graph_incompatible");
}

#[test]
fn real_worker_preprocesses_alpha_image_and_checks_authorized_dimensions_without_native_loading() {
    let temp=scratch();let mut input=payload(temp.path());
    let image=image::RgbaImage::from_pixel(2,1,image::Rgba([255,128,0,19]));
    let mut encoded=Cursor::new(Vec::new());image::DynamicImage::ImageRgba8(image).write_to(&mut encoded,image::ImageFormat::Png).unwrap();
    std::fs::write(temp.path().join("authorized.png"),encoded.get_ref()).unwrap();
    input["input"]=json!({"kind":"image","path":temp.path().join("authorized.png"),"sha256":sha(encoded.get_ref())});
    input["projection"]["width"]=json!(2);input["projection"]["canonical_width"]=json!(2);
    assert_eq!(error_code(input.clone()),"runtime_library_missing");
    input["projection"]["width"]=json!(1);
    assert_eq!(error_code(input),"shape_mismatch");
}

#[tokio::test]
async fn parent_uses_real_product_worker_and_reclaims_before_returning_controlled_failure() {
    use weblabel_api::runtime::detector::{Cancellation,DetectorPool,WorkerRequest};
    let temp=scratch();let mut input:WorkerRequest=serde_json::from_value(payload(temp.path())).unwrap();input.timeout_ms=30000;
    let pool=DetectorPool::new(std::path::PathBuf::from(env!("CARGO_BIN_EXE_weblabel")),DetectorPool::DEFAULT_PENDING).unwrap();
    assert_eq!(pool.execute(input,Cancellation::default()).await.unwrap_err().code,"runtime_library_missing");
    pool.shutdown().await.unwrap();
}

#[test]
fn candidate_conversion_preserves_prediction_origin_and_reports_unsupported_without_guessing() {
    use weblabel_api::runtime::detector::{ExecutionReceipt,WorkerResult};
    let mut logits=vec![-20.;300*80];logits[0]=1.;logits[81]=1.;
    let boxes=vec![0.25;300*4];let p=Projection{width:800,height:400,canonical_width:800,canonical_height:400,transform_to_canonical:[1.,0.,0.,0.,1.,0.,0.,0.,1.]};
    let decoded=decode(&logits,&boxes,&BTreeMap::from([(0,"person".into()),(1,"unsupported".into())]),&BTreeMap::from([("person".into(),"label-person".into())]),&p).unwrap();
    let run_id="synthetic-candidate".to_owned();
    let result=WorkerResult{run_id:run_id.clone(),input_tensor_sha256:"synthetic".into(),projection:p,region:None,decoded,raw_logits:None,raw_boxes:None,
        receipt:ExecutionReceipt{implementation:"synthetic fixture; not live".into(),runtime_version:"not loaded".into(),execution_provider:"not executed".into(),model_id:"synthetic".into(),model_sha256:"synthetic".into(),run_id,cost:None,cost_status:"unknown".into()}};
    let raw=result.candidate_raw().unwrap();
    assert_eq!(raw["changes"].as_array().unwrap().len(),1);assert_eq!(raw["issues"].as_array().unwrap().len(),1);
    assert_eq!(raw["changes"][0]["object"]["origin"]["type"],"prediction");
    assert!(raw["changes"][0]["before_hash"].is_null());
    assert_eq!(raw["issues"][0]["code"],"unsupported_category");
    assert!(raw["issues"][0]["object_id"].is_null());
}

struct DetectorConsumerRunner {
    repository:weblabel_api::storage::Repository,
    tokens:weblabel_api::runtime::run_tokens::RunTokenStore,
    configuration:weblabel_api::runtime::config::RuntimeConfig,
    pool:weblabel_api::runtime::detector::DetectorPool,
}
impl weblabel_api::jobs::model_jobs::RunRunner for DetectorConsumerRunner {
    fn execute<'a>(&'a self,driver:&'a weblabel_api::jobs::model_jobs::RunDriver)
        ->std::pin::Pin<Box<dyn Future<Output=Result<weblabel_api::jobs::model_jobs::RunOutcome,weblabel_api::jobs::model_jobs::RunnerError>>+Send+'a>> {
        Box::pin(weblabel_api::runtime::detector::execute(&self.repository,&self.tokens,&self.configuration,&self.pool,std::time::Duration::from_secs(30),driver))
    }
}

async fn adapter_call(app:&axum::Router,path:&str,body:Value,cookie:Option<&str>,csrf:Option<&str>)->(axum::http::StatusCode,Value,Option<String>) {
    use tower::ServiceExt;
    let mut request=axum::http::Request::builder().method("POST").uri(path)
        .header("host","127.0.0.1:48205").header("origin","http://127.0.0.1:48205").header("content-type","application/json");
    if let Some(cookie)=cookie{request=request.header("cookie",cookie);}
    if let Some(csrf)=csrf{request=request.header("x-csrf-token",csrf);}
    let response=app.clone().oneshot(request.body(axum::body::Body::from(body.to_string())).unwrap()).await.unwrap();
    let status=response.status();let cookie=response.headers().get("set-cookie").map(|v|v.to_str().unwrap().split(';').next().unwrap().to_owned());
    let bytes=axum::body::to_bytes(response.into_body(),2*1024*1024).await.unwrap();
    (status,serde_json::from_slice(&bytes).unwrap(),cookie)
}

async fn adapter_scenario(scenario:&str,expected:&str) {
    use axum::http::StatusCode;
    use weblabel_api::{auth::{hash_launch_code,AuthConfig},config::ServerConfig,AppState,router,media::ingest::{import_one,ImportInput},jobs::{model_jobs::process_model_next,queue::JobQueue}};
    use weblabel_api::runtime::{config::RuntimeConfig,detector::{DetectorPool,MODEL_ID}};
    let temp=scratch();let root=temp.path().canonicalize().unwrap();
    let config=ServerConfig{bind:"127.0.0.1:48205".parse().unwrap(),database_url:format!("sqlite:{}",root.join("api.sqlite").display()),object_root:root.join("objects"),write_timeout:std::time::Duration::from_secs(5),production:true};
    let state=AppState::open_with_auth(&config,AuthConfig{bind:config.bind,cookie_secure:false,allowed_origins:vec!["http://127.0.0.1:48205".into()],allowed_hosts:vec!["127.0.0.1:48205".into()],launch_code:hash_launch_code("synthetic-detector-launch"),launch_code_expires_at:chrono::Utc::now().timestamp()+3600}).await.unwrap();
    let app=router(state.clone());
    let (status,session,cookie)=adapter_call(&app,"/api/session/bootstrap",json!({"launch_code":"synthetic-detector-launch","password":"synthetic-detector-password"}),None,None).await;
    assert_eq!(status,StatusCode::OK);let cookie=cookie.unwrap();let csrf=session["csrf_token"].as_str().unwrap();let actor=session["user_id"].as_str().unwrap();
    let (status,project,_)=adapter_call(&app,"/api/projects",json!({"name":"Synthetic native detector","description":"no model execution","allow_self_review":false}),Some(&cookie),Some(csrf)).await;
    assert_eq!(status,StatusCode::CREATED,"{project}");let project=project["project_id"].as_str().unwrap();
    let (status,ontology,_)=adapter_call(&app,&format!("/api/projects/{project}/ontologies"),json!({"labels":[{"label_id":"person-label","name":"Synthetic person","color":"#33AA66","shortcut":null,"allowed_geometry_types":["bbox_xyxy"],"attributes":[]}],"guidelines_markdown":"Synthetic fixture only"}),Some(&cookie),Some(csrf)).await;
    assert_eq!(status,StatusCode::CREATED,"{ontology}");let ontology=ontology["ontology_version_id"].as_str().unwrap();
    let mut png=Cursor::new(Vec::new());image::DynamicImage::ImageRgb8(image::RgbImage::new(32,24)).write_to(&mut png,image::ImageFormat::Png).unwrap();
    let asset=import_one(&state.repository,&weblabel_api::jobs::worker::MediaWorker::new(),ImportInput{project_id:project.into(),ontology_version_id:ontology.into(),actor_id:actor.into(),source_group_id:"synthetic-group".into(),original_name:"synthetic.png".into(),declared_mime:Some("image/png".into()),bytes:png.into_inner()}).await.unwrap();
    let label_map=root.join("label-map.json");std::fs::write(&label_map,br#"{"person":"person-label"}"#).unwrap();
    let execution=json!({"profile_id":"native-detector-fixture","lock_path":std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models/detector/source-lock.json").canonicalize().unwrap(),
        "model_dir":root.join("absent-model"),"label_map_path":label_map,"onnxruntime_library":root.join("absent-runtime.dll"),"timeout_ms":20000});
    let caps=json!({"image_input":true,"tools":false,"structured_output":true,"bbox_output":true,"attributes":false});
    let mut tx=state.repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('native-detector-fixture','detector_local',?,'local_weights',?,'ready','not_run',NULL,NULL,?,NULL,'2026-10-25T00:00:00Z')")
        .bind(MODEL_ID).bind(caps.to_string()).bind(execution.to_string()).execute(tx.connection()).await.unwrap();tx.commit().await.unwrap();
    let request=json!({"operation_id":"native-detector-operation","profile_id":"native-detector-fixture",
        "context":{"project_id":project,"asset_revision_id":asset.asset_revision_id,"annotation_revision_id":asset.annotation_revision_id,"ontology_version_id":ontology,"draft_generation":0,"canonical_sha256":asset.canonical_sha256,"selected_object_ids":[],"object_hashes":{},"input_fingerprint":"not-trusted"},
        "intent":"detect","prompt":"synthetic image; missing model must fail honestly","consent_id":null});
    let crop=if scenario=="crop"{json!({"type":"bbox_xyxy","x_min":4.0,"y_min":4.0,"x_max":20.0,"y_max":20.0})}else{Value::Null};
    let (status,preview,_)=adapter_call(&app,"/api/ai/previews",json!({"request":request,"grants":{"allow_image":scenario!="no_image","allow_object_context":false,"preview_crop":crop}}),Some(&cookie),Some(csrf)).await;
    assert_eq!(status,StatusCode::CREATED,"{preview}");
    let (status,consent,_)=adapter_call(&app,"/api/ai/consents",json!({"preview_id":preview["preview_id"]}),Some(&cookie),Some(csrf)).await;assert_eq!(status,StatusCode::CREATED,"{consent}");
    let mut request=preview["request"].clone();request["consent_id"]=consent["consent_id"].clone();
    let (status,created,_)=adapter_call(&app,"/api/ai/runs",request,Some(&cookie),Some(csrf)).await;assert_eq!(status,StatusCode::ACCEPTED,"{created}");
    let run_id=created["run_id"].as_str().unwrap();
    if scenario=="expired" {
        let mut tx=state.repository.begin_write().await.unwrap();
        sqlx::query("INSERT OR REPLACE INTO model_run_authorizations(run_id,preview_id,grants_json,profile_configuration_hash,capability_expires_at) SELECT run_id,preview_id,grants_json,profile_configuration_hash,'2020-01-01T00:00:00Z' FROM model_run_authorizations WHERE run_id=?").bind(run_id).execute(tx.connection()).await.unwrap();tx.commit().await.unwrap();
    }
    let mut selected=execution.clone();if scenario=="changed_config"{selected["timeout_ms"]=json!(19000);}
    let native=RuntimeConfig::parse(&json!({"schema_version":1,"timeout_ms":30000,"providers":[{"provider":"detector_local","config":selected}]}).to_string(),&[]).unwrap();
    let runner=DetectorConsumerRunner{repository:state.repository.clone(),tokens:state.run_tokens.clone(),configuration:native,pool:DetectorPool::new(std::path::PathBuf::from(env!("CARGO_BIN_EXE_weblabel")),8).unwrap()};
    assert!(process_model_next(&state.repository,&JobQueue::new(state.repository.clone()),"synthetic-native-worker",std::time::Duration::from_secs(60),&runner).await.unwrap().is_some());
    let mut tx=state.repository.begin_write().await.unwrap();
    let status:String=sqlx::query_scalar("SELECT state FROM model_runs WHERE run_id=?").bind(run_id).fetch_one(tx.connection()).await.unwrap();
    let predictions:i64=sqlx::query_scalar("SELECT count(*) FROM predictions WHERE run_id=?").bind(run_id).fetch_one(tx.connection()).await.unwrap();
    let events:Vec<Option<String>>=sqlx::query_scalar("SELECT data_json FROM run_events WHERE run_id=? ORDER BY seq").bind(run_id).fetch_all(tx.connection()).await.unwrap();tx.commit().await.unwrap();
    assert_eq!(status,"failed");assert_eq!(predictions,0);
    assert!(events.iter().flatten().any(|e|serde_json::from_str::<Value>(e).unwrap()["code"]==expected),"expected {expected}; events={events:?}");
    if scenario=="crop" {
        assert!(events.iter().flatten().any(|e|{let value:Value=serde_json::from_str(e).unwrap();value["authorized_region"]==json!([4,4,20,20])&&value["input_width"]==16&&value["input_height"]==16}),"approved crop must not be broadened to full image: {events:?}");
    }
    assert_eq!(state.run_tokens.active_tokens_for_run(run_id),0);
    let artifacts=root.join(".runtime-detector");
    assert!(!artifacts.exists()||std::fs::read_dir(artifacts).unwrap().next().is_none(),"private image artifacts must be removed after native failure");
    runner.pool.shutdown().await.unwrap();
}

#[tokio::test]
async fn run_driver_detector_adapter_preserves_consent_envelope_and_real_missing_model_failure(){adapter_scenario("missing_model","model_missing").await;}
#[tokio::test]
async fn run_driver_detector_adapter_rejects_selected_configuration_drift_before_capability(){adapter_scenario("changed_config","PROFILE_CONFIGURATION_CONFLICT").await;}
#[tokio::test]
async fn run_driver_detector_adapter_refuses_expired_capability_without_model_dispatch(){adapter_scenario("expired","RUN_CAPABILITY_EXPIRED").await;}
#[tokio::test]
async fn run_driver_detector_adapter_never_reads_an_unapproved_image(){adapter_scenario("no_image","IMAGE_NOT_APPROVED").await;}
#[tokio::test]
async fn run_driver_detector_adapter_keeps_integer_crop_and_authorized_pixel_dimensions(){adapter_scenario("crop","model_missing").await;}

#[test]
fn real_worker_preprocessing_probe_never_loads_model_and_preserves_original_float32_rescale() {
    let temp=scratch();let image=image::RgbImage::from_pixel(1,1,image::Rgb([3,127,255]));
    let mut encoded=Cursor::new(Vec::new());image::DynamicImage::ImageRgb8(image).write_to(&mut encoded,image::ImageFormat::Png).unwrap();
    std::fs::write(temp.path().join("source.png"),encoded.get_ref()).unwrap();
    let request=json!({"protocol_version":1,"id":"synthetic-preprocess","kind":"request","method":"probe","payload":{
        "run_id":"synthetic-preprocess","artifact_root":temp.path(),"timeout_ms":15000,
        "input":{"kind":"image","path":temp.path().join("source.png"),"sha256":sha(encoded.get_ref())},
        "projection":{"width":1,"height":1,"canonical_width":1,"canonical_height":1,"transform_to_canonical":[1.,0.,0.,0.,1.,0.,0.,0.,1.]},
        "output_name":"original-preprocess.f32"}});
    let (success,out)=worker(format!("{request}\n").as_bytes());assert!(success);let response:Value=serde_json::from_slice(&out).unwrap();
    assert_eq!(response["method"],"probe");assert_eq!(response["payload"]["result"]["kind"],"preprocess_only");
    assert_eq!(response["payload"]["result"]["detector_forwards"],0);assert_eq!(response["payload"]["result"]["model_loaded"],false);
    let tensor=std::fs::read(temp.path().join("original-preprocess.f32")).unwrap();assert_eq!(tensor.len(),3*640*640*4);
    assert_eq!(response["payload"]["result"]["tensor_sha256"],sha(&tensor));
    for (channel,byte) in [3u8,127,255].into_iter().enumerate() {
        let expected=(f32::from(byte)*(1.0f32/255.0)).to_le_bytes();
        assert!(tensor[channel*640*640*4..(channel+1)*640*640*4].chunks_exact(4).all(|v|v==expected));
    }
    // Repeating a probe cannot overwrite the original golden or spend a forward.
    let (_,out)=worker(format!("{request}\n").as_bytes());let response:Value=serde_json::from_slice(&out).unwrap();
    assert_eq!(response["payload"]["error"]["code"],"preprocess_output_exists");
    assert_eq!(std::fs::read(temp.path().join("original-preprocess.f32")).unwrap(),tensor);
}

#[test]
fn development_invalid_tickets_fail_before_any_native_library_access() {
    for kind in ["missing","corrupt","replayed","wrong_nonce","wrong_kind"] {
        let temp=scratch();let mut input=payload(temp.path());
        let native=temp.path().join("synthetic-not-native.dll");
        std::fs::write(&native,b"synthetic bytes, never a native library").unwrap();
        input["runtime_library"]=json!(native);
        input["runtime_sha256"]=json!(weblabel_api::runtime::detector::WINDOWS_CPU_DLL_SHA256);
        let ledger=temp.path().join("CONTROL-ledger.json");
        std::fs::write(temp.path().join("CONTROL-ledger.json.lock"),[0u8]).unwrap();
        let state=json!({"schema_version":1,"limit":20,"used":1,"receipts":[{
            "sequence":1,"kind":if kind=="wrong_kind"{"synthetic-control"}else{"rust-request"},
            "nonce":"control-nonce","redeemed":kind=="replayed"}]});
        if kind=="corrupt" {std::fs::write(&ledger,b"{").unwrap();}
        else if kind!="missing" {std::fs::write(&ledger,serde_json::to_vec(&state).unwrap()).unwrap();}
        input["budget_ticket"]=json!({"ledger":ledger,"sequence":1,
            "nonce":if kind=="wrong_nonce"{"wrong-nonce"}else{"control-nonce"}});
        assert_eq!(error_code(input),"forward_budget_unavailable","case {kind}");
        if !["missing","corrupt"].contains(&kind) {
            assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&ledger).unwrap()).unwrap(),state);
        }
    }
}

#[test]
fn development_precharged_ticket_is_consumed_before_native_failure_without_rollback() {
    let temp=scratch();let mut input=payload(temp.path());
    let native=temp.path().join("synthetic-not-native.dll");
    std::fs::write(&native,b"synthetic bytes, never a native library").unwrap();
    input["runtime_library"]=json!(native);
    input["runtime_sha256"]=json!(weblabel_api::runtime::detector::WINDOWS_CPU_DLL_SHA256);
    let ledger=temp.path().join("CONTROL-ledger.json");
    std::fs::write(temp.path().join("CONTROL-ledger.json.lock"),[0u8]).unwrap();
    std::fs::write(&ledger,serde_json::to_vec(&json!({"schema_version":1,"limit":20,"used":1,
        "receipts":[{"sequence":1,"kind":"rust-request","nonce":"control-nonce","redeemed":false}]})).unwrap()).unwrap();
    input["budget_ticket"]=json!({"ledger":ledger,"sequence":1,"nonce":"control-nonce"});
    assert_eq!(error_code(input.clone()),"artifact_hash_mismatch");
    let state:Value=serde_json::from_slice(&std::fs::read(&ledger).unwrap()).unwrap();
    assert_eq!(state["used"],1);assert_eq!(state["receipts"][0]["redeemed"],true);
    assert_eq!(error_code(input),"forward_budget_unavailable");
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&ledger).unwrap()).unwrap(),state);
}
