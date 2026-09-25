use std::time::Duration;

use image::{codecs::jpeg::JpegEncoder, ImageFormat, RgbImage};
use serde_json::json;
use sqlx::Row;
use tempfile::tempdir;
use weblabel_api::{
    config::ServerConfig,
    jobs::{
        queue::{JobQueue, QueueError},
        worker::MediaWorker,
    },
    media::{
        canonical::canonicalize_bytes,
        ingest::{
            enqueue_import_job, import_one, import_one_for_job, list_media, load_canonical_png,
            process_import_job, ImportInput,
        },
        limits::{check_dimensions, check_filename, inspect, MediaError, MAX_UPLOAD_BYTES},
        previews::make_preview,
    },
    storage::Repository,
};
fn jpeg_with_orientation(orientation: u16) -> Vec<u8> {
    let (width, height) = (48, 32);
    let mut pixels = RgbImage::new(width, height);
    let colors = [[240, 20, 20], [20, 220, 30], [20, 40, 240], [240, 220, 20]];
    for y in 0..height {
        for x in 0..width {
            let quadrant =
                (if y >= height / 2 { 2 } else { 0 }) + (if x >= width / 2 { 1 } else { 0 });
            pixels.put_pixel(x, y, image::Rgb(colors[quadrant]));
        }
    }
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, 100)
        .encode_image(&pixels)
        .unwrap();
    let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
    exif.extend_from_slice(&orientation.to_le_bytes());
    exif.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    let mut segment = vec![0xff, 0xe1];
    segment.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    segment.extend_from_slice(&exif);
    output.splice(2..2, segment);
    output
}
fn cmyk_jpeg_frame_header() -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x14, 8, 0, 1, 0, 1, 4];
    bytes.extend_from_slice(&[1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]);
    bytes.extend_from_slice(&[0xff, 0xd9]);
    bytes
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut chunk = Vec::new();
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(data);
    let checksum = chunk[4..].iter().fold(!0_u32, |crc, byte| {
        let mut value = crc ^ u32::from(*byte);
        for _ in 0..8 {
            value = if value & 1 == 1 {
                (value >> 1) ^ 0xedb8_8320
            } else {
                value >> 1
            };
        }
        value
    }) ^ !0_u32;
    chunk.extend_from_slice(&checksum.to_be_bytes());
    chunk
}

fn animated_png_marker() -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::new();
    header.extend_from_slice(&1u32.to_be_bytes());
    header.extend_from_slice(&1u32.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    bytes.extend(png_chunk(b"IHDR", &header));
    bytes.extend(png_chunk(b"acTL", &[0; 8]));
    bytes
}

fn png_header(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&width.to_be_bytes());
    data.extend_from_slice(&height.to_be_bytes());
    data.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(png_chunk(b"IHDR", &data));
    bytes.extend(png_chunk(b"IDAT", &[]));
    bytes.extend(png_chunk(b"IEND", &[]));
    bytes
}

#[test]
fn exif_orientations_rotate_and_mirror_asymmetric_corner_colors() {
    let samples = [
        (12.5, 8.5, [240u8, 20u8, 20u8]),
        (36.5, 8.5, [20, 220, 30]),
        (12.5, 24.5, [20, 40, 240]),
        (36.5, 24.5, [240, 220, 20]),
    ];
    let expected_matrices = [
        [1., 0., 0., 0., 1., 0., 0., 0., 1.],
        [-1., 0., 48., 0., 1., 0., 0., 0., 1.],
        [-1., 0., 48., 0., -1., 32., 0., 0., 1.],
        [1., 0., 0., 0., -1., 32., 0., 0., 1.],
        [0., 1., 0., 1., 0., 0., 0., 0., 1.],
        [0., -1., 32., 1., 0., 0., 0., 0., 1.],
        [0., -1., 32., -1., 0., 48., 0., 0., 1.],
        [0., 1., 0., -1., 0., 48., 0., 0., 1.],
    ];
    let fixtures: [&[u8]; 8] = [
        include_bytes!("../../../tests/fixtures/media/orientation-1.jpg"),
        include_bytes!("../../../tests/fixtures/media/orientation-2.jpg"),
        include_bytes!("../../../tests/fixtures/media/orientation-3.jpg"),
        include_bytes!("../../../tests/fixtures/media/orientation-4.jpg"),
        include_bytes!("../../../tests/fixtures/media/orientation-5.jpg"),
        include_bytes!("../../../tests/fixtures/media/orientation-6.jpg"),
        include_bytes!("../../../tests/fixtures/media/orientation-7.jpg"),
        include_bytes!("../../../tests/fixtures/media/orientation-8.jpg"),
    ];
    for (index, fixture) in fixtures.iter().enumerate() {
        let orientation = index as u16 + 1;
        let canonical = canonicalize_bytes(fixture).unwrap();
        let swapped = orientation >= 5;
        assert_eq!(canonical.exif_orientation, orientation as u8);
        assert_eq!(
            (canonical.width, canonical.height),
            if swapped { (32, 48) } else { (48, 32) }
        );
        assert_eq!(
            canonical.original_to_canonical,
            expected_matrices[usize::from(orientation - 1)]
        );
        for (x, y, expected) in samples {
            let matrix = canonical.original_to_canonical;
            let canonical_x = (matrix[0] * x + matrix[1] * y + matrix[2]).floor() as u32;
            let canonical_y = (matrix[3] * x + matrix[4] * y + matrix[5]).floor() as u32;
            let actual = canonical.rgba.get_pixel(canonical_x, canonical_y).0;
            for channel in 0..3 {
                assert!(actual[channel].abs_diff(expected[channel]) < 35, "orientation {orientation}, pixel ({canonical_x},{canonical_y}), channel {channel}");
            }
        }
        let png = image::load_from_memory_with_format(&canonical.png, ImageFormat::Png).unwrap();
        assert_eq!(
            (png.width(), png.height()),
            (canonical.width, canonical.height)
        );
        assert_eq!(canonical.sha256.len(), 64);
    }
}

#[test]
fn intake_rejects_byte_edge_pixel_fake_mime_and_truncated_inputs() {
    assert_eq!(
        inspect(&vec![0; MAX_UPLOAD_BYTES + 1], None),
        Err(MediaError::TooManyBytes)
    );
    assert_eq!(
        inspect(&png_header(4097, 1), None),
        Err(MediaError::EdgeLimit)
    );
    assert_eq!(
        inspect(&jpeg_with_orientation(1), Some("image/png")),
        Err(MediaError::UnsupportedFormat)
    );
    assert_eq!(
        check_dimensions(1024, 1024, 4096, 1_000_000),
        Err(MediaError::PixelLimit)
    );
    assert_eq!(
        inspect(&animated_png_marker(), Some("image/png")),
        Err(MediaError::MultipleFrames)
    );
    assert_eq!(
        inspect(
            &[0xff, 0xd8, 0xff, 0xe2, 0, 6, b'M', b'P', b'F', 0, 0xff, 0xd9],
            None
        ),
        Err(MediaError::MultipleFrames)
    );
    assert_eq!(
        inspect(&cmyk_jpeg_frame_header(), None),
        Err(MediaError::UnsupportedColor)
    );
    assert_eq!(
        canonicalize_bytes(&jpeg_with_orientation(9)),
        Err(MediaError::InvalidOrientation)
    );
    assert_eq!(check_dimensions(4096, 4096, 4096, 16_777_216), Ok(()));
    let mut truncated_png = png_header(1, 1);
    truncated_png.truncate(truncated_png.len() - 12);
    assert_eq!(inspect(&truncated_png, None), Err(MediaError::InvalidImage));
    let mut truncated_jpeg = jpeg_with_orientation(1);
    truncated_jpeg.truncate(truncated_jpeg.len() - 2);
    assert_eq!(
        inspect(&truncated_jpeg, None),
        Err(MediaError::InvalidImage)
    );
}

#[test]
fn file_names_allow_unicode_and_spaces_and_report_long_names() {
    assert!(check_filename("café 图像 01.jpg").is_ok());
    assert_eq!(
        check_filename(&"界".repeat(86)),
        Err(MediaError::FilenameTooLong)
    );
}

#[test]
fn previews_are_bounded_without_changing_canonical_coordinate_basis() {
    let canonical = canonicalize_bytes(&jpeg_with_orientation(6)).unwrap();
    let preview = make_preview(&canonical.rgba).unwrap();
    assert_eq!((canonical.width, canonical.height), (32, 48));
    assert_eq!((preview.width, preview.height), (32, 48));
    let large = RgbImage::from_pixel(1024, 768, image::Rgb([50, 80, 120]));
    let rgba = image::DynamicImage::ImageRgb8(large).to_rgba8();
    let preview = make_preview(&rgba).unwrap();
    assert_eq!((preview.width, preview.height), (512, 384));
    assert_eq!(image::guess_format(&preview.png).unwrap(), ImageFormat::Png);
}

#[tokio::test]
async fn decoding_item_failures_do_not_hide_later_successes() {
    let worker = MediaWorker::new();
    let results = worker
        .canonicalize_items(vec![
            jpeg_with_orientation(1),
            b"not an image".to_vec(),
            jpeg_with_orientation(8),
        ])
        .await;
    assert_eq!(results.len(), 3);
    assert!(results[0].is_ok());
    assert_eq!(results[1], Err(MediaError::UnsupportedFormat));
    assert!(results[2].is_ok());
}
#[tokio::test]
async fn import_commits_media_preview_coordinates_and_unprocessed_initial_revision() {
    let temp = tempdir().unwrap();
    let config = ServerConfig {
        bind: "127.0.0.1:0".parse().unwrap(),
        database_url: format!("sqlite:{}", temp.path().join("media.sqlite").display()),
        object_root: temp.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let repository = Repository::open(
        &config.database_url,
        &config.object_root,
        config.write_timeout,
    )
    .await
    .unwrap();
    let now = "2026-09-25T00:00:00Z";
    let mut tx = repository.begin_write().await.unwrap();
    sqlx::query("INSERT INTO users(user_id, username, password_hash, created_at) VALUES ('user-1', 'owner', 'test-only', ?)")
        .bind(now).execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO projects(project_id, name, description, allow_self_review, created_at) VALUES ('project-1', 'p', '', 0, ?)")
        .bind(now).execute(tx.connection()).await.unwrap();
    sqlx::query("INSERT INTO ontology_versions(ontology_version_id, project_id, version_no, body_json, created_at) VALUES ('ontology-1', 'project-1', 1, '{}', ?)")
        .bind(now).execute(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();

    let bytes = jpeg_with_orientation(6);
    let worker = MediaWorker::new();
    let input = |source: Vec<u8>| ImportInput {
        project_id: "project-1".into(),
        ontology_version_id: "ontology-1".into(),
        actor_id: "user-1".into(),
        source_group_id: "group-1".into(),
        original_name: "same café image.jpg".into(),
        declared_mime: Some("image/jpeg".into()),
        bytes: source,
    };
    let first = import_one(&repository, &worker, input(bytes.clone()))
        .await
        .unwrap();
    let second = import_one(&repository, &worker, input(jpeg_with_orientation(8)))
        .await
        .unwrap();
    assert_ne!(first.asset_id, second.asset_id);
    assert_ne!(first.asset_revision_id, second.asset_revision_id);
    assert_ne!(first.original_sha256, second.original_sha256);
    let listed = list_media(&repository, "project-1", None, 10)
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(
        (listed[0].canonical_width, listed[0].canonical_height),
        (32, 48)
    );
    assert!(listed.iter().any(|media| media.exif_orientation == 6));
    assert_eq!(listed[0].original_to_canonical.len(), 9);
    let canonical = load_canonical_png(&repository, "project-1", &first.asset_revision_id)
        .await
        .unwrap();
    assert_eq!(image::guess_format(&canonical).unwrap(), ImageFormat::Png);
    let original_path = repository
        .object_store()
        .path_for_hash(&first.original_sha256)
        .unwrap();
    assert_eq!(std::fs::read(original_path).unwrap(), bytes);
    let mut tx = repository.begin_write().await.unwrap();
    let row = sqlx::query("SELECT body_json, revision_no, parent_revision_id FROM annotation_revisions WHERE annotation_revision_id=?")
        .bind(&first.annotation_revision_id).fetch_one(tx.connection()).await.unwrap();
    tx.commit().await.unwrap();
    let body: serde_json::Value =
        serde_json::from_str(&row.try_get::<String, _>("body_json").unwrap()).unwrap();
    assert_eq!(row.try_get::<i64, _>("revision_no").unwrap(), 1);
    assert!(row
        .try_get::<Option<String>, _>("parent_revision_id")
        .unwrap()
        .is_none());
    assert_eq!(body["completion"], "unprocessed");
    assert!(body["objects"].as_array().unwrap().is_empty());
    assert_eq!(body["coordinate_space"]["type"], "canonical_image_pixels");
    let queue = JobQueue::new(repository.clone());
    let mut bad_mime = input(bytes.clone());
    bad_mime.declared_mime = Some("image/png".into());
    let enqueued = enqueue_import_job(
        &repository,
        &queue,
        "batch-op",
        vec![input(bytes.clone()), bad_mime.clone()],
    )
    .await
    .unwrap();
    let replay = enqueue_import_job(
        &repository,
        &queue,
        "batch-op",
        vec![input(bytes.clone()), bad_mime],
    )
    .await
    .unwrap();
    assert!(replay.duplicate);
    assert_eq!(enqueued.job_id, replay.job_id);
    let lease = queue
        .lease_next("media-worker", Duration::from_secs(30))
        .await
        .unwrap()
        .unwrap();
    process_import_job(&repository, &worker, &queue, &lease)
        .await
        .unwrap();
    let status = queue
        .status("project-1", &enqueued.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.state, "failed");
    assert_eq!(status.result.as_ref().unwrap()["succeeded"], 1);
    assert_eq!(status.result.unwrap()["items"][1]["state"], "failed");
}

#[tokio::test]
async fn durable_jobs_are_idempotent_bounded_and_fenced_across_expired_leases() {
    let temp = tempdir().unwrap();
    let config = ServerConfig {
        bind: "127.0.0.1:0".parse().unwrap(),
        database_url: format!("sqlite:{}", temp.path().join("jobs.sqlite").display()),
        object_root: temp.path().join("objects"),
        write_timeout: Duration::from_secs(2),
        production: true,
    };
    let repository = Repository::open(
        &config.database_url,
        &config.object_root,
        config.write_timeout,
    )
    .await
    .unwrap();
    let mut tx = repository.begin_write().await.unwrap();
    sqlx::query(
        "INSERT INTO projects(project_id, name, description, allow_self_review, created_at) \
         VALUES ('project-1', 'p', '', 0, '2026-01-01T00:00:00.000Z')",
    )
    .execute(tx.connection())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users(user_id, username, password_hash, created_at) \
         VALUES ('user-1', 'owner', 'test-only', '2026-01-01T00:00:00.000Z')",
    )
    .execute(tx.connection())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO ontology_versions(ontology_version_id, project_id, version_no, body_json, created_at) \
         VALUES ('ontology-1', 'project-1', 1, '{}', '2026-01-01T00:00:00.000Z')",
    )
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let queue = JobQueue::new(repository.clone());
    let payload = json!({"items":["content-address-1", "content-address-2"]});
    let first = queue
        .enqueue(Some("project-1"), "media_import", "op-1", &payload)
        .await
        .unwrap();
    let replay = queue
        .enqueue(Some("project-1"), "media_import", "op-1", &payload)
        .await
        .unwrap();
    assert!(!first.duplicate);
    assert_eq!(first.job_id, replay.job_id);
    assert!(replay.duplicate);
    assert!(matches!(
        queue
            .enqueue(
                Some("project-1"),
                "media_import",
                "op-1",
                &json!({"different":true})
            )
            .await,
        Err(QueueError::IdempotencyConflict)
    ));

    let stale = queue
        .lease_next("worker-a", Duration::from_millis(1))
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    let current = queue
        .lease_next("worker-b", Duration::from_secs(2))
        .await
        .unwrap()
        .unwrap();
    assert!(current.fencing_token > stale.fencing_token);
    assert!(queue
        .report_progress(&stale, 1, 2, &json!({"done":1}))
        .await
        .is_err());
    queue
        .report_progress(&current, 1, 2, &json!({"successes":1,"failures":0}))
        .await
        .unwrap();
    queue
        .finish(
            &current,
            true,
            &json!({"items":[{"state":"succeeded"},{"state":"failed","code":"INVALID_IMAGE"}]}),
        )
        .await
        .unwrap();
    let status = queue
        .status("project-1", &first.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.state, "succeeded");
    assert_eq!(status.progress_completed, 1);
    assert_eq!(status.progress_total, 2);
    assert_eq!(status.result.unwrap()["items"][1]["state"], "failed");
    assert!(queue.finish(&current, false, &json!({})).await.is_err());
    let worker = MediaWorker::new();
    let import_input = |bytes| ImportInput {
        project_id: "project-1".into(),
        ontology_version_id: "ontology-1".into(),
        actor_id: "user-1".into(),
        source_group_id: "group-1".into(),
        original_name: "replayed image.jpg".into(),
        declared_mime: Some("image/jpeg".into()),
        bytes,
    };
    let import_inputs = vec![
        import_input(jpeg_with_orientation(6)),
        import_input(jpeg_with_orientation(8)),
    ];
    let enqueued = enqueue_import_job(&repository, &queue, "import-replay", import_inputs.clone())
        .await
        .unwrap();
    let first_lease = queue
        .lease_next("import-worker-a", Duration::from_secs(2))
        .await
        .unwrap()
        .unwrap();
    let first_result = import_one_for_job(
        &repository,
        &worker,
        &first_lease,
        "0",
        import_inputs[0].clone(),
    )
    .await
    .unwrap();
    queue
        .report_progress(&first_lease, 1, 2, &json!({"succeeded":1,"failed":0}))
        .await
        .unwrap();
    let second_result = import_one_for_job(
        &repository,
        &worker,
        &first_lease,
        "1",
        import_inputs[1].clone(),
    )
    .await
    .unwrap();
    queue
        .report_progress(&first_lease, 2, 2, &json!({"succeeded":2,"failed":0}))
        .await
        .unwrap();
    let mut tx = repository.begin_write().await.unwrap();
    sqlx::query("UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=?")
        .bind(&enqueued.job_id)
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let replay_lease = queue
        .lease_next("import-worker-b", Duration::from_secs(2))
        .await
        .unwrap()
        .unwrap();
    process_import_job(&repository, &worker, &queue, &replay_lease)
        .await
        .unwrap();
    let mut tx = repository.begin_write().await.unwrap();
    let media_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM media_assets WHERE project_id='project-1'")
            .fetch_one(tx.connection())
            .await
            .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(media_count, 2);
    let replay_status = queue
        .status("project-1", &enqueued.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay_status.state, "succeeded");
    assert_eq!(replay_status.progress_completed, 2);
    assert_eq!(
        replay_status.result.as_ref().unwrap()["items"][0]["asset_id"],
        first_result.asset_id
    );
    assert_eq!(
        replay_status.result.unwrap()["items"][1]["asset_id"],
        second_result.asset_id
    );
}
