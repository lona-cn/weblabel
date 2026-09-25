struct View { viewport: vec2<f32>, pan: vec2<f32>, scale: f32, dpr: f32, _pad: vec2<f32> }
@group(0) @binding(0) var<uniform> view: View;
struct Instance { bounds: vec4<f32>, color: vec4<f32>, flags: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(1) @binding(0) var<storage,read> instances: array<Instance>;
struct Out { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32>, @location(1) local: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) v:u32,@builtin(instance_index) n:u32)->Out {
 let corner=array<vec2<f32>,6>(vec2(0,0),vec2(1,0),vec2(1,1),vec2(0,0),vec2(1,1),vec2(0,1))[v];
 let b=instances[n].bounds; let center=vec2((b.x+b.z)*0.5,(b.y+b.w)*0.5)*view.scale+view.pan;
 let half=vec2(4.0,4.0); let css=center+(corner*2.0-vec2(1.0))*half;
 let clip=vec2(2.0*css.x/view.viewport.x-1.0,1.0-2.0*css.y/view.viewport.y);
 var o:Out; o.pos=vec4(clip,0,1); o.color=instances[n].color; o.local=corner; return o;
}
@fragment fn fs(i:Out)->@location(0) vec4<f32> { return i.color; }
