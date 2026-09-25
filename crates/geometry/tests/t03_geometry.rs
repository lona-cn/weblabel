use geometry::{
    css_to_image, hit_test_bbox, image_to_css, normalize_bbox, zoom_anchor, BBox, SpatialIndex,
    Viewport,
};

fn view(scale: f64, tx: f64, ty: f64, dpr: f64) -> Viewport {
    Viewport::try_new(scale, tx, ty, 800.0, 600.0, dpr).unwrap()
}

#[test]
fn c8_vector_and_zoom_anchor_are_exact() {
    for dpr in [1.0, 1.25, 2.0, 3.0] {
        let viewport = view(2.0, 13.0, -7.0, dpr);
        assert_eq!(image_to_css([10.0, 20.0], viewport), [33.0, 33.0]);
        assert_eq!(css_to_image([33.0, 33.0], viewport), [10.0, 20.0]);
        let zoomed = zoom_anchor(viewport, [33.0, 33.0], 2.0).unwrap();
        assert_eq!([zoomed.scale, zoomed.tx, zoomed.ty], [4.0, -7.0, -47.0]);
        assert_eq!(css_to_image([33.0, 33.0], zoomed), [10.0, 20.0]);
    }
}

#[test]
fn viewport_rejects_invalid_scales_and_other_nonfinite_state() {
    for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(Viewport::try_new(scale, 0.0, 0.0, 10.0, 10.0, 1.0).is_err());
    }
    assert!(Viewport::try_new(1.0, f64::NAN, 0.0, 10.0, 10.0, 1.0).is_err());
    assert!(Viewport::try_new(1.0, 0.0, 0.0, 10.0, 10.0, 0.0).is_err());
}

#[test]
fn deterministic_scale_and_translation_roundtrips() {
    let mut state = 0x8f31_2a77_d4b9_c501_u64;
    let mut next = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 11) as f64 / ((1_u64 << 53) as f64)
    };
    for index in 0..2_000 {
        let scale = 0.01 + next() * (64.0 - 0.01);
        let tx = next() * 20_000.0 - 10_000.0;
        let ty = next() * 20_000.0 - 10_000.0;
        let point = [next() * 4096.0, next() * 4096.0];
        let viewport = view(scale, tx, ty, [1.0, 1.25, 2.0, 3.0][index % 4]);
        let roundtrip = css_to_image(image_to_css(point, viewport), viewport);
        assert!(
            (roundtrip[0] - point[0]).abs() <= 1e-8,
            "x roundtrip at {index}"
        );
        assert!(
            (roundtrip[1] - point[1]).abs() <= 1e-8,
            "y roundtrip at {index}"
        );
    }
}

#[test]
fn bbox_is_continuous_normalized_and_not_plus_one() {
    let bbox = normalize_bbox([110.0, 220.0], [10.0, 20.0]).unwrap();
    assert_eq!(bbox, BBox::new(10.0, 20.0, 110.0, 220.0));
    assert_eq!(bbox.x_max - bbox.x_min, 100.0);
    assert!(normalize_bbox([1.0, 2.0], [1.0, 3.0]).is_err());
}

#[test]
fn six_css_pixel_tolerance_covers_edges_and_corners_across_zoom() {
    let bbox = BBox::new(10.0, 20.0, 110.0, 220.0);
    for scale in [0.5, 1.0, 2.0, 8.0] {
        let viewport = view(scale, 13.0, -7.0, 2.0);
        let edge_in = image_to_css([10.0 - 5.9 / scale, 100.0], viewport);
        let edge_out = image_to_css([10.0 - 6.1 / scale, 100.0], viewport);
        let corner_in = image_to_css([10.0 - 4.0 / scale, 20.0 - 4.0 / scale], viewport);
        let corner_out = image_to_css([10.0 - 4.3 / scale, 20.0 - 4.3 / scale], viewport);
        assert!(hit_test_bbox(edge_in, &bbox, viewport, 6.0).unwrap());
        assert!(!hit_test_bbox(edge_out, &bbox, viewport, 6.0).unwrap());
        assert!(hit_test_bbox(corner_in, &bbox, viewport, 6.0).unwrap());
        assert!(!hit_test_bbox(corner_out, &bbox, viewport, 6.0).unwrap());
    }

    let tiny_view = view(1e-308, 0.0, 0.0, 1.0);
    let large_bbox = BBox::new(-1e308, -1e308, -9e307, -9e307);
    assert!(hit_test_bbox([1.0, 1.0], &large_bbox, tiny_view, 2.0).is_err());
}

#[test]
fn index_updates_removals_queries_and_stable_overlap_order() {
    let mut index = SpatialIndex::new();
    let same = BBox::new(0.0, 0.0, 10.0, 10.0);
    index.upsert("z", 4, same.clone()).unwrap();
    index.upsert("b", 2, same.clone()).unwrap();
    index.upsert("a", 2, same.clone()).unwrap();
    assert_eq!(
        index
            .query_rect(&BBox::new(9.0, 9.0, 11.0, 11.0))
            .unwrap()
            .iter()
            .map(|v| v.object_id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "z"]
    );
    assert!(index
        .query_rect(&BBox::new(10.0, 0.0, 12.0, 10.0))
        .unwrap()
        .is_empty());
    index
        .upsert("b", 5, BBox::new(30.0, 30.0, 40.0, 40.0))
        .unwrap();
    assert_eq!(index.len(), 3);
    assert_eq!(
        index
            .query_rect(&same)
            .unwrap()
            .iter()
            .map(|v| v.object_id.as_str())
            .collect::<Vec<_>>(),
        ["a", "z"]
    );
    assert!(index.remove("z"));
    assert!(!index.remove("z"));
    assert_eq!(
        index
            .query_rect(&same)
            .unwrap()
            .iter()
            .map(|v| v.object_id.as_str())
            .collect::<Vec<_>>(),
        ["a"]
    );
    assert_eq!(
        index
            .query_point([5.0, 5.0], view(1.0, 0.0, 0.0, 1.0), 0.0)
            .unwrap()[0]
            .object_id,
        "a"
    );
    assert!(index
        .query_point([f64::MAX, 5.0], view(0.5, 0.0, 0.0, 1.0), 0.0)
        .is_err());
    assert!(index
        .query_point([0.0, 0.0], view(1e-308, 0.0, 0.0, 1.0), f64::MAX)
        .is_err());
}

#[test]
fn rtree_queries_match_a_deterministic_naive_oracle_after_mutations() {
    let mut index = SpatialIndex::new();
    let mut objects = Vec::new();
    let mut seed = 17_u64;
    let mut random = || {
        seed = seed
            .wrapping_mul(2862933555777941757)
            .wrapping_add(3037000493);
        (seed >> 33) as f64 / ((1_u64 << 31) as f64)
    };
    for i in 0..180 {
        let x = random() * 500.0;
        let y = random() * 400.0;
        let bbox = BBox::new(x, y, x + 1.0 + random() * 60.0, y + 1.0 + random() * 60.0);
        index
            .upsert(format!("obj-{i:03}"), i, bbox.clone())
            .unwrap();
        objects.push((format!("obj-{i:03}"), i, bbox));
    }
    for i in (0..180).step_by(7) {
        let bbox = BBox::new(700.0 + i as f64, 700.0, 710.0 + i as f64, 710.0);
        index
            .upsert(format!("obj-{i:03}"), i as u64, bbox.clone())
            .unwrap();
        objects[i] = (format!("obj-{i:03}"), i as u64, bbox);
    }
    for i in (3..180).step_by(11) {
        assert!(index.remove(&format!("obj-{i:03}")));
        objects[i].0.clear();
    }
    for q in 0..40 {
        let x = random() * 700.0;
        let y = random() * 700.0;
        let rect = BBox::new(x, y, x + 50.0, y + 45.0);
        let mut expected = objects
            .iter()
            .filter(|(id, _, b)| {
                !id.is_empty()
                    && b.x_min < rect.x_max
                    && rect.x_min < b.x_max
                    && b.y_min < rect.y_max
                    && rect.y_min < b.y_max
            })
            .collect::<Vec<_>>();
        expected.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        let actual = index.query_rect(&rect).unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|v| v.object_id.as_str())
                .collect::<Vec<_>>(),
            expected.iter().map(|v| v.0.as_str()).collect::<Vec<_>>(),
            "rect oracle query {q}"
        );
        let point = [x + 25.0, y + 22.5];
        let viewport = view(2.5, 11.0, -9.0, 1.25);
        let css = image_to_css(point, viewport);
        let mut point_expected = objects
            .iter()
            .filter(|(id, _, b)| {
                !id.is_empty() && geometry::hit_test_bbox(css, b, viewport, 3.0).unwrap()
            })
            .collect::<Vec<_>>();
        point_expected.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        let point_actual = index.query_point(css, viewport, 3.0).unwrap();
        assert_eq!(
            point_actual
                .iter()
                .map(|v| v.object_id.as_str())
                .collect::<Vec<_>>(),
            point_expected
                .iter()
                .map(|v| v.0.as_str())
                .collect::<Vec<_>>(),
            "point oracle query {q}"
        );
    }
}
