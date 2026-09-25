use image::{codecs::png::PngEncoder, imageops::FilterType, ImageEncoder, RgbaImage};

use super::limits::{MediaError, MAX_PREVIEW_EDGE};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewImage {
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

pub fn make_preview(source: &RgbaImage) -> Result<PreviewImage, MediaError> {
    let (width, height) = source.dimensions();
    if width == 0 || height == 0 {
        return Err(MediaError::InvalidImage);
    }
    let scale = (f64::from(MAX_PREVIEW_EDGE) / f64::from(width.max(height))).min(1.0);
    let preview_width = (f64::from(width) * scale).round().max(1.0) as u32;
    let preview_height = (f64::from(height) * scale).round().max(1.0) as u32;
    let resized;
    let pixels = if (preview_width, preview_height) == (width, height) {
        source.as_raw()
    } else {
        resized =
            image::imageops::resize(source, preview_width, preview_height, FilterType::Triangle);
        resized.as_raw()
    };
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            pixels,
            preview_width,
            preview_height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| MediaError::InvalidImage)?;
    Ok(PreviewImage {
        width: preview_width,
        height: preview_height,
        png,
    })
}
