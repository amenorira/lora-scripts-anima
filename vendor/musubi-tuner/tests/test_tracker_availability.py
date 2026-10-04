"""Tests for tracker availability handling (TensorBoard warning, wandb tracker detection)."""

import logging
import sys
import types

import pytest
from accelerate import Accelerator

from musubi_tuner.training import accelerator_setup
from musubi_tuner.training.accelerator_setup import warn_if_tensorboard_unavailable
from musubi_tuner.training.trainer_base import wandb_tracker_and_module


class _FakeTracker:
    def __init__(self, name):
        self.name = name


class _FakeAccelerator:
    def __init__(self, trackers):
        self.trackers = trackers


@pytest.fixture
def fake_wandb(monkeypatch):
    module = types.ModuleType("wandb")
    monkeypatch.setitem(sys.modules, "wandb", module)
    return module


@pytest.fixture
def no_wandb(monkeypatch):
    monkeypatch.setitem(sys.modules, "wandb", None)  # makes `import wandb` raise ImportError


# --- wandb_tracker_and_module ---


def test_wandb_tracker_found(fake_wandb):
    tracker = _FakeTracker("wandb")
    acc = _FakeAccelerator([_FakeTracker("tensorboard"), tracker])
    assert wandb_tracker_and_module(acc) == (tracker, fake_wandb)


def test_no_trackers_returns_none_without_warning(no_wandb, caplog):
    """No tracker registered (e.g. no --logging_dir, or the package was missing): must not be mistaken for wandb."""
    with caplog.at_level(logging.WARNING):
        assert wandb_tracker_and_module(_FakeAccelerator([])) == (None, None)
    assert caplog.records == []


def test_tensorboard_only_returns_none(no_wandb):
    assert wandb_tracker_and_module(_FakeAccelerator([_FakeTracker("tensorboard")])) == (None, None)


def test_real_accelerator_without_log_with(no_wandb, caplog):
    """Accelerator.get_tracker returns a blank tracker when nothing is registered; the lookup must not rely on it."""
    accelerator = Accelerator()
    with caplog.at_level(logging.WARNING):
        assert wandb_tracker_and_module(accelerator) == (None, None)
    assert caplog.records == []


# --- warn_if_tensorboard_unavailable ---


@pytest.mark.parametrize("log_with", ["tensorboard", "all"])
def test_warns_when_tensorboard_missing(monkeypatch, caplog, log_with):
    monkeypatch.setattr(accelerator_setup, "is_tensorboard_available", lambda: False)
    with caplog.at_level(logging.WARNING, logger=accelerator_setup.__name__):
        warn_if_tensorboard_unavailable(log_with)
    assert len(caplog.records) == 1
    assert "tensorboardX" in caplog.records[0].getMessage()


@pytest.mark.parametrize("log_with", [None, "wandb"])
def test_no_warning_when_tensorboard_not_requested(monkeypatch, caplog, log_with):
    monkeypatch.setattr(accelerator_setup, "is_tensorboard_available", lambda: False)
    with caplog.at_level(logging.WARNING, logger=accelerator_setup.__name__):
        warn_if_tensorboard_unavailable(log_with)
    assert caplog.records == []


def test_no_warning_when_tensorboard_available(monkeypatch, caplog):
    monkeypatch.setattr(accelerator_setup, "is_tensorboard_available", lambda: True)
    with caplog.at_level(logging.WARNING, logger=accelerator_setup.__name__):
        warn_if_tensorboard_unavailable("tensorboard")
    assert caplog.records == []
