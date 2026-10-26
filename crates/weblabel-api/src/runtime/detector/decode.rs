use std::collections::BTreeMap;
use serde::{Deserialize,Serialize};
use super::DetectorError;

#[derive(Debug,Clone,PartialEq,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Projection {
    pub width:u32, pub height:u32, pub canonical_width:u32, pub canonical_height:u32,
    pub transform_to_canonical:[f64;9],
}
impl Projection {
    pub fn validate(&self)->Result<(),DetectorError> {
        if [self.width,self.height,self.canonical_width,self.canonical_height].iter().any(|v|*v==0 || *v>32768)
            || u64::from(self.width)*u64::from(self.height)>64*1024*1024
            || self.transform_to_canonical.iter().any(|v|!v.is_finite()) {
            return Err(DetectorError::new("invalid_transform","invalid detector dimensions or transform"));
        }
        Ok(())
    }
}
#[derive(Debug,Serialize,Deserialize)]
pub struct Detection { pub query:usize, pub label_id:String, pub category:String, pub score:f64, pub bbox_xyxy:[f64;4] }
#[derive(Debug,Serialize,Deserialize)]
pub struct UnsupportedDetection { pub query:usize, pub code:String, pub category:Option<String>, pub detector_index:usize, pub score:f64, pub bbox_xyxy:[f64;4] }
#[derive(Debug,Serialize,Deserialize)]
pub struct DecodeResult { pub detections:Vec<Detection>,pub unsupported:Vec<UnsupportedDetection>, pub dropped_non_finite:usize,pub dropped_below_threshold:usize,pub dropped_degenerate:usize }

fn clamp(b:[f64;4],w:u32,h:u32)->[f64;4] { [b[0].clamp(0.,w as f64),b[1].clamp(0.,h as f64),b[2].clamp(0.,w as f64),b[3].clamp(0.,h as f64)] }
fn project(b:[f64;4],p:&Projection)->Result<[f64;4],DetectorError> {
    let m=&p.transform_to_canonical; let mut out=[f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY];
    for (x,y) in [(b[0],b[1]),(b[2],b[1]),(b[2],b[3]),(b[0],b[3])] {
        let z=m[6]*x+m[7]*y+m[8];
        if z==0. { return Err(DetectorError::new("invalid_transform","corner maps to infinity")); }
        let x=(m[0]*x+m[1]*y+m[2])/z; let y=(m[3]*x+m[4]*y+m[5])/z;
        if !x.is_finite() || !y.is_finite() { return Err(DetectorError::new("invalid_transform","nonfinite projected corner")); }
        out[0]=out[0].min(x);out[1]=out[1].min(y);out[2]=out[2].max(x);out[3]=out[3].max(y);
    }
    Ok(clamp(out,p.canonical_width,p.canonical_height))
}

pub fn decode(logits:&[f32],boxes:&[f32],id2label:&BTreeMap<usize,String>,mapping:&BTreeMap<String,String>,p:&Projection)->Result<DecodeResult,DetectorError> {
    p.validate()?;
    if logits.len()!=300*80 || boxes.len()!=300*4 { return Err(DetectorError::new("shape_mismatch","expected logits[1,300,80] and pred_boxes[1,300,4]")); }
    if mapping.len()>4096 || mapping.iter().any(|(k,v)|k.is_empty()||k.chars().count()>128||v.is_empty()||v.chars().count()>128)
        || id2label.iter().any(|(k,v)|*k>=80||v.is_empty()||v.chars().count()>128) {
        return Err(DetectorError::new("invalid_mapping","explicit category mapping is invalid"));
    }
    let mut out=DecodeResult{detections:vec![],unsupported:vec![],dropped_non_finite:0,dropped_below_threshold:0,dropped_degenerate:0};
    for (query,(row,b)) in logits.chunks_exact(80).zip(boxes.chunks_exact(4)).enumerate() {
        if row.iter().chain(b).any(|v|!v.is_finite()) {out.dropped_non_finite+=1;continue;}
        // Strict greater-than keeps the first class on ties, as the pinned decoder does.
        let mut index=0; for i in 1..80 {if row[i]>row[index] {index=i;}}
        let value=f64::from(row[index]); let score=if value>=0. {1./(1.+(-value).exp())} else {let e=value.exp();e/(1.+e)};
        if score<0.5 {out.dropped_below_threshold+=1;continue;}
        let [cx,cy,w,h]=[f64::from(b[0]),f64::from(b[1]),f64::from(b[2]),f64::from(b[3])];
        // Normalized -> input pixels -> one inverse stretch; algebraically simplified.
        let original=clamp([(cx-w/2.)*p.width as f64,(cy-h/2.)*p.height as f64,(cx+w/2.)*p.width as f64,(cy+h/2.)*p.height as f64],p.width,p.height);
        if original[2]<=original[0] || original[3]<=original[1] {out.dropped_degenerate+=1;continue;}
        let bbox=project(original,p)?;
        if bbox[2]<=bbox[0] || bbox[3]<=bbox[1] {out.dropped_degenerate+=1;continue;}
        // Reuse the domain's canonical f64 bounds contract, not a second persistent geometry.
        let domain_bbox=annotation_domain::BBox::new(bbox[0],bbox[1],bbox[2],bbox[3]);
        annotation_domain::geometry::validate_bbox(&domain_bbox,p.canonical_width,p.canonical_height)
            .map_err(|_|DetectorError::new("invalid_transform","canonical geometry rejected"))?;
        let category=id2label.get(&index);
        match category.and_then(|c|mapping.get(c).map(|id|(c,id))) {
            Some((category,id))=>out.detections.push(Detection{query,label_id:id.clone(),category:category.clone(),score,bbox_xyxy:bbox}),
            None=>out.unsupported.push(UnsupportedDetection{query,code:"unsupported_category".into(),category:category.cloned(),detector_index:index,score,bbox_xyxy:bbox}),
        }
    }
    out.detections.sort_by(|a,b|b.score.total_cmp(&a.score));out.unsupported.sort_by(|a,b|b.score.total_cmp(&a.score));
    Ok(out)
}
