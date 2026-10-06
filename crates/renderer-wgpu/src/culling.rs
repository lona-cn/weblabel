use crate::scene::{RenderObject, Viewport};

/// Contiguous draw ranges in the persistent instance buffer. Pan/zoom changes
/// only these CPU ranges and the view uniform, never bbox uploads.
pub fn visible_ranges(
    objects: &[RenderObject],
    view: Viewport,
    out: &mut Vec<std::ops::Range<u32>>,
    controls: &mut Vec<std::ops::Range<u32>>,
) -> usize {
    out.clear();
    controls.clear();
    if !view.valid() || view.css_width <= 0.0 || view.css_height <= 0.0 {
        return 0;
    }
    // The shader centers its CSS-space stroke on each geometric edge. DPR
    // affects rasterization, not this CSS margin or canonical coordinates.
    let margin = crate::scene::bbox_stroke_css_pixels() / 2.0;
    let left = (-view.tx - margin) / view.scale;
    let top = (-view.ty - margin) / view.scale;
    let right = (view.css_width - view.tx + margin) / view.scale;
    let bottom = (view.css_height - view.ty + margin) / view.scale;
    let control_margin = crate::scene::control_diameter_css_pixels() / 2.0;
    let control_left = (-view.tx - control_margin) / view.scale;
    let control_top = (-view.ty - control_margin) / view.scale;
    let control_right = (view.css_width - view.tx + control_margin) / view.scale;
    let control_bottom = (view.css_height - view.ty + control_margin) / view.scale;
    let mut visible = 0;
    for (i, object) in objects.iter().enumerate() {
        let [x0, y0, x1, y1] = object.bounds;
        if object.selected
            && !object.locked
            && x0 < control_right
            && x1 > control_left
            && y0 < control_bottom
            && y1 > control_top
        {
            let index = i as u32;
            if let Some(last) = controls.last_mut().filter(|range| range.end == index) {
                last.end += 1;
            } else {
                controls.push(index..index + 1);
            }
        }
        if x0 < right && x1 > left && y0 < bottom && y1 > top {
            visible += 1;
            let i = i as u32;
            if let Some(last) = out.last_mut().filter(|range| range.end == i) {
                last.end += 1;
            } else {
                out.push(i..i + 1);
            }
        }
    }
    visible
}

/// Labels are intentionally a smaller DOM/UI concern, independent of instance culling.
pub const MAX_CANVAS_LABELS: usize = 100;
/// Labels disappear below this CSS-pixel scale unless selected.
pub const LABEL_MIN_SCALE: f32 = 0.35;

/// Select visible instances without changing document order.
pub fn visible_instances<'a>(
    objects: &'a [RenderObject],
    viewport: Viewport,
    output: &mut Vec<&'a RenderObject>,
) {
    output.clear();
    if !viewport.valid() {
        return;
    }
    let left = -viewport.tx / viewport.scale;
    let top = -viewport.ty / viewport.scale;
    let right = (viewport.css_width - viewport.tx) / viewport.scale;
    let bottom = (viewport.css_height - viewport.ty) / viewport.scale;
    output.reserve(objects.len());
    for object in objects {
        let [x_min, y_min, x_max, y_max] = object.bounds;
        if x_min < right && x_max > left && y_min < bottom && y_max > top {
            output.push(object);
        }
    }
}

/// Canvas label candidates: visible selected objects first, then visible
/// objects in document order, capped to keep DOM growth bounded.
pub fn label_candidates<'a>(
    objects: &'a [RenderObject],
    viewport: Viewport,
    output: &mut Vec<&'a RenderObject>,
) {
    output.clear();
    if !viewport.valid() {
        return;
    }
    let left = -viewport.tx / viewport.scale;
    let top = -viewport.ty / viewport.scale;
    let right = (viewport.css_width - viewport.tx) / viewport.scale;
    let bottom = (viewport.css_height - viewport.ty) / viewport.scale;
    output.reserve(MAX_CANVAS_LABELS);
    for selected_pass in [true, false] {
        if !selected_pass && !labels_enabled(viewport) {
            break;
        }
        for object in objects {
            if object.selected != selected_pass {
                continue;
            }
            let [x_min, y_min, x_max, y_max] = object.bounds;
            if x_min < right && x_max > left && y_min < bottom && y_max > top {
                output.push(object);
                if output.len() == MAX_CANVAS_LABELS {
                    return;
                }
            }
        }
    }
}

pub fn labels_enabled(viewport: Viewport) -> bool {
    viewport.valid() && viewport.scale >= LABEL_MIN_SCALE
}
#[cfg(test)]
mod tests {
    use super::*;

    fn object(selected: bool, bounds: [f32; 4]) -> RenderObject {
        RenderObject {
            bounds,
            color: [1.0; 4],
            selected,
            locked: false,
        }
    }

    fn view(scale: f32) -> Viewport {
        Viewport {
            scale,
            tx: 0.0,
            ty: 0.0,
            css_width: 100.0,
            css_height: 100.0,
            dpr: 2.0,
        }
    }

    #[test]
    fn selected_controls_keep_four_css_pixel_fringe_without_admitting_locked_or_unselected_objects()
    {
        let mut ranges = Vec::new();
        let mut controls = Vec::new();
        for scale in [0.25, 1.0, 4.0] {
            for dpr in [1.0, 1.25, 2.0, 3.0] {
                let mut viewport = view(scale);
                viewport.tx = -10.0 * scale;
                viewport.ty = -10.0 * scale;
                viewport.dpr = dpr;
                for gap_css in [0.5, 2.0, 4.0, 4.5] {
                    let css_boxes = [
                        [-10.0, 20.0, -gap_css, 30.0],
                        [100.0 + gap_css, 20.0, 110.0, 30.0],
                        [20.0, -10.0, 30.0, -gap_css],
                        [20.0, 100.0 + gap_css, 30.0, 110.0],
                    ];
                    let mut objects = css_boxes.map(|b| {
                        object(
                            true,
                            [
                                (b[0] - viewport.tx) / scale,
                                (b[1] - viewport.ty) / scale,
                                (b[2] - viewport.tx) / scale,
                                (b[3] - viewport.ty) / scale,
                            ],
                        )
                    });
                    visible_ranges(&objects, viewport, &mut ranges, &mut controls);
                    assert_eq!(ranges, if gap_css < 0.75 { vec![0..4] } else { vec![] });
                    assert_eq!(
                        controls,
                        if gap_css < 4.0 { vec![0..4] } else { vec![] },
                        "scale={scale} dpr={dpr} gap_css={gap_css}"
                    );
                    objects[1].locked = true;
                    objects[2].selected = false;
                    visible_ranges(&objects, viewport, &mut ranges, &mut controls);
                    assert_eq!(
                        controls,
                        if gap_css < 4.0 {
                            vec![0..1, 3..4]
                        } else {
                            vec![]
                        }
                    );
                }
            }
        }
        let mut invalid = view(1.0);
        invalid.css_width = 0.0;
        ranges.push(0..1);
        controls.push(0..1);
        assert_eq!(
            visible_ranges(
                &[object(true, [1.0, 1.0, 5.0, 5.0])],
                invalid,
                &mut ranges,
                &mut controls
            ),
            0
        );
        assert!(ranges.is_empty());
        assert!(controls.is_empty());
    }

    #[test]
    fn draw_ranges_preserve_sparse_instance_indices_and_merge_adjacent_visible_objects() {
        let objects = [
            object(false, [1.0, 1.0, 5.0, 5.0]),
            object(false, [2.0, 2.0, 6.0, 6.0]),
            object(false, [200.0, 200.0, 205.0, 205.0]),
            object(false, [3.0, 3.0, 7.0, 7.0]),
        ];
        let mut ranges = Vec::new();
        let mut controls = Vec::new();
        assert_eq!(
            visible_ranges(&objects, view(1.0), &mut ranges, &mut controls),
            3
        );
        assert_eq!(ranges, vec![0..2, 3..4]);
        let mut panned = view(1.0);
        panned.tx = -200.0;
        panned.ty = -200.0;
        assert_eq!(
            visible_ranges(&objects, panned, &mut ranges, &mut controls),
            1
        );
        assert_eq!(ranges, vec![2..3]);
    }

    #[test]
    fn draw_ranges_keep_shader_strokes_at_all_view_edges_across_zoom_and_dpr() {
        for scale in [0.25, 1.0, 4.0] {
            for dpr in [1.0, 1.25, 2.0, 3.0] {
                let mut viewport = view(scale);
                viewport.tx = -10.0 * scale;
                viewport.ty = -10.0 * scale;
                viewport.dpr = dpr;
                for gap_css in [0.0, 0.5, 0.75, 1.0] {
                    // Construct in CSS space, independently of the culler.
                    // At gap 0.5/DPR 2 the first pixel center (0.25 CSS px)
                    // still lies in the shader's 0.75 CSS px outer stroke.
                    let css_boxes = [
                        [-10.0, 20.0, -gap_css, 30.0],
                        [100.0 + gap_css, 20.0, 110.0, 30.0],
                        [20.0, -10.0, 30.0, -gap_css],
                        [20.0, 100.0 + gap_css, 30.0, 110.0],
                    ];
                    let objects: Vec<_> = css_boxes
                        .map(|b| {
                            object(
                                false,
                                [
                                    (b[0] - viewport.tx) / scale,
                                    (b[1] - viewport.ty) / scale,
                                    (b[2] - viewport.tx) / scale,
                                    (b[3] - viewport.ty) / scale,
                                ],
                            )
                        })
                        .into();
                    let mut ranges = Vec::new();
                    let mut controls = Vec::new();
                    visible_ranges(&objects, viewport, &mut ranges, &mut controls);
                    assert_eq!(
                        ranges,
                        if gap_css < 0.75 { vec![0..4] } else { vec![] },
                        "scale={scale} dpr={dpr} gap_css={gap_css}"
                    );
                    let mut labels = Vec::new();
                    label_candidates(&objects, viewport, &mut labels);
                    assert!(
                        labels.is_empty(),
                        "stroke margin must not expand DOM labels"
                    );
                }
            }
        }
    }

    #[test]
    fn selected_labels_win_the_cap_and_low_zoom_never_admits_unselected_labels() {
        let mut objects = vec![object(false, [1.0, 1.0, 5.0, 5.0]); 150];
        objects[149].selected = true;
        let mut labels = Vec::new();
        label_candidates(&objects, view(1.0), &mut labels);
        assert_eq!(labels.len(), MAX_CANVAS_LABELS);
        assert!(std::ptr::eq(labels[0], &objects[149]));
        label_candidates(&objects, view(0.1), &mut labels);
        assert_eq!(labels.len(), 1);
        assert!(std::ptr::eq(labels[0], &objects[149]));
    }

    #[test]
    fn viewport_culling_excludes_offscreen_objects_without_reordering_visible_ones() {
        let objects = [
            object(false, [1.0, 1.0, 5.0, 5.0]),
            object(true, [2.0, 2.0, 6.0, 6.0]),
            object(false, [200.0, 200.0, 205.0, 205.0]),
        ];
        let mut visible = Vec::new();
        visible_instances(&objects, view(1.0), &mut visible);

        assert_eq!(visible.len(), 2);
        assert!(std::ptr::eq(visible[0], &objects[0]));
        assert!(std::ptr::eq(visible[1], &objects[1]));
    }

    #[test]
    fn labels_keep_selection_at_low_zoom_and_drop_offscreen_objects() {
        let objects = [
            object(false, [1.0, 1.0, 5.0, 5.0]),
            object(true, [2.0, 2.0, 6.0, 6.0]),
            object(true, [2000.0, 2000.0, 2005.0, 2005.0]),
        ];
        let mut labels = Vec::new();
        label_candidates(&objects, view(0.1), &mut labels);

        assert_eq!(labels.len(), 1);
        assert!(labels[0].selected);
    }
}
