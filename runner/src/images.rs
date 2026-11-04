//! The single raster policy for attachments and tool results, plus request-only retention.
use std::{io::Cursor, sync::Arc, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageDecoder, ImageReader};
use tokio::sync::{Semaphore, TryAcquireError};

use crate::api::wire::{Block, Message, ResultPart};

pub const MAX_IMAGE_INPUT: u64 = 20 * 1024 * 1024;
pub const MAX_IMAGE_OUTPUT: usize = 1024 * 1024;
pub const MAX_IMAGE_DIMENSION: u32 = 1568;
const MAX_PIXELS: u64 = 100_000_000;
const MAX_ALLOCATION: u64 = 128 * 1024 * 1024;
static DECODERS: std::sync::LazyLock<Arc<Semaphore>> = std::sync::LazyLock::new(|| Arc::new(Semaphore::new(2)));

// The production try-acquire pool is process-global. Independent unit tests must
// not consume one another's slots; never raise the production limit for tests.
#[cfg(test)]
pub(crate) async fn test_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    TESTS.lock().await
}

fn encode(bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|_| "Cannot identify image")?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_ALLOCATION);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(|_| "Cannot decode image")?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS || decoder.total_bytes() > MAX_ALLOCATION {
        return Err("Image exceeds the pixel or memory limit".into());
    }
    let decoded = image::DynamicImage::from_decoder(decoder).map_err(|_| "Cannot decode image within memory limits")?;
    let mut resized = if width.max(height) > MAX_IMAGE_DIMENSION { decoded.thumbnail(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION) } else { decoded };
    loop {
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85).encode_image(&resized.to_rgb8()).map_err(|_| "Cannot encode image")?;
        let transparent = resized.has_alpha() && resized.to_rgba8().pixels().any(|p| p[3] != 255);
        let (media_type, output) = if transparent {
            let mut png = Cursor::new(Vec::new());
            resized.write_to(&mut png, image::ImageFormat::Png).map_err(|_| "Cannot encode image")?;
            let png = png.into_inner();
            if png.len() < jpeg.len() { ("image/png", png) } else { ("image/jpeg", jpeg) }
        } else { ("image/jpeg", jpeg) };
        if output.len() <= MAX_IMAGE_OUTPUT { return Ok((media_type.into(), output)); }
        let dimension = resized.width().max(resized.height()) * 3 / 4;
        if dimension == 0 { return Err("Image cannot fit the output limit".into()); }
        resized = resized.thumbnail(dimension, dimension);
    }
}

pub async fn normalise(bytes: Vec<u8>) -> Result<(String, Vec<u8>), String> {
    if bytes.len() as u64 > MAX_IMAGE_INPUT { return Err("Image exceeds the 20 MiB input limit".into()); }
    let permit = DECODERS.clone().try_acquire_owned().map_err(|e| match e {
        TryAcquireError::NoPermits => "Image processing is busy; try again",
        TryAcquireError::Closed => "Image processing is unavailable",
    })?;
    // A timed-out blocking job cannot be killed; retain its permit until it actually exits.
    let job = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        std::panic::catch_unwind(|| encode(&bytes)).unwrap_or_else(|_| Err("Cannot decode image".into()))
    });
    tokio::time::timeout(Duration::from_secs(10), job).await.map_err(|_| "Image processing timed out")?
        .map_err(|_| "Image processing failed")?
}

pub async fn normalise_base64(data: String) -> Result<(String, String), String> {
    if data.len() as u64 > MAX_IMAGE_INPUT.div_ceil(3) * 4 { return Err("Image exceeds the 20 MiB input limit".into()); }
    let bytes = STANDARD.decode(data).map_err(|_| "Cannot read image data")?;
    let (media_type, bytes) = normalise(bytes).await?;
    Ok((media_type, STANDARD.encode(bytes)))
}

pub async fn normalise_parts(parts: &mut [ResultPart]) -> bool {
    let mut ok = true;
    for part in parts {
        if let ResultPart::Image { data, .. } = part {
            *part = match normalise_base64(std::mem::take(data)).await {
                Ok((media_type, data)) => ResultPart::Image { media_type, data },
                Err(text) => { ok = false; ResultPart::Text { text } }
            };
        }
    }
    ok
}

fn placeholder(label: &str) -> String {
    let label: String = label.chars().filter(|c| !c.is_control()).take(80).collect();
    format!("[image removed to save context: {label}]")
}

pub fn for_request(messages: &[Message]) -> Vec<Message> {
    let mut messages = messages.to_vec();
    let mut remaining = 8usize;
    for message in messages.iter_mut().rev() {
        for block in message.content.iter_mut().rev() {
            match block {
                Block::Image { id, .. } => {
                    if remaining > 0 { remaining -= 1; } else {
                        *block = Block::Text { text: placeholder(id.as_deref().unwrap_or("attachment")), opaque: None };
                    }
                }
                Block::ToolResult { name, content, .. } => {
                    for part in content.iter_mut().rev() {
                        if matches!(part, ResultPart::Image { .. }) {
                            if remaining > 0 { remaining -= 1; } else { *part = ResultPart::Text { text: placeholder(name) }; }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    messages
}

pub fn serialize_request_images<S: serde::Serializer>(messages: &[Message], serializer: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&for_request(messages), serializer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::wire::{Metadata, ResponsesRequest, Role};

    fn png(width: u32, height: u32, alpha: bool) -> Vec<u8> {
        let image = if alpha { image::DynamicImage::new_rgba8(width, height) } else { image::DynamicImage::new_rgb8(width, height) };
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    #[tokio::test]
    async fn large_small_transparent_and_invalid_images() {
        let _images = test_guard().await;
        for (width, height, alpha) in [(6000, 4000, false), (64, 48, false), (64, 48, true)] {
            let (kind, bytes) = normalise(png(width, height, alpha)).await.unwrap();
            let decoded = image::load_from_memory(&bytes).unwrap();
            assert!(bytes.len() <= MAX_IMAGE_OUTPUT);
            assert_eq!(decoded.width(), width.min(MAX_IMAGE_DIMENSION));
            if width == 64 { assert_eq!(decoded.height(), height); }
            if alpha { assert_eq!(kind, "image/png"); assert_eq!(decoded.to_rgba8().get_pixel(0, 0)[3], 0); }
        }
        for bytes in [b"corrupt".to_vec(), b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec()] {
            assert!(normalise(bytes).await.is_err());
        }
    }

    #[test]
    fn declared_bomb_is_rejected_before_pixel_allocation() {
        let mut bytes = Vec::new();
        image::codecs::gif::GifEncoder::new(&mut bytes).encode_frame(image::Frame::new(image::RgbaImage::new(1, 1))).unwrap();
        bytes[6..8].copy_from_slice(&40000u16.to_le_bytes());
        bytes[8..10].copy_from_slice(&40000u16.to_le_bytes());
        assert_eq!(encode(&bytes).unwrap_err(), "Image exceeds the pixel or memory limit");
    }

    #[test]
    fn animated_gif_uses_first_frame() {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            for color in [[255, 0, 0, 255], [0, 255, 0, 255]] {
                encoder.encode_frame(image::Frame::new(image::RgbaImage::from_pixel(32, 32, image::Rgba(color)))).unwrap();
            }
        }
        let (kind, output) = encode(&bytes).unwrap();
        assert_eq!(kind, "image/jpeg");
        let image = image::load_from_memory(&output).unwrap().to_rgb8();
        assert!(image.get_pixel(0, 0)[0] > 240);
        assert!(image.get_pixel(0, 0)[1] < 10);
    }

    #[tokio::test]
    async fn browser_postprocessing_caps_both_viewports() {
        let _images = test_guard().await;
        let mut parts = vec![];
        for (w, h) in [(1440, 900), (390, 844)] {
            parts.push(ResultPart::Image { media_type: "image/png".into(), data: STANDARD.encode(png(w, h, false)) });
        }
        assert!(normalise_parts(&mut parts).await);
        for part in parts {
            let ResultPart::Image { data, .. } = part else { panic!("missing screenshot") };
            let bytes = STANDARD.decode(data).unwrap();
            assert!(bytes.len() <= MAX_IMAGE_OUTPUT);
            let image = image::load_from_memory(&bytes).unwrap();
            assert!(image.width().max(image.height()) <= MAX_IMAGE_DIMENSION);
        }
    }

    #[tokio::test]
    async fn occupied_decoder_slots_return_busy_and_recover_after_release() {
        let _images = test_guard().await;
        let permits = DECODERS.clone().try_acquire_many_owned(2).unwrap();
        assert_eq!(normalise(png(16, 16, false)).await.unwrap_err(), "Image processing is busy; try again");
        drop(permits);
        assert!(normalise(png(16, 16, false)).await.is_ok());
    }

    #[test]
    fn request_body_keeps_latest_eight_without_changing_history() {
        let image = || Block::Image { media_type: "image/png".into(), data: "original".into(), id: Some("x".repeat(200)) };
        let mut history = vec![Message { role: Role::User, content: (0..6).map(|_| image()).collect() }];
        history.push(Message { role: Role::Tool, content: vec![Block::ToolResult {
            call_id: "call".into(), name: "browser".into(), is_error: false,
            content: (0..6).map(|_| ResultPart::Image { media_type: "image/png".into(), data: "original".into() }).collect(),
        }] });
        let original = history.clone();
        let request = ResponsesRequest { model: "test".into(), system: None, messages: history, tools: vec![], max_output_tokens: None, reasoning: None, metadata: Metadata::default() };
        let body = serde_json::to_value(&request).unwrap();
        let wire = body.to_string();
        assert_eq!(wire.matches("\"type\":\"image\"").count(), 8);
        assert_eq!(wire.matches("image removed to save context:").count(), 4);
        assert_eq!(request.messages, original);
        assert!(body["messages"][0]["content"][0]["text"].as_str().unwrap().len() < 120);
        assert_eq!(body["messages"][1]["content"][0]["content"].as_array().unwrap().len(), 6);
    }
}
