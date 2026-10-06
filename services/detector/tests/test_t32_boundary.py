"""Synthetic filesystem boundary evidence only; never RT-DETR/G4 execution."""

from __future__ import annotations

import builtins
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import weblabel_detector.model as model_module
from test_t18 import _write_test_lock
from weblabel_detector.model import ConfigurationError, Predictor, WeightsError, load_models_lock, verify_weights


def _directory_link(link: Path, target: Path) -> None:
    if os.name == "nt":
        result = subprocess.run(
            [os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe"), "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, text=True, encoding="oem", check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert link.is_junction()
        print("link_kind=windows_junction")
    else:
        link.symlink_to(target, target_is_directory=True)
        print("link_kind=directory_symlink")


def _escape_link(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
        print("link_kind=file_symlink")
    except OSError as error:
        if os.name != "nt" or error.winerror != 1314:
            raise
        # No privilege-based skip: exercise a real Windows reparse-point escape.
        _directory_link(link, target.parent)
        print("file_symlink_unavailable=winerror_1314; exercised_junction_escape")


def _guard_external_reads(monkeypatch, outside: Path):
    attempts = []
    original_open = Path.open
    original_builtin_open = builtins.open

    def guard(path):
        if isinstance(path, (str, bytes, os.PathLike)) and Path(os.fsdecode(path)).resolve().is_relative_to(outside.resolve()):
            attempts.append(str(path))
            raise AssertionError("synthetic outside target must not be opened")

    def guarded_open(path, *args, **kwargs):
        guard(path)
        return original_open(path, *args, **kwargs)

    def guarded_builtin_open(path, *args, **kwargs):
        guard(path)
        return original_builtin_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded_open)
    monkeypatch.setattr(builtins, "open", guarded_builtin_open)
    return attempts


@pytest.fixture
def boundary(tmp_path):
    root = tmp_path / "selected-root"
    outside = tmp_path / "synthetic-public-outside"
    root.mkdir()
    outside.mkdir()
    data = b"synthetic tiny locked content; not model weights"
    target = outside / "config.json"
    target.write_bytes(data)
    lock_path = _write_test_lock(tmp_path, {"config.json": data})
    return root, outside, target, lock_path, data


def test_explicit_public_external_weights_root_remains_allowed(boundary):
    _, outside, _, lock_path, _ = boundary
    assert verify_weights(load_models_lock(lock_path), outside) is None
    with pytest.raises(ConfigurationError) as caught:
        Predictor.load(lock_path, outside, find_spec=lambda name: None)
    assert caught.value.code == "needs_configuration"
    assert "missing runtime" in caught.value.message


def test_same_size_tampering_still_rejected_by_hash(boundary):
    root, _, _, lock_path, data = boundary
    (root / "config.json").write_bytes(b"X" + data[1:])
    with pytest.raises(WeightsError) as caught:
        verify_weights(load_models_lock(lock_path), root)
    assert caught.value.code == "weights_hash_mismatch"


def test_escape_refused_before_any_target_stat_or_read(boundary, monkeypatch):
    root, outside, target, lock_path, _ = boundary
    _escape_link(root / "config.json", target)
    lock = load_models_lock(lock_path)
    attempts = _guard_external_reads(monkeypatch, outside)
    original_stat = Path.stat

    def guarded_stat(path, *args, **kwargs):
        # resolve() itself needs OS reparse metadata on some platforms. Guard
        # application file checks, not the OS operation needed to resolve links.
        if path == root / "config.json" or path == target:
            raise AssertionError("escaped target must not reach application stat")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", guarded_stat)
    with pytest.raises(WeightsError) as caught:
        verify_weights(lock, root)
    assert caught.value.code == "weights_path_escape"
    assert attempts == []


def test_escape_takes_precedence_over_missing_before_any_locked_file_check(boundary, monkeypatch):
    root, outside, target, lock_path, data = boundary
    _escape_link(root / "config.json", target)
    lock_path = _write_test_lock(lock_path.parent, {"absent.json": b"absent", "config.json": data})
    lock = load_models_lock(lock_path)
    attempts = _guard_external_reads(monkeypatch, outside)

    def forbidden_check(path):
        raise AssertionError("no locked-file stat before all paths are confined")

    monkeypatch.setattr(Path, "is_file", forbidden_check)
    with pytest.raises(WeightsError) as caught:
        verify_weights(lock, root)
    assert caught.value.code == "weights_path_escape"
    assert attempts == []


def test_junction_retargeted_root_refused_before_hash(boundary, monkeypatch):
    root, outside, _, lock_path, data = boundary
    (root / "config.json").write_bytes(data)
    # Root.resolve() must anchor the originally selected directory; a later
    # replacement of that actual directory by a junction must not expand it.
    lock = load_models_lock(lock_path)
    original_is_file = Path.is_file
    swapped = False

    def swap_after_preflight(path):
        nonlocal swapped
        result = original_is_file(path)
        if path.name == "config.json" and not swapped:
            swapped = True
            (root / "config.json").unlink()
            root.rmdir()
            _directory_link(root, outside)
        return result

    monkeypatch.setattr(Path, "is_file", swap_after_preflight)
    attempts = _guard_external_reads(monkeypatch, outside)
    with pytest.raises(WeightsError) as caught:
        verify_weights(lock, root)
    assert caught.value.code == "weights_path_escape"
    assert swapped and attempts == []


def test_size_is_verified_on_opened_file_not_separate_path_stat(boundary, monkeypatch):
    root, _, _, lock_path, data = boundary
    (root / "config.json").write_bytes(data)
    lock = load_models_lock(lock_path)
    original_stat = Path.stat

    def stale_path_stat(path, *args, **kwargs):
        info = original_stat(path, *args, **kwargs)
        return SimpleNamespace(st_mode=info.st_mode, st_size=0)

    monkeypatch.setattr(Path, "stat", stale_path_stat)
    assert verify_weights(lock, root) is None


@pytest.mark.parametrize("swap_at", ["runtime_check", "processor_load"])
def test_escape_between_verification_and_each_loader_is_refused(boundary, monkeypatch, swap_at):
    root, outside, target, lock_path, data = boundary
    locked = root / "config.json"
    locked.write_bytes(data)
    attempts = _guard_external_reads(monkeypatch, outside)
    loader_calls = []

    def swap():
        locked.unlink()
        _escape_link(locked, target)

    def runtime_check(_find_spec=None):
        if swap_at == "runtime_check":
            swap()

    def processor_load(path, **kwargs):
        loader_calls.append("processor")
        assert Path(path) == root.resolve()
        assert kwargs == {"local_files_only": True}
        swap()
        return object()

    def model_load(*args, **kwargs):
        loader_calls.append("model")
        raise AssertionError("model loader must not run after escape")

    monkeypatch.setattr(model_module, "check_runtime", runtime_check)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(
        AutoImageProcessor=SimpleNamespace(from_pretrained=processor_load),
        AutoModelForObjectDetection=SimpleNamespace(from_pretrained=model_load),
    ))
    with pytest.raises(WeightsError) as caught:
        Predictor.load(lock_path, root)
    assert caught.value.code == "weights_path_escape"
    assert loader_calls == ([] if swap_at == "runtime_check" else ["processor"])
    assert attempts == []


def test_selected_directory_alias_resolves_once_for_loading(boundary, monkeypatch):
    root, outside, _, lock_path, data = boundary
    (root / "config.json").write_bytes(data)
    alias = root.parent / "operator-selected-alias"
    _directory_link(alias, root)
    attempts = _guard_external_reads(monkeypatch, outside)

    def retarget_alias(_find_spec=None):
        if os.name == "nt":
            alias.rmdir()
        else:
            alias.unlink()
        _directory_link(alias, outside)

    def assert_anchored(path, **kwargs):
        assert Path(path) == root.resolve()
        assert kwargs == {"local_files_only": True}
        return SimpleNamespace(eval=lambda: None)

    monkeypatch.setattr(model_module, "check_runtime", retarget_alias)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(
        AutoImageProcessor=SimpleNamespace(from_pretrained=assert_anchored),
        AutoModelForObjectDetection=SimpleNamespace(from_pretrained=assert_anchored),
    ))
    predictor = Predictor.load(lock_path, alias)
    assert predictor._lock["model_id"] == "test/model@0000"
    assert attempts == []
