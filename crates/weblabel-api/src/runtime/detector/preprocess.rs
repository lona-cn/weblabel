//! Torch2.14 CPU uint8 bilinear antialias, as selected by the original
//! Transformers5.17 RTDetrImageProcessor/Torchvision0.29.1 backend.
//! ATen UpSampleKernel.cpp computes f64 coefficients then axis-global int16
//! precision; AVX's horizontal/vertical uint8 passes are integer-equivalent here.
//! This is deliberately NOT Pillow's fixed22-bit quantization or image::Triangle.
use super::{DetectorError, INPUT_FLOATS};
const SIDE:usize=640;
struct Bound {start:usize,offset:usize,count:usize}
struct Axis {bounds:Vec<Bound>,weights:Vec<i64>,precision:u32}

fn coefficients(input:usize)->Axis {
    let scale=input as f64/SIDE as f64;
    let support=scale.max(1.);
    let inverse_scale=if scale>=1. {1./scale}else{1.};
    let maximum_count=support.ceil() as usize*2+1;
    let mut bounds=Vec::with_capacity(SIDE);
    let mut weights=Vec::with_capacity(SIDE*maximum_count);
    let mut maximum_weight=0f64;
    for x in 0..SIDE {
        let center=scale*(x as f64+0.5);
        // Match C++ truncation toward zero before bounds clipping.
        let start=((center-support+0.5) as isize).max(0) as usize;
        let end=(((center+support+0.5) as isize).max(0) as usize).min(input);
        let count=(end-start).min(maximum_count);
        let offset=weights.len();let mut total=0.;
        for index in start..start+count {
            // Keep multiplication by inverse_scale, not division: coefficient
            // quantization near a half-integer must match ATen's operation order.
            let distance=((index as f64-center+0.5)*inverse_scale).abs();
            let weight=if distance<1. {1.-distance}else{0.};
            weights.push(weight);total+=weight;
        }
        if total!=0. {
            for weight in &mut weights[offset..] {
                *weight/=total;maximum_weight=maximum_weight.max(*weight);
            }
        }
        bounds.push(Bound{start,offset,count});
    }
    // ATen selects one precision for the WHOLE axis so all quantized coefficients
    // fit signed int16. It is commonly14 for enlargement, not Pillow's22.
    let precision=(0..22u32).find(|bits|(0.5+maximum_weight*((1u64<<(bits+1)) as f64)) as i64>=(1<<15)).unwrap_or(22);
    let multiplier=(1u64<<precision) as f64;
    let weights=weights.into_iter().map(|value|(0.5+value*multiplier) as i64).collect();
    Axis{bounds,weights,precision}
}

pub fn preprocess_rgb(rgb:&[u8],width:u32,height:u32)->Result<Vec<f32>,DetectorError> {
    let (w,h)=(width as usize,height as usize);
    if w==0||h==0||w>32768||h>32768||w.checked_mul(h).is_none_or(|n|n>64*1024*1024)||rgb.len()!=w*h*3 {
        return Err(DetectorError::new("invalid_image","invalid RGB dimensions or byte length"));
    }
    // ATen skips an unchanged axis entirely. No identity pass/allocation is needed.
    let intermediate=if w!=SIDE {
        let axis=coefficients(w);let mut resized=vec![0u8;SIDE*h*3];
        for y in 0..h {for (x,bound) in axis.bounds.iter().enumerate() {for channel in 0..3 {
            let weights=&axis.weights[bound.offset..bound.offset+bound.count];
            let sum=weights.iter().enumerate().fold(1i64<<(axis.precision-1),|sum,(i,weight)|sum+i64::from(rgb[(y*w+bound.start+i)*3+channel])*weight);
            resized[(y*SIDE+x)*3+channel]=(sum>>axis.precision).clamp(0,255) as u8;
        }}}
        Some(resized)
    } else {None};
    let source=intermediate.as_deref().unwrap_or(rgb);
    let vertical=(h!=SIDE).then(||coefficients(h));
    let mut tensor=vec![0.;INPUT_FLOATS];
    let rescale=1.0f32/255.0;
    for y in 0..SIDE {for x in 0..SIDE {for channel in 0..3 {
        let byte=if let Some(axis)=&vertical {
            let bound=&axis.bounds[y];let weights=&axis.weights[bound.offset..bound.offset+bound.count];
            let sum=weights.iter().enumerate().fold(1i64<<(axis.precision-1),|sum,(i,weight)|sum+i64::from(source[((bound.start+i)*SIDE+x)*3+channel])*weight);
            (sum>>axis.precision).clamp(0,255) as u8
        } else {source[(y*SIDE+x)*3+channel]};
        // Original Torch uint8 * Python float promotes to default float32 and
        // multiplies by a float32 factor; do NOT introduce a float64 division.
        tensor[channel*SIDE*SIDE+y*SIDE+x]=f32::from(byte)*rescale;
    }}}
    Ok(tensor)
}
