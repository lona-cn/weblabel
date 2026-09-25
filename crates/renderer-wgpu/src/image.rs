/// WebGPU requires bytes_per_row to be 256-byte aligned for texture writes/copies.
pub const COPY_BYTES_PER_ROW_ALIGNMENT: u32 = 256;

pub fn padded_rgba_rows(width: u32, height: u32, rgba: &[u8]) -> Option<(u32, Vec<u8>)> {
    if width == 0 || height == 0 {
        return None;
    }
    let source_stride = width.checked_mul(4)?;
    if (source_stride as usize).checked_mul(height as usize)? != rgba.len() {
        return None;
    }
    let padded_stride = (source_stride.checked_add(COPY_BYTES_PER_ROW_ALIGNMENT - 1)?
        / COPY_BYTES_PER_ROW_ALIGNMENT)
        .checked_mul(COPY_BYTES_PER_ROW_ALIGNMENT)?;
    if padded_stride == source_stride {
        return Some((source_stride, rgba.to_vec()));
    }
    let mut padded = vec![0; (padded_stride as usize).checked_mul(height as usize)?];
    for row in 0..height as usize {
        let src = row * source_stride as usize;
        let dst = row * padded_stride as usize;
        padded[dst..dst + source_stride as usize]
            .copy_from_slice(&rgba[src..src + source_stride as usize]);
    }
    Some((padded_stride, padded))
}
