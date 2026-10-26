//! Only builds untrusted candidate input. Repository/RunDriver remain the authorization funnel.
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use super::{DetectorError,WorkerResult};
fn id(run:&str,suffix:&str)->String {
    let text=format!("{run}{suffix}");if text.chars().count()<=128{return text;}
    let hash=format!("{:x}",Sha256::digest(text.as_bytes()));format!("{}#{}",run.chars().take(64).collect::<String>(),&hash[..32])
}
fn bbox(b:[f64;4])->Value{json!({"type":"bbox_xyxy","x_min":b[0],"y_min":b[1],"x_max":b[2],"y_max":b[3]})}
impl WorkerResult {
    /// Caller MUST reauthorize current run and submit through existing prediction/tool
    /// funnel. This function never writes revisions, emits events, or applies candidates.
    pub fn candidate_raw(&self)->Result<Value,DetectorError>{
        if self.run_id.is_empty()||self.run_id.chars().count()>128||self.receipt.run_id!=self.run_id{return Err(DetectorError::new("worker_protocol","candidate run identity mismatch"));}
        let changes:Vec<Value>=self.decoded.detections.iter().enumerate().map(|(i,d)|json!({
            "kind":"create","change_id":id(&self.run_id,&format!("#c{i}")),
            "object":{"object_id":id(&self.run_id,&format!("#o{i}")),"label_id":d.label_id,
                "geometry":bbox(d.bbox_xyxy),"attributes":{},
                "origin":{"type":"prediction","prediction_id":null,"model_run_id":null,"import_batch_id":null}},
            "before_hash":null,"reason":format!("detector category {:?} score {:.4}",d.category,d.score)
        })).collect();
        let issues:Vec<Value>=self.decoded.unsupported.iter().enumerate().map(|(i,d)|json!({
            "issue_id":id(&self.run_id,&format!("#u{i}")),"object_id":null,"code":"unsupported_category",
            "message":match &d.category{Some(c)=>format!("detector category {c:?} has no explicit project label mapping"),None=>format!("detector class index {} has no known category and no explicit project label mapping",d.detector_index)},
            "region":bbox(d.bbox_xyxy)
        })).collect();
        let score=self.decoded.detections.iter().map(|d|d.score).reduce(f64::max);
        Ok(json!({"changes":changes,"issues":issues,"score":score}))
    }
}
