#!/usr/bin/env python3
"""Read WebLabel's COCO detection export bytes without using product code."""

import argparse
import json
import math
from pathlib import Path
import sys
from typing import Any


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def parse_coco(data: bytes) -> dict[str, Any]:
    document = json.loads(data)
    require(isinstance(document, dict), "COCO root must be an object")
    images = document.get("images")
    categories = document.get("categories")
    annotations = document.get("annotations")
    require(isinstance(images, list) and len(images) == 1, "expected exactly one COCO image")
    require(isinstance(categories, list), "categories must be an array")
    require(isinstance(annotations, list), "annotations must be an array")
    image = images[0]
    require(isinstance(image, dict), "image entry must be an object")
    image_id = image.get("id")
    width = image.get("width")
    height = image.get("height")
    require(type(image_id) is int and type(width) is int and type(height) is int, "image id and dimensions must be integers")
    require(width > 0 and height > 0, "image dimensions must be positive")

    labels: dict[int, str] = {}
    for category in categories:
        require(isinstance(category, dict), "category entry must be an object")
        category_id = category.get("id")
        label_id = category.get("label_id")
        require(type(category_id) is int and isinstance(label_id, str) and label_id, "category must map an integer id to label_id")
        require(category_id not in labels, "category ids must be unique")
        labels[category_id] = label_id

    boxes = []
    for annotation in annotations:
        require(isinstance(annotation, dict), "annotation entry must be an object")
        require(annotation.get("image_id") == image_id, "annotation references a different image")
        category_id = annotation.get("category_id")
        require(type(category_id) is int and category_id in labels, "annotation category is unmapped")
        bbox = annotation.get("bbox")
        require(isinstance(bbox, list) and len(bbox) == 4, "bbox must contain x, y, width, height")
        require(all(type(value) in (int, float) and math.isfinite(value) for value in bbox), "bbox values must be finite numbers")
        x, y, box_width, box_height = (float(value) for value in bbox)
        require(box_width > 0 and box_height > 0, "bbox must have positive area")
        box = {"label_id": labels[category_id], "x_min": x, "y_min": y, "x_max": x + box_width, "y_max": y + box_height}
        require(0 <= box["x_min"] < box["x_max"] <= width, "bbox x coordinates exceed canonical dimensions")
        require(0 <= box["y_min"] < box["y_max"] <= height, "bbox y coordinates exceed canonical dimensions")
        boxes.append(box)
    return {"file_name": image.get("file_name"), "width": width, "height": height, "objects": boxes}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_file", type=Path, help="downloaded COCO JSON export bytes")
    parser.add_argument("--label", required=True, help="expected WebLabel label_id")
    parser.add_argument("--xyxy", nargs=4, required=True, type=float, metavar=("X_MIN", "Y_MIN", "X_MAX", "Y_MAX"), help="expected canonical continuous-pixel coordinates")
    args = parser.parse_args()
    try:
        result = parse_coco(args.export_file.read_bytes())
        expected = dict(zip(("x_min", "y_min", "x_max", "y_max"), args.xyxy, strict=True))
        require(len(result["objects"]) == 1, "expected exactly one exported annotation")
        actual = result["objects"][0]
        require(actual["label_id"] == args.label, f"expected label {args.label!r}, got {actual['label_id']!r}")
        require(actual == {"label_id": args.label, **expected}, f"expected {expected}, got {actual}")
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        print(f"dataset loader: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
