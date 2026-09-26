struct View { viewport: vec2<f32>, pan: vec2<f32>, scale: f32, dpr: f32, _pad: vec2<f32> }
@group(0) @binding(0) var<uniform> view: View;
struct Instance { bounds: vec4<f32>, color: vec4<f32>, flags: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(1) @binding(0) var<storage,read> instances: array<Instance>;
struct Out { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32>, @location(1) local: vec2<f32>, @location(2) extent_css: vec2<f32> }
// Half of scene::bbox_stroke_css_pixels() (1.5 CSS px). The stroke is
// centered on the bounds edge, so the quad grows by the half width on every
// side and the band never changes thickness with image zoom.
const STROKE_HALF: f32 = 0.75;
@vertex fn vs(@builtin(vertex_index) v:u32,@builtin(instance_index) n:u32)->Out {
 let corner=array<vec2<f32>,6>(vec2(0,0),vec2(1,0),vec2(1,1),vec2(0,0),vec2(1,1),vec2(0,1))[v];
 let b=instances[n].bounds; let half=vec2<f32>(STROKE_HALF,STROKE_HALF);
 let css0=b.xy*view.scale+view.pan-half; let css1=b.zw*view.scale+view.pan+half;
 let css=css0+(css1-css0)*corner; let clip=vec2(2.0*css.x/view.viewport.x-1.0,1.0-2.0*css.y/view.viewport.y);
 var o:Out; o.pos=vec4(clip,0,1); o.color=instances[n].color; o.local=corner;
 o.extent_css=(b.zw-b.xy)*view.scale+2.0*half; return o;
}
@fragment fn fs(i:Out)->@location(0) vec4<f32> {
 let q=i.local*i.extent_css;
 let d=min(min(q.x-STROKE_HALF,i.extent_css.x-STROKE_HALF-q.x),min(q.y-STROKE_HALF,i.extent_css.y-STROKE_HALF-q.y));
 if abs(d)>STROKE_HALF { discard; } return i.color;
}
