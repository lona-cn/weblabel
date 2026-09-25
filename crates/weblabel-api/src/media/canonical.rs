use std::io::{BufReader, Cursor};

use exif::{In, Reader as ExifReader, Tag};
use image::{codecs::png::PngEncoder, ImageEncoder, RgbaImage};
use sha2::{Digest, Sha256};

use super::limits::{bounded_reader, inspect, MediaError};

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalImage {
    pub rgba: RgbaImage,
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub exif_orientation: u8,
    pub original_to_canonical: [f64; 9],
    pub sha256: String,
}

pub fn canonicalize_bytes(bytes: &[u8]) -> Result<CanonicalImage, MediaError> {
    canonicalize_bytes_with_mime(bytes, None)
}

pub fn canonicalize_bytes_with_mime(
    bytes: &[u8],
    declared_mime: Option<&str>,
) -> Result<CanonicalImage, MediaError> {
    let (_, width, height) = inspect(bytes, declared_mime)?;
    let orientation = exif_orientation(bytes)?;
    let decoded = bounded_reader(bytes)?
        .decode()
        .map_err(|_| MediaError::InvalidImage)?;
    if decoded.width() != width || decoded.height() != height {
        return Err(MediaError::InvalidImage);
    }
    let source = decoded.to_rgba8();
    let transformed = apply_orientation(source, orientation);
    let (canonical_width, canonical_height) = transformed.dimensions();
    let matrix = orientation_matrix(width, height, orientation)?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            transformed.as_raw(),
            canonical_width,
            canonical_height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| MediaError::InvalidImage)?;
    let digest = sha256_hex(&png);
    Ok(CanonicalImage {
        rgba: transformed,
        png,
        width: canonical_width,
        height: canonical_height,
        exif_orientation: orientation,
        original_to_canonical: matrix,
        sha256: digest,
    })
}

fn exif_orientation(bytes: &[u8]) -> Result<u8, MediaError> {
    let mut input = BufReader::new(Cursor::new(bytes));
    let Ok(exif) = ExifReader::new().read_from_container(&mut input) else {
        return if has_exif_segment(bytes) {
            Err(MediaError::InvalidImage)
        } else {
            Ok(1)
        };
    };
    let Some(field) = exif.get_field(Tag::Orientation, In::PRIMARY) else {
        return Ok(1);
    };
    let orientation = field
        .value
        .get_uint(0)
        .ok_or(MediaError::InvalidOrientation)?;
    u8::try_from(orientation)
        .ok()
        .filter(|value| (1..=8).contains(value))
        .ok_or(MediaError::InvalidOrientation)
}

fn apply_orientation(image: RgbaImage, orientation: u8) -> RgbaImage {
    match orientation {
        1 => image,
        2 => image::imageops::flip_horizontal(&image),
        3 => image::imageops::rotate180(&image),
        4 => image::imageops::flip_vertical(&image),
        5 => image::imageops::flip_horizontal(&image::imageops::rotate90(&image)),
        6 => image::imageops::rotate90(&image),
        7 => image::imageops::flip_vertical(&image::imageops::rotate90(&image)),
        8 => image::imageops::rotate270(&image),
        _ => unreachable!("orientation is validated before transformation"),
    }
}

fn orientation_matrix(width: u32, height: u32, orientation: u8) -> Result<[f64; 9], MediaError> {
    let w = f64::from(width);
    let h = f64::from(height);
    let (a, b, c, d, e, f) = match orientation {
        1 => (1.0, 0.0, 0.0, 0.0, 1.0, 0.0),
        2 => (-1.0, 0.0, w, 0.0, 1.0, 0.0),
        3 => (-1.0, 0.0, w, 0.0, -1.0, h),
        4 => (1.0, 0.0, 0.0, 0.0, -1.0, h),
        5 => (0.0, 1.0, 0.0, 1.0, 0.0, 0.0),
        6 => (0.0, -1.0, h, 1.0, 0.0, 0.0),
        7 => (0.0, -1.0, h, -1.0, 0.0, w),
        8 => (0.0, 1.0, 0.0, -1.0, 0.0, w),
        _ => return Err(MediaError::InvalidOrientation),
    };
    Ok([a, b, c, d, e, f, 0.0, 0.0, 1.0])
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut value = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    value
}
fn has_exif_segment(bytes: &[u8]) -> bool {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return false;
    }
    let mut offset = 2;
    while offset + 4 <= bytes.len() && bytes[offset] == 0xff {
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let Some(&marker) = bytes.get(offset) else {
            return false;
        };
        offset += 1;
        if marker == 0xda || marker == 0xd9 {
            return false;
        }
        if matches!(marker, 0xd8 | 0x01 | 0xd0..=0xd7) {
            continue;
        }
        let Some(length) = bytes.get(offset..offset + 2) else {
            return false;
        };
        let length = usize::from(u16::from_be_bytes([length[0], length[1]]));
        if length < 2 || offset + length > bytes.len() {
            return false;
        }
        if marker == 0xe1 && bytes.get(offset + 2..offset + 8) == Some(&b"Exif\0\0"[..]) {
            return true;
        }
        offset += length;
    }
    false
}
