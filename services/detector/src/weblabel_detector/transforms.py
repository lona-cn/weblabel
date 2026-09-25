"""Canonical transform primitives for the detector pipeline (contracts C1/C2/C8).

Coordinates are continuous pixels in ``xyxy`` order (``x_min, y_min, x_max,
y_max``), never inclusive +1. Every primitive has an exact inverse and the
inverse/forward pairs round-trip within 1e-9 pixels on non-square images.

``LetterboxGeometry``/``ResizeGeometry`` describe how model-input pixels map
back to original pixels. Exactly ONE inverse scaling is ever applied to a
model box (see models.lock.json ``preprocessing.inverse_rule``): the decoder
scales normalized boxes to model-input pixels and inverts the preprocessing
once; a second post-process target-size scaling is forbidden.
"""

from __future__ import annotations

import math


class DetectorError(ValueError):
    """Untrusted input or geometry failure, carrying a stable machine code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _box4(box) -> tuple[float, float, float, float]:
    try:
        values = [float(v) for v in box]
    except (TypeError, ValueError) as error:
        raise DetectorError("invalid_box", "bbox must be a sequence of 4 numbers") from error
    if len(values) != 4 or not all(math.isfinite(v) for v in values):
        raise DetectorError("invalid_box", "bbox must contain 4 finite numbers")
    return values[0], values[1], values[2], values[3]


def _finite(value, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise DetectorError("invalid_transform", f"{name} must be a number") from error
    if not math.isfinite(number):
        raise DetectorError("invalid_transform", f"{name} must be finite")
    return number


def _positive(value, name: str) -> float:
    number = _finite(value, name)
    if number <= 0.0:
        raise DetectorError("invalid_transform", f"{name} must be positive")
    return number


def letterbox_params(width, height, target_width, target_height):
    """Uniform scale and per-side padding for letterboxing ``width x height``
    into ``target_width x target_height`` (centered)."""
    width = _positive(width, "width")
    height = _positive(height, "height")
    target_width = _positive(target_width, "target_width")
    target_height = _positive(target_height, "target_height")
    scale = min(target_width / width, target_height / height)
    pad_x = (target_width - width * scale) / 2.0
    pad_y = (target_height - height * scale) / 2.0
    return scale, pad_x, pad_y


def forward_letterbox(box, *, scale, pad_x, pad_y):
    x_min, y_min, x_max, y_max = _box4(box)
    scale = _positive(scale, "scale")
    pad_x = _finite(pad_x, "pad_x")
    pad_y = _finite(pad_y, "pad_y")
    return [x_min * scale + pad_x, y_min * scale + pad_y, x_max * scale + pad_x, y_max * scale + pad_y]


def inverse_letterbox(box, *, scale, pad_x, pad_y):
    x_min, y_min, x_max, y_max = _box4(box)
    scale = _positive(scale, "scale")
    pad_x = _finite(pad_x, "pad_x")
    pad_y = _finite(pad_y, "pad_y")
    return [(x_min - pad_x) / scale, (y_min - pad_y) / scale, (x_max - pad_x) / scale, (y_max - pad_y) / scale]


def resize_params(width, height, target_width, target_height):
    """Per-axis scale factors mapping original pixels to resized pixels."""
    width = _positive(width, "width")
    height = _positive(height, "height")
    target_width = _positive(target_width, "target_width")
    target_height = _positive(target_height, "target_height")
    return target_width / width, target_height / height


def forward_resize(box, *, scale_x, scale_y):
    x_min, y_min, x_max, y_max = _box4(box)
    scale_x = _positive(scale_x, "scale_x")
    scale_y = _positive(scale_y, "scale_y")
    return [x_min * scale_x, y_min * scale_y, x_max * scale_x, y_max * scale_y]


def inverse_resize(box, *, scale_x, scale_y):
    x_min, y_min, x_max, y_max = _box4(box)
    scale_x = _positive(scale_x, "scale_x")
    scale_y = _positive(scale_y, "scale_y")
    return [x_min / scale_x, y_min / scale_y, x_max / scale_x, y_max / scale_y]


def forward_crop(box, *, left, top):
    x_min, y_min, x_max, y_max = _box4(box)
    left = _finite(left, "left")
    top = _finite(top, "top")
    return [x_min - left, y_min - top, x_max - left, y_max - top]


def inverse_crop(box, *, left, top):
    x_min, y_min, x_max, y_max = _box4(box)
    left = _finite(left, "left")
    top = _finite(top, "top")
    return [x_min + left, y_min + top, x_max + left, y_max + top]


def apply_matrix(matrix, box):
    """Apply a row-major 3x3 matrix (length 9, as in MediaRevision
    ``original_to_canonical``) to a bbox and return the axis-aligned bounds of
    the four transformed corners."""
    x_min, y_min, x_max, y_max = _box4(box)
    try:
        values = [float(v) for v in matrix]
    except (TypeError, ValueError) as error:
        raise DetectorError("invalid_matrix", "matrix must be a sequence of 9 numbers") from error
    if len(values) != 9 or not all(math.isfinite(v) for v in values):
        raise DetectorError("invalid_matrix", "matrix must contain 9 finite numbers")
    m = values
    corners = ((x_min, y_min), (x_max, y_min), (x_max, y_max), (x_min, y_max))
    xs: list[float] = []
    ys: list[float] = []
    for x, y in corners:
        w = m[6] * x + m[7] * y + m[8]
        if w == 0.0:
            raise DetectorError("invalid_matrix", "matrix maps a corner to infinity")
        xs.append((m[0] * x + m[1] * y + m[2]) / w)
        ys.append((m[3] * x + m[4] * y + m[5]) / w)
    return [min(xs), min(ys), max(xs), max(ys)]


def clamp_bbox(box, width, height):
    """Clamp a bbox into the legal ``[0, width] x [0, height]`` pixel bounds."""
    x_min, y_min, x_max, y_max = _box4(box)
    width = _positive(width, "width")
    height = _positive(height, "height")
    x_min = min(max(x_min, 0.0), width)
    x_max = min(max(x_max, 0.0), width)
    y_min = min(max(y_min, 0.0), height)
    y_max = min(max(y_max, 0.0), height)
    return [x_min, y_min, x_max, y_max]


class ResizeGeometry:
    """Stretch-resize preprocessing geometry (the pinned RTDetrImageProcessor
    mode: exact ``input_width x input_height``, aspect ratio NOT kept)."""

    def __init__(self, *, width, height, input_width, input_height):
        self.width = _positive(width, "width")
        self.height = _positive(height, "height")
        self.input_width = _positive(input_width, "input_width")
        self.input_height = _positive(input_height, "input_height")
        self.scale_x, self.scale_y = resize_params(self.width, self.height, self.input_width, self.input_height)

    def forward(self, box):
        return forward_resize(box, scale_x=self.scale_x, scale_y=self.scale_y)

    def inverse(self, box):
        return inverse_resize(box, scale_x=self.scale_x, scale_y=self.scale_y)


class LetterboxGeometry:
    """Letterbox preprocessing geometry: uniform scale plus centered padding."""

    def __init__(self, *, width, height, target_width, target_height):
        self.width = _positive(width, "width")
        self.height = _positive(height, "height")
        self.input_width = _positive(target_width, "target_width")
        self.input_height = _positive(target_height, "target_height")
        self.scale, self.pad_x, self.pad_y = letterbox_params(
            self.width, self.height, self.input_width, self.input_height
        )

    def forward(self, box):
        return forward_letterbox(box, scale=self.scale, pad_x=self.pad_x, pad_y=self.pad_y)

    def inverse(self, box):
        return inverse_letterbox(box, scale=self.scale, pad_x=self.pad_x, pad_y=self.pad_y)
