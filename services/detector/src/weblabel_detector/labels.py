"""Explicit detector-category to project-label mapping.

Mapping is always explicit and configuration-driven. A category that has no
mapping is REPORTED as unsupported; it is never guessed from COCO indices,
array positions or name similarity (contracts C8).
"""

from __future__ import annotations

import math


class LabelMappingError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


MAX_CATEGORY_LENGTH = 128
MAX_LABEL_ID_LENGTH = 128
MAX_ENTRIES = 4096


class LabelMapping:
    """Immutable category -> label_id map built from explicit configuration."""

    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    @classmethod
    def from_raw(cls, raw, *, valid_label_ids=None):
        if not isinstance(raw, dict):
            raise LabelMappingError("invalid_mapping", "label mapping must be a JSON object of category -> label_id")
        if len(raw) > MAX_ENTRIES:
            raise LabelMappingError("too_many_entries", f"label mapping exceeds the {MAX_ENTRIES} entry limit")
        mapping: dict[str, str] = {}
        for category, label_id in raw.items():
            if not isinstance(category, str) or category == "":
                raise LabelMappingError("invalid_mapping", "mapping keys must be non-empty strings")
            if len(category) > MAX_CATEGORY_LENGTH:
                raise LabelMappingError("invalid_mapping", f"category name exceeds {MAX_CATEGORY_LENGTH} characters")
            if not isinstance(label_id, str) or label_id == "":
                raise LabelMappingError("invalid_mapping", f"mapping value for {category!r} must be a non-empty string")
            if len(label_id) > MAX_LABEL_ID_LENGTH:
                raise LabelMappingError("invalid_mapping", f"label_id exceeds {MAX_LABEL_ID_LENGTH} characters")
            if valid_label_ids is not None and label_id not in valid_label_ids:
                raise LabelMappingError("unknown_label_id", f"label_id {label_id!r} is not in the project ontology")
            mapping[category] = label_id
        return cls(mapping)

    def map_category(self, category):
        """Return the explicitly mapped label_id, or None when the category has
        no explicit mapping. Nothing is ever inferred."""
        if not isinstance(category, str):
            return None
        return self._mapping.get(category)

    def __len__(self):
        return len(self._mapping)


def unsupported_report(category, detector_index, score):
    """Structured report for a detection whose category cannot be mapped to a
    project label. The detector index and category are reported as observed;
    no project label is guessed."""
    if not isinstance(detector_index, int) or detector_index < 0:
        raise LabelMappingError("invalid_mapping", "detector_index must be a non-negative integer")
    if category is not None and not isinstance(category, str):
        raise LabelMappingError("invalid_mapping", "category must be a string or None")
    try:
        score = float(score)
    except (TypeError, ValueError) as error:
        raise LabelMappingError("invalid_mapping", "score must be a number") from error
    if not math.isfinite(score):
        raise LabelMappingError("invalid_mapping", "score must be finite")
    return {"code": "unsupported_category", "category": category, "detector_index": detector_index, "score": score}
