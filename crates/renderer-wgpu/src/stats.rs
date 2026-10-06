/// Actual GPU uploads/submissions and CPU culling, cumulative since creation.
/// Owned-resource gauges are logical counts, not physical VRAM measurements.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct RendererStats {
    pub cpu_calls: u64,
    pub cpu_elapsed_ns: u64,
    pub cpu_objects_examined: u64,
    pub gpu_buffer_upload_calls: u64,
    pub gpu_buffer_upload_bytes: u64,
    pub gpu_texture_upload_calls: u64,
    pub gpu_texture_upload_bytes: u64,
    pub draw_calls: u64,
    pub gpu_submissions: u64,
    pub live_textures: u64,
    pub live_buffers: u64,
    pub buffer_creations: u64,
    pub buffer_releases: u64,
    pub rejected_resources: u64,
    pub bbox_upload_calls: u64,
    pub bbox_upload_bytes: u64,
    pub uniform_upload_bytes: u64,
    pub visible_instances: u64,
    pub logical_texture_bytes: u64,
}

impl RendererStats {
    pub fn buffer_created(&mut self) {
        self.live_buffers += 1;
        self.buffer_creations += 1;
    }
    pub fn buffer_released(&mut self) {
        self.live_buffers = self.live_buffers.saturating_sub(1);
        self.buffer_releases += 1;
    }

    pub fn record_cpu_call(&mut self, objects_examined: usize, elapsed_ns: u64) {
        self.cpu_calls = self.cpu_calls.saturating_add(1);
        self.cpu_elapsed_ns = self.cpu_elapsed_ns.saturating_add(elapsed_ns);
        self.cpu_objects_examined = self
            .cpu_objects_examined
            .saturating_add(objects_examined as u64);
    }

    pub fn texture_created(&mut self) {
        self.live_textures = self.live_textures.saturating_add(1);
    }

    pub fn texture_released(&mut self) {
        self.live_textures = self.live_textures.saturating_sub(1);
    }

    pub fn resource_rejected(&mut self) {
        self.rejected_resources = self.rejected_resources.saturating_add(1);
    }
    pub fn record_buffer_upload(&mut self, bytes: usize) {
        self.gpu_buffer_upload_calls = self.gpu_buffer_upload_calls.saturating_add(1);
        self.gpu_buffer_upload_bytes = self.gpu_buffer_upload_bytes.saturating_add(bytes as u64);
    }

    pub fn record_texture_upload(&mut self, bytes: usize) {
        self.gpu_texture_upload_calls = self.gpu_texture_upload_calls.saturating_add(1);
        self.gpu_texture_upload_bytes = self.gpu_texture_upload_bytes.saturating_add(bytes as u64);
    }

    pub fn record_submission(&mut self, draw_calls: u64) {
        self.gpu_submissions = self.gpu_submissions.saturating_add(1);
        self.draw_calls = self.draw_calls.saturating_add(draw_calls);
    }
}
