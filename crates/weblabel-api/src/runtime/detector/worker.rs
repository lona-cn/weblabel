use std::{collections::BTreeMap,fs::{File,OpenOptions},io::{BufRead,BufReader,Read,Write},path::{Path,PathBuf}};
use serde::Deserialize;
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use crate::runtime::{parse_envelope,EnvelopeKind,EnvelopeMethod,RuntimeEnvelope};
use super::{budget,decode,preprocess_rgb,DetectorError,ExecutionReceipt,WorkerInput,WorkerRequest,WorkerResult,INPUT_FLOATS,MAX_FRAME,MODEL_ID};

/// Enforces the raw-byte limit before UTF-8/JSON, including newline-free floods.
pub fn read_frame(reader:&mut impl BufRead)->Result<Option<Vec<u8>>,DetectorError> {
    let mut line=Vec::new();
    loop {
        let available=reader.fill_buf()?;
        if available.is_empty() {return if line.is_empty(){Ok(None)}else{Err(DetectorError::new("truncated_message","unterminated NDJSON frame"))};}
        let newline=available.iter().position(|b|*b==b'\n');let count=newline.map_or(available.len(),|n|n+1);
        if line.len()+count>MAX_FRAME+2 {return Err(DetectorError::new("message_too_large","NDJSON exceeds 4MiB"));}
        line.extend_from_slice(&available[..count]);reader.consume(count);
        if newline.is_some() {
            line.pop();if line.last()==Some(&b'\r'){line.pop();}
            if line.len()>MAX_FRAME{return Err(DetectorError::new("message_too_large","NDJSON exceeds 4MiB"));}
            return Ok(Some(line));
        }
        if line.len()>MAX_FRAME {return Err(DetectorError::new("message_too_large","NDJSON exceeds 4MiB"));}
    }
}
fn failure(code:&str)->DetectorError {DetectorError::new(code,"detector artifact validation failed")}
fn confined(root:&Path,path:&Path,missing:&str)->Result<PathBuf,DetectorError> {
    let root=root.canonicalize().map_err(|_|failure(missing))?;
    let path=path.canonicalize().map_err(|_|failure(missing))?;
    if !path.starts_with(&root) {return Err(failure("artifact_path_escape"));}Ok(path)
}
fn opened(root:&Path,path:&Path,limit:u64,missing:&str)->Result<File,DetectorError> {
    let path=confined(root,path,missing)?;
    let mut options=OpenOptions::new();options.read(true);
    // Prevent concurrent replacement/writes while measuring and consuming the opened FD.
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1);}
    let file=options.open(&path).map_err(|_|failure(missing))?;
    let metadata=file.metadata()?;
    if !metadata.is_file() || metadata.len()>limit {return Err(failure("artifact_too_large"));}
    check_handle(root,&path,&file,missing)?;
    Ok(file)
}
pub(super) fn check_handle(root:&Path,_path:&Path,_file:&File,missing:&str)->Result<(),DetectorError> {
    #[cfg(windows)] {
        use std::os::windows::{io::AsRawHandle,ffi::OsStringExt};
        use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
        let mut wide=vec![0u16;32768];
        // SAFETY: valid live file handle and writable buffer with its actual length.
        let count=unsafe{GetFinalPathNameByHandleW(_file.as_raw_handle(),wide.as_mut_ptr(),wide.len() as u32,0)} as usize;
        if count==0||count>=wide.len(){return Err(failure("artifact_path_escape"));}
        let actual=PathBuf::from(std::ffi::OsString::from_wide(&wide[..count]));
        if !actual.starts_with(root.canonicalize().map_err(|_|failure(missing))?){return Err(failure("artifact_path_escape"));}
    }
    #[cfg(not(windows))] {
        if _path.canonicalize().map_err(|_|failure(missing))?!=_path {return Err(failure("artifact_path_escape"));}
    }
    Ok(())
}
pub(super) fn bytes(root:&Path,path:&Path,limit:u64,missing:&str)->Result<Vec<u8>,DetectorError> {
    let mut file=opened(root,path,limit,missing)?;let mut bytes=Vec::with_capacity(file.metadata()?.len() as usize);
    (&mut file).take(limit+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64>limit {return Err(failure("artifact_too_large"));}Ok(bytes)
}
fn checked(root:&Path,path:&Path,limit:u64,hash:&str,missing:&str)->Result<Vec<u8>,DetectorError> {
    let data=bytes(root,path,limit,missing)?;
    if hash.len()!=64 || format!("{:x}",Sha256::digest(&data))!=hash {return Err(failure("artifact_hash_mismatch"));}Ok(data)
}
fn checked_file(root:&Path,path:&Path,limit:u64,hash:&str,missing:&str)->Result<File,DetectorError> {
    let mut file=opened(root,path,limit,missing)?;let mut hasher=Sha256::new();let mut buffer=[0u8;65536];
    loop {let count=file.read(&mut buffer)?;if count==0{break;}hasher.update(&buffer[..count]);}
    if hash.len()!=64||format!("{:x}",hasher.finalize())!=hash{return Err(failure("artifact_hash_mismatch"));}Ok(file)
}
#[derive(Deserialize)]
struct Manifest {schema_version:u32,model_id:String,onnx:Artifact,source_files:Vec<Artifact>,id2label:BTreeMap<usize,String>,ir_version:u64,opset:u64}
#[derive(Deserialize)]
struct Artifact {path:String,bytes:u64,sha256:String}

fn varint(data:&[u8],offset:&mut usize)->Result<u64,DetectorError> {
    let mut n=0u64;for shift in (0..70).step_by(7) {let b=*data.get(*offset).ok_or_else(||failure("model_graph_invalid"))?;*offset+=1;
        if shift==63&&b>1{return Err(failure("model_graph_invalid"));}n|=u64::from(b&127)<<shift;if b<128{return Ok(n);}}
    Err(failure("model_graph_invalid"))
}
/// Inspect actual protobuf IR/opset headers, never trust hand-edited manifest claims.
fn graph_header(data:&[u8])->Result<(u64,u64),DetectorError> {
    let mut offset=0;let mut ir=None;let mut opset=None;
    while offset<data.len(){let key=varint(data,&mut offset)?;match key&7 {
        0=>{let n=varint(data,&mut offset)?;if key>>3==1 {if ir.replace(n).is_some(){return Err(failure("model_graph_invalid"));}}},
        1=>offset=offset.checked_add(8).ok_or_else(||failure("model_graph_invalid"))?,
        5=>offset=offset.checked_add(4).ok_or_else(||failure("model_graph_invalid"))?,
        2=>{let len=usize::try_from(varint(data,&mut offset)?).map_err(|_|failure("model_graph_invalid"))?;let end=offset.checked_add(len).ok_or_else(||failure("model_graph_invalid"))?;
            let field=data.get(offset..end).ok_or_else(||failure("model_graph_invalid"))?;
            if key>>3==8 {let mut p=0;let mut domain=Vec::new();let mut version=None;
                while p<field.len(){let k=varint(field,&mut p)?;match k {10=>{let n=usize::try_from(varint(field,&mut p)?).map_err(|_|failure("model_graph_invalid"))?;let end=p.checked_add(n).ok_or_else(||failure("model_graph_invalid"))?;domain=field.get(p..end).ok_or_else(||failure("model_graph_invalid"))?.to_vec();p=end;},16=>version=Some(varint(field,&mut p)?),_=>return Err(failure("model_graph_invalid"))}}
                if domain.is_empty()||domain==b"ai.onnx" {if opset.replace(version.ok_or_else(||failure("model_graph_invalid"))?).is_some(){return Err(failure("model_graph_invalid"));}}
            }offset=end;},_=>return Err(failure("model_graph_invalid"))}
        if offset>data.len(){return Err(failure("model_graph_invalid"));}
    }
    let ir=ir.ok_or_else(||failure("model_graph_invalid"))?;let opset=opset.ok_or_else(||failure("model_graph_invalid"))?;
    if ir==0||ir>11||opset!=18{return Err(failure("model_graph_incompatible"));}Ok((ir,opset))
}
pub(super) fn tensor(root:&Path,input:&WorkerInput,projection:&super::Projection)->Result<Vec<f32>,DetectorError> {
    match input {
        WorkerInput::Tensor{path,sha256}=>{
            let raw=checked(root,path,(INPUT_FLOATS*4) as u64,sha256,"input_missing")?;
            if raw.len()!=INPUT_FLOATS*4{return Err(failure("shape_mismatch"));}
            let tensor:Vec<f32>=raw.chunks_exact(4).map(|b|f32::from_le_bytes([b[0],b[1],b[2],b[3]])).collect();
            if tensor.iter().any(|v|!v.is_finite()){return Err(failure("nonfinite_input"));}Ok(tensor)
        },
        WorkerInput::Image{path,sha256}=>{
            let raw=checked(root,path,128*1024*1024,sha256,"input_missing")?;
            let mut reader=image::ImageReader::new(std::io::Cursor::new(raw)).with_guessed_format().map_err(|_|failure("invalid_image"))?;
            let mut limits=image::Limits::default();limits.max_image_width=Some(32768);limits.max_image_height=Some(32768);limits.max_alloc=Some(256*1024*1024);reader.limits(limits);
            let image=reader.decode().map_err(|_|failure("invalid_image"))?;
            if image.width()!=projection.width||image.height()!=projection.height{return Err(failure("shape_mismatch"));}
            // PIL convert('RGB') drops alpha; it does not composite on white/black.
            let rgb=image.into_rgb8();preprocess_rgb(rgb.as_raw(),rgb.width(),rgb.height())
        }
    }
}
#[cfg(any(windows,test))]
fn checked_runtime_version(bytes:&[u8])->Result<String,DetectorError> {
    let version=std::str::from_utf8(bytes).map_err(|_|failure("runtime_version_unavailable"))?;
    if version!="1.23.2" {return Err(failure("runtime_version_mismatch"));}
    Ok(version.to_owned())
}

/// Query the version of the SDK's ALREADY-loaded module; never create a session.
/// The caller must first build this environment using the hash-checked explicit
/// runtime path. Borrowing the environment keeps its initialized SDK lifetime.
/// `ort::info()` is GetBuildInfoString and is deliberately not a version source.
pub(crate) fn loaded_runtime_version(_environment:&ort::environment::Environment)->Result<String,DetectorError> {
    #[cfg(windows)] {
        use windows_sys::Win32::System::LibraryLoader::{
            GetModuleHandleExW,GetProcAddress,GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        };
        let mut module=std::ptr::null_mut();
        // Environment::build already initialized this exact global API table.
        // FROM_ADDRESS selects its module, not a same-basename DLL/search path.
        let anchor=ort::api().GetBuildInfoString as *const ();
        // SAFETY: anchor is a live native function address. FROM_ADDRESS tells
        // Windows not to interpret it as a string. ort's global Library owner
        // remains alive; UNCHANGED_REFCOUNT means this handle must NOT be freed.
        if unsafe{GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,anchor.cast(),&mut module)}==0||module.is_null() {
            return Err(failure("runtime_version_unavailable"));
        }
        // SAFETY: live module, exact NUL-terminated exported symbol name.
        let symbol=unsafe{GetProcAddress(module,c"OrtGetApiBase".as_ptr().cast())}
            .ok_or_else(||failure("runtime_version_unavailable"))?;
        // SAFETY: pinned ort-sys ABI declares this export with system calling
        // convention and OrtApiBase return type; no handwritten struct layout.
        let get_base:unsafe extern "system" fn()->*const ort::sys::OrtApiBase=
            unsafe{std::mem::transmute(symbol)};
        // SAFETY: calling the documented, typed ONNX Runtime API export.
        let base=unsafe{get_base()};if base.is_null(){return Err(failure("runtime_version_unavailable"));}
        // SAFETY: non-null OrtApiBase from its own loaded library; returned
        // version is a library-owned UTF8 NUL-terminated string, never freed here.
        let pointer=unsafe{((*base).GetVersionString)()};
        if pointer.is_null(){return Err(failure("runtime_version_unavailable"));}
        // Bound malformed-native-string scanning; do not scan arbitrary lengths.
        let length=(0..64usize).find(|index|unsafe{*pointer.add(*index)}==0)
            .ok_or_else(||failure("runtime_version_unavailable"))?;
        // SAFETY: the API guarantees the string through its terminating NUL;
        // length was bounded and found above while the module remains loaded.
        let bytes=unsafe{std::slice::from_raw_parts(pointer.cast::<u8>(),length)};
        checked_runtime_version(bytes)
    }
    #[cfg(not(windows))] {
        Err(failure("runtime_version_unavailable"))
    }
}

#[cfg(test)]
mod runtime_version_controls {
    use super::checked_runtime_version;
    #[test]
    fn accepts_exact_pinned_runtime_version_bytes() {
        assert_eq!(checked_runtime_version(b"1.23.2").unwrap(),"1.23.2");
    }
    #[test]
    fn rejects_build_information_and_nearby_versions() {
        for bytes in [b"ORT Build Info: git-branch=rel-1.23.2".as_slice(),b"1.23.20",b"1.23.1",
            b"1.23.2+build",b"v1.23.2",b" 1.23.2",b"1.23.2 ",b"",b"1.23.2\0extra"] {
            assert_eq!(checked_runtime_version(bytes).unwrap_err().code,"runtime_version_mismatch");
        }
    }
    #[test]
    fn rejects_invalid_utf8_without_fabricating_a_version() {
        assert_eq!(checked_runtime_version(&[0xff]).unwrap_err().code,"runtime_version_unavailable");
    }
}

fn execute(request:WorkerRequest)->Result<WorkerResult,DetectorError> {
    request.projection.validate()?;
    if let Some([x0,y0,x1,y1])=request.region {
        if x1<=x0||y1<=y0||x1-x0!=request.projection.width||y1-y0!=request.projection.height
            ||x1>request.projection.canonical_width||y1>request.projection.canonical_height{return Err(failure("invalid_transform"));}
    }
    if request.run_id.is_empty()||request.run_id.len()>128||request.timeout_ms==0{return Err(failure("invalid_request"));}
    if [&request.artifact_root,&request.model_dir,&request.lock_path,&request.runtime_library,&request.label_map_path].iter().any(|p|!p.is_absolute()){return Err(failure("invalid_request"));}
    let configured_lock:Value=serde_json::from_slice(&bytes(request.lock_path.parent().ok_or_else(||failure("model_lock_missing"))?,&request.lock_path,1024*1024,"model_lock_missing")?).map_err(|_|failure("model_manifest_invalid"))?;
    let pinned:Value=serde_json::from_str(include_str!("../../../../../models/detector/source-lock.json")).map_err(|_|failure("model_manifest_invalid"))?;
    if configured_lock["model_id"]!=pinned["model_id"]||configured_lock["files"]!=pinned["files"]{return Err(failure("source_hash_mismatch"));}
    let raw=bytes(&request.model_dir,&request.model_dir.join("manifest.json"),1024*1024,"model_missing")?;
    let manifest:Manifest=serde_json::from_slice(&raw).map_err(|_|failure("model_manifest_invalid"))?;
    if manifest.schema_version!=1||manifest.model_id!=MODEL_ID{return Err(failure("model_manifest_invalid"));}
    if manifest.source_files.len()!=4{return Err(failure("source_hash_mismatch"));}
    for pin in pinned["files"].as_array().ok_or_else(||failure("model_manifest_invalid"))? {
        if !manifest.source_files.iter().any(|a|pin["path"]==a.path&&pin["sha256"]==a.sha256&&pin["bytes"].as_u64()==Some(a.bytes)){return Err(failure("source_hash_mismatch"));}
    }
    if manifest.onnx.path!="model.onnx" {return Err(failure("model_manifest_invalid"));}
    let model=checked(&request.model_dir,&request.model_dir.join(&manifest.onnx.path),256*1024*1024,&manifest.onnx.sha256,"model_missing")?;
    if model.len() as u64!=manifest.onnx.bytes||graph_header(&model)?!=(manifest.ir_version,manifest.opset){return Err(failure("model_graph_invalid"));}
    let mapping:BTreeMap<String,String>=serde_json::from_slice(&bytes(request.label_map_path.parent().ok_or_else(||failure("mapping_missing"))?,&request.label_map_path,1024*1024,"mapping_missing")?).map_err(|_|failure("invalid_mapping"))?;
    // Validate mapping before native code or inference, including an empty valid map.
    if mapping.len()>4096||mapping.iter().any(|(k,v)|k.is_empty()||v.is_empty()||k.chars().count()>128||v.chars().count()>128){return Err(failure("invalid_mapping"));}
    if manifest.id2label.iter().any(|(index,category)|*index>=80||category.is_empty()||category.chars().count()>128){return Err(failure("invalid_mapping"));}
    let input=tensor(&request.artifact_root,&request.input,&request.projection)?;
    // The developer request was already charged by the parent. Redeem once
    // BEFORE any native/DLL/session loading; later failure never refunds it.
    // None is the ordinary product path and imposes no end-user forward cap.
    if let Some(ticket)=&request.budget_ticket{budget::redeem(ticket)?;}
    let runtime_root=request.runtime_library.parent().ok_or_else(||failure("runtime_library_missing"))?;
    let _runtime=checked_file(runtime_root,&request.runtime_library,64*1024*1024,&request.runtime_sha256,"runtime_library_missing")?;
    #[cfg(windows)]
    if request.runtime_sha256!=super::WINDOWS_CPU_DLL_SHA256{return Err(failure("runtime_hash_mismatch"));}
    #[cfg(windows)]
    let _shared_runtime=checked_file(runtime_root,&runtime_root.join("onnxruntime_providers_shared.dll"),1024*1024,
        "a2b3a50956aa75a9879c8472bc7df4f7a8072bcd2db19a1b7d988e7688f293ef","runtime_library_missing")?;
    let environment=ort::init_from(&request.runtime_library).map_err(|_|failure("runtime_load_failed"))?
        .with_execution_providers([ort::ep::CPU::default().build()]).build().map_err(|_|failure("runtime_load_failed"))?;
    let runtime_version=loaded_runtime_version(&environment)?;
    let mut session=ort::session::Session::builder(&environment).map_err(|_|failure("runtime_load_failed"))?
        .commit_from_memory_directly(&model).map_err(|_|failure("model_load_failed"))?;
    let valid=|outlet:&ort::value::Outlet,name:&str,expected:&[i64]|outlet.name()==name&&outlet.dtype().tensor_type()==Some(ort::value::TensorElementType::Float32)&&outlet.dtype().tensor_shape().is_some_and(|shape|&shape[..]==expected);
    if session.inputs().len()!=1||!valid(&session.inputs()[0],"pixel_values",&[1,3,640,640])||session.outputs().len()!=2
        ||!session.outputs().iter().any(|o|valid(o,"logits",&[1,300,80]))||!session.outputs().iter().any(|o|valid(o,"pred_boxes",&[1,300,4])){return Err(failure("shape_mismatch"));}
    let mut tensor_hasher=Sha256::new();for value in &input {tensor_hasher.update(value.to_le_bytes());}
    let input_tensor_sha256=format!("{:x}",tensor_hasher.finalize());
    let input=ort::value::Tensor::from_array(([1usize,3,640,640],input.into_boxed_slice())).map_err(|_|failure("shape_mismatch"))?;
    // Exactly one native forward, no warmup/retry. Parent reclaims the process on deadline.
    let outputs=session.run(ort::inputs!["pixel_values"=>input]).map_err(|_|failure("inference_failed"))?;
    let (logits_shape,logits)=outputs["logits"].try_extract_tensor::<f32>().map_err(|_|failure("shape_mismatch"))?;
    let (boxes_shape,boxes)=outputs["pred_boxes"].try_extract_tensor::<f32>().map_err(|_|failure("shape_mismatch"))?;
    if &logits_shape[..]!=[1,300,80]||&boxes_shape[..]!=[1,300,4]{return Err(failure("shape_mismatch"));}
    let decoded=decode(logits,boxes,&manifest.id2label,&mapping,&request.projection)?;
    // Nonfinite raw values are not serialized as fake null tensors. Decoded dropped stats remain valid.
    if request.return_raw&&logits.iter().chain(boxes).any(|v|!v.is_finite()){return Err(failure("nonfinite_output"));}
    Ok(WorkerResult{run_id:request.run_id.clone(),input_tensor_sha256,projection:request.projection,region:request.region,decoded,raw_logits:request.return_raw.then(||logits.to_vec()),raw_boxes:request.return_raw.then(||boxes.to_vec()),receipt:ExecutionReceipt{
        implementation:"Rust/ort-2.0.0-rc.15".into(),runtime_version,execution_provider:"CPUExecutionProvider".into(),model_id:MODEL_ID.into(),model_sha256:manifest.onnx.sha256,run_id:request.run_id,cost:None,cost_status:"unknown".into()}})
}
/// Called before server/DB/config initialization. Stdout contains one protocol response only.
pub fn worker_stdio()->Result<(),DetectorError> {
    let raw=read_frame(&mut BufReader::new(std::io::stdin().lock()))?.ok_or_else(||failure("truncated_message"))?;
    let text=std::str::from_utf8(&raw).map_err(|_|failure("invalid_line"))?;
    let envelope=parse_envelope(text).map_err(|e|DetectorError::new("invalid_envelope",e.to_string()))?;
    if envelope.kind!=EnvelopeKind::Request{return Err(failure("unknown_method"));}
    let result=match envelope.method {
        EnvelopeMethod::StartRun=>serde_json::from_value::<WorkerRequest>(envelope.payload).map_err(|_|failure("invalid_request"))
            .and_then(execute).and_then(|result|serde_json::to_value(result).map_err(|_|failure("worker_protocol"))),
        EnvelopeMethod::Probe=>super::probe::preprocess(envelope.payload),
        _=>return Err(failure("unknown_method")),
    };
    let payload=match result {Ok(result)=>json!({"result":result}),Err(error)=>json!({"error":error})};
    let response=RuntimeEnvelope{protocol_version:1,id:envelope.id,kind:EnvelopeKind::Response,method:envelope.method,payload};
    let line=response.to_line().map_err(|_|failure("message_too_large"))?;
    let mut out=std::io::stdout().lock();out.write_all(line.as_bytes())?;out.write_all(b"\n")?;out.flush()?;Ok(())
}

