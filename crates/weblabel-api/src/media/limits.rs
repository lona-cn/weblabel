use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use std::io::Cursor;

pub const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_EDGE: u32 = 4096;
pub const MAX_PIXELS: u64 = 16_777_216;
pub const MAX_FILENAME_BYTES: usize = 255;
pub const MAX_PREVIEW_EDGE: u32 = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaFormat {
    Png,
    Jpeg,
}

impl MediaFormat {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }

    pub fn from_image_format(format: ImageFormat) -> Option<Self> {
        match format {
            ImageFormat::Png => Some(Self::Png),
            ImageFormat::Jpeg => Some(Self::Jpeg),
            _ => None,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MediaError {
    #[error("media exceeds the 64 MiB upload budget")]
    TooManyBytes,
    #[error("unsupported or mismatched image type")]
    UnsupportedFormat,
    #[error("image dimensions exceed the edge limit")]
    EdgeLimit,
    #[error("image dimensions exceed the pixel budget")]
    PixelLimit,
    #[error("filename exceeds the supported length")]
    FilenameTooLong,
    #[error("invalid or incomplete image data")]
    InvalidImage,
    #[error("animated or multi-image inputs are not supported")]
    MultipleFrames,
    #[error("CMYK and unsupported color encodings are not accepted")]
    UnsupportedColor,
    #[error("EXIF orientation must be in 1..=8")]
    InvalidOrientation,
    #[error("object storage or database operation failed")]
    Storage,
}

pub fn check_filename(filename: &str) -> Result<(), MediaError> {
    if filename.is_empty()
        || filename.chars().any(char::is_control)
        || filename.len() > MAX_FILENAME_BYTES
    {
        return Err(MediaError::FilenameTooLong);
    }
    Ok(())
}

pub fn bounded_reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>, MediaError> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(MAX_PIXELS * 4 + 16 * 1024 * 1024);
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| MediaError::InvalidImage)?;
    reader.limits(limits);
    Ok(reader)
}

pub fn inspect(
    bytes: &[u8],
    declared_mime: Option<&str>,
) -> Result<(MediaFormat, u32, u32), MediaError> {
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(MediaError::TooManyBytes);
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| MediaError::InvalidImage)?;
    let format =
        MediaFormat::from_image_format(reader.format().ok_or(MediaError::UnsupportedFormat)?)
            .ok_or(MediaError::UnsupportedFormat)?;
    if declared_mime.is_some_and(|mime| mime != format.mime()) {
        return Err(MediaError::UnsupportedFormat);
    }
    if contains_mpf(bytes) || contains_png_animation_control(bytes) {
        return Err(MediaError::MultipleFrames);
    }
    if format == MediaFormat::Jpeg
        && jpeg_components(bytes).is_some_and(|components| components != 1 && components != 3)
    {
        return Err(MediaError::UnsupportedColor);
    }
    let decoder = reader
        .into_decoder()
        .map_err(|_| MediaError::InvalidImage)?;
    let (width, height) = decoder.dimensions();
    check_dimensions(width, height, MAX_EDGE, MAX_PIXELS)?;
    if format == MediaFormat::Jpeg
        && !matches!(
            decoder.color_type(),
            image::ColorType::L8 | image::ColorType::Rgb8
        )
    {
        return Err(MediaError::UnsupportedColor);
    }
    if (format == MediaFormat::Jpeg && !jpeg_has_end_marker(bytes))
        || (format == MediaFormat::Png && !png_has_end_chunk(bytes))
    {
        return Err(MediaError::InvalidImage);
    }
    Ok((format, width, height))
}

pub fn check_dimensions(
    width: u32,
    height: u32,
    max_edge: u32,
    max_pixels: u64,
) -> Result<(), MediaError> {
    if width == 0 || height == 0 {
        return Err(MediaError::InvalidImage);
    }
    if width > max_edge || height > max_edge {
        return Err(MediaError::EdgeLimit);
    }
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(MediaError::PixelLimit);
    }
    Ok(())
}

fn contains_mpf(bytes: &[u8]) -> bool {
    let mut index = 2;
    if bytes.get(..2) != Some(&[0xff, 0xd8]) {
        return false;
    }
    while index + 4 <= bytes.len() && bytes[index] == 0xff {
        let marker = bytes[index + 1];
        index += 2;
        if marker == 0xda || marker == 0xd9 {
            return false;
        }
        let Some(length_bytes) = bytes.get(index..index + 2) else {
            return false;
        };
        let length = usize::from(u16::from_be_bytes([length_bytes[0], length_bytes[1]]));
        if length < 2 || index + length > bytes.len() {
            return false;
        }
        if marker == 0xe2 && bytes.get(index + 2..index + 6) == Some(b"MPF\0") {
            return true;
        }
        index += length;
    }
    false
}

fn contains_png_animation_control(bytes: &[u8]) -> bool {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIGNATURE) {
        return false;
    }
    let mut offset = SIGNATURE.len();
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("4-byte chunk length"),
        ) as usize;
        let Some(end) = offset
            .checked_add(12)
            .and_then(|start| start.checked_add(length))
        else {
            return true;
        };
        if end > bytes.len() {
            return false;
        }
        let kind = &bytes[offset + 4..offset + 8];
        if kind == b"acTL" {
            return true;
        }
        offset = end;
        if kind == b"IEND" {
            break;
        }
    }
    false
}
fn png_has_end_chunk(bytes: &[u8]) -> bool {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIGNATURE) {
        return false;
    }
    let mut offset = SIGNATURE.len();
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("4-byte chunk length"),
        ) as usize;
        let Some(end) = offset
            .checked_add(12)
            .and_then(|start| start.checked_add(length))
        else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        if &bytes[offset + 4..offset + 8] == b"IEND" {
            return length == 0;
        }
        offset = end;
    }
    false
}

fn jpeg_has_end_marker(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xd8]) && bytes.ends_with(&[0xff, 0xd9])
}

fn jpeg_components(bytes: &[u8]) -> Option<u8> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut offset = 2;
    while offset + 4 <= bytes.len() && bytes[offset] == 0xff {
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;
        if marker == 0xda || marker == 0xd9 {
            return None;
        }
        if matches!(marker, 0xd8 | 0x01 | 0xd0..=0xd7) {
            continue;
        }
        let length = usize::from(u16::from_be_bytes([
            *bytes.get(offset)?,
            *bytes.get(offset + 1)?,
        ]));
        if length < 2 || offset + length > bytes.len() {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            return bytes.get(offset + 7).copied();
        }
        offset += length;
    }
    None
}
