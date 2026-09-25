struct View { viewport: vec2<f32>, pan: vec2<f32>, scale: f32, dpr: f32, image_size: vec2<f32>, _pad: vec2<f32> }
@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var image_tex: texture_2d<f32>;
@group(1) @binding(1) var image_sampler: sampler;
struct Out { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
    let p=array<vec2<f32>,6>(vec2(0,0),vec2(1,0),vec2(1,1),vec2(0,0),vec2(1,1),vec2(0,1))[i];
    let css=p*view.image_size*view.scale+view.pan;
    let clip=vec2(2.0*css.x/view.viewport.x-1.0,1.0-2.0*css.y/view.viewport.y);
    var o:Out; o.pos=vec4(clip,0,1); o.uv=p; return o;
}
@fragment fn fs(i:Out)->@location(0) vec4<f32> { return textureSample(image_tex,image_sampler,i.uv); }
