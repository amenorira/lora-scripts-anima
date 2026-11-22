"""Compact samples and incremental sufficient statistics for the diagnostics API."""

from array import array
from collections import defaultdict
from hashlib import sha256
import math

import numpy as np


class SampleRows:
    """Store sample columns once. The image index addresses only the rows needed for detail."""

    def __init__(self):
        self.structure = array("I")
        self.epoch = array("I")
        self.step = array("q")
        self.timestep = array("d")
        self.loss = array("d")
        self.image_rows = defaultdict(lambda: array("I"))
        self.digest = sha256()
        self.t_min = math.inf
        self.t_max = -math.inf

    def __len__(self):
        return len(self.loss)

    def append(self, image, structure, epoch, step, timestep, loss, source):
        self.image_rows[image].append(len(self))
        self.structure.append(structure)
        self.epoch.append(epoch)
        self.step.append(step if step is not None else -1)
        self.timestep.append(timestep if timestep is not None else math.nan)
        self.loss.append(loss if loss is not None else math.nan)
        self.digest.update(source)
        if loss is not None and timestep is not None:
            self.t_min = min(self.t_min, timestep)
            self.t_max = max(self.t_max, timestep)


class Codes:
    def __init__(self):
        self.keys = []
        self.indices = {}

    def get(self, key):
        index = self.indices.get(key)
        if index is None:
            index = len(self.keys)
            self.indices[key] = index
            self.keys.append(key)
        return index


class _Histogram:
    """One stored cell for each observed (group, timestep bin)."""

    def __init__(self, num_bins):
        self._num_bins = num_bins
        self._cells = {}
        self._keys = array("q")
        self._counts = array("q")
        self._loss = array("d")

    def extend(self, groups, bins, loss):
        if not len(loss):
            return
        keys, inverse, counts = np.unique(groups * self._num_bins + bins, return_inverse=True, return_counts=True)
        losses = np.bincount(inverse, weights=loss)
        for key, count, total in zip(keys.tolist(), counts.tolist(), losses.tolist()):
            index = self._cells.get(key)
            if index is None:
                self._cells[key] = len(self._keys)
                self._keys.append(key)
                self._counts.append(count)
                self._loss.append(total)
            else:
                self._counts[index] += count
                self._loss[index] += total

    def totals(self, groups, means, comparable):
        keys = np.asarray(self._keys)
        bin_ids = keys % self._num_bins
        group_ids = keys // self._num_bins
        counts = np.asarray(self._counts)
        losses = np.asarray(self._loss)
        usable = comparable[bin_ids]
        eligible_groups = group_ids[usable]
        eligible_counts = counts[usable]
        residuals = losses[usable] / means[bin_ids[usable]] - eligible_counts
        return (
            np.bincount(group_ids, weights=counts, minlength=groups),
            np.bincount(group_ids, weights=losses, minlength=groups),
            np.bincount(eligible_groups, weights=eligible_counts, minlength=groups),
            np.bincount(eligible_groups, weights=residuals, minlength=groups),
        )

    def single(self, group, means, comparable):
        count = loss = compared = residual = 0
        base = group * self._num_bins
        for b in range(self._num_bins):
            index = self._cells.get(base + b)
            if index is None:
                continue
            n, total = self._counts[index], self._loss[index]
            count += n
            loss += total
            if comparable[b]:
                compared += n
                residual += float(total / means[b] - n)
        return count, loss, compared, residual


DIMENSIONS = ("resolution", "subset", "batch_size", "directory")
ZONES = ("low", "mid", "high")
# Columns in LossFileState.structures: image, resolution, subset, batch size, directory.
_IMAGE_COLUMN = 0


class LossIndex:
    """Index the append-only rows for a selection, resplitting only when bin edges move."""

    def __init__(self, num_bins, edges, scale):
        self.num_bins = num_bins
        self.edges = edges
        self.scale = scale
        self.offsets = {}
        self.counts = np.zeros(num_bins + 1, dtype=np.int64)
        self.loss = np.zeros(num_bins + 1, dtype=np.float64)
        self._images_by_bin = [set() for _ in range(num_bins)]
        self._histograms = {name: _Histogram(num_bins + 1) for name in (*DIMENSIONS, "image", "epoch", "zone")}
        self.finite_structures = defaultdict(int)
        self.all_structures = defaultdict(int)
        self.non_finite = defaultdict(int)
        self.step_from = self.step_to = None
        self.epoch_from = self.epoch_to = None

    @staticmethod
    def edges_of(runs):
        low = min((rows.t_min for rows in runs.values()), default=math.inf)
        high = max((rows.t_max for rows in runs.values()), default=-math.inf)
        return (low, high) if low != math.inf else (None, None)

    @property
    def width(self):
        low, high = self.edges
        return (high - low) / self.num_bins if low is not None and high > low else 0.0

    def bins(self, values):
        finite = np.isfinite(values)
        ids = np.full(len(values), self.num_bins, dtype=np.int64)
        if self.width:
            scaled = (values[finite] - self.edges[0]) / self.width
            ids[finite] = np.clip(scaled.astype(np.int64), 0, self.num_bins - 1)
        else:
            ids[finite] = 0
        return ids

    def _range(self, prefix, values):
        values = values[values >= 0]
        if not len(values):
            return
        v_min, v_max = int(values.min()), int(values.max())
        prev_min, prev_max = getattr(self, prefix + "_from"), getattr(self, prefix + "_to")
        setattr(self, prefix + "_from", v_min if prev_min is None else min(prev_min, v_min))
        setattr(self, prefix + "_to", v_max if prev_max is None else max(prev_max, v_max))

    @staticmethod
    def _add_counts(target, values):
        ids, counts = np.unique(values, return_counts=True)
        for index, count in zip(ids.tolist(), counts.tolist()):
            target[index] += count

    def extend(self, runs, structures, epoch_numbers):
        pending = [(rid, samples) for rid, samples in runs.items() if self.offsets.get(rid, 0) < len(samples)]
        if not pending:
            return
        structures = np.asarray(structures, dtype=np.int64)
        epoch_numbers = np.asarray(epoch_numbers)
        for rid, samples in pending:
            start = self.offsets.get(rid, 0)
            stop = len(samples)
            for left in range(start, stop, 100_000):
                right = min(left + 100_000, stop)
                raw_loss = np.asarray(samples.loss)[left:right]
                finite = np.isfinite(raw_loss)
                raw_structures = np.asarray(samples.structure)[left:right]
                self._add_counts(self.all_structures, raw_structures)
                self._add_counts(self.non_finite, structures[raw_structures[~finite], _IMAGE_COLUMN])
                loss = raw_loss[finite]
                if not len(loss):
                    continue
                structure_ids = raw_structures[finite]
                self._add_counts(self.finite_structures, structure_ids)
                meta = structures[structure_ids]
                images = meta[:, _IMAGE_COLUMN]
                epoch_ids = np.asarray(samples.epoch)[left:right][finite]
                timestep = np.asarray(samples.timestep)[left:right][finite]
                bins = self.bins(timestep)
                self.counts += np.bincount(bins, minlength=self.num_bins + 1)
                self.loss += np.bincount(bins, weights=loss, minlength=self.num_bins + 1)
                self._range("step", np.asarray(samples.step)[left:right][finite])
                self._range("epoch", epoch_numbers[epoch_ids])
                for b, membership in enumerate(self._images_by_bin):
                    membership.update(np.unique(images[bins == b]).tolist())
                for dim, column in zip(DIMENSIONS, range(1, len(DIMENSIONS) + 1)):
                    self._histograms[dim].extend(meta[:, column], bins, loss)
                self._histograms["image"].extend(images, bins, loss)
                self._histograms["epoch"].extend(epoch_ids, bins, loss)
                if self.scale in ("unit", "thousand"):
                    known = bins < self.num_bins
                    scaled = timestep[known] * 1000 if self.scale == "unit" else timestep[known]
                    zone = np.searchsorted((1000 / 3, 2000 / 3), scaled, side="right")
                    self._histograms["zone"].extend(images[known] * len(ZONES) + zone, bins[known], loss[known])
            self.offsets[rid] = stop

    def baseline(self):
        means = np.divide(self.loss, self.counts, out=np.zeros_like(self.loss), where=self.counts > 0)
        distinct = [len(membership) for membership in self._images_by_bin]
        eligible = np.asarray([count > 1 for count in distinct] + [False]) & (means > 0)
        return means, distinct, eligible

    def totals(self, dimension, size, means, eligible):
        return self._histograms[dimension].totals(size, means, eligible)

    def single(self, dimension, group, means, eligible):
        return self._histograms[dimension].single(group, means, eligible)

    def image_epochs(self, images, epoch_images, epoch_numbers, means, eligible):
        epoch_images, epoch_numbers = np.asarray(epoch_images), np.asarray(epoch_numbers)
        total, _, count, residual = self.totals("epoch", len(epoch_images), means, eligible)
        return epoch_metrics(images, epoch_images, epoch_numbers, total, count, residual)


def epoch_metrics(images, epoch_images, epoch_numbers, total, count, residual):
    observed_count = np.bincount(epoch_images[(epoch_numbers >= 0) & (total > 0)], minlength=images)
    comparable = (count > 0) & (epoch_numbers >= 0)
    image, epoch = epoch_images[comparable], epoch_numbers[comparable]
    n_epochs = np.bincount(image, minlength=images)
    if not len(epoch):
        empty = np.full(images, np.nan)
        return observed_count, n_epochs, empty, empty, empty

    lowest = np.full(images, np.iinfo(np.int64).max)
    highest = np.full(images, -1)
    np.minimum.at(lowest, image, epoch)
    np.maximum.at(highest, image, epoch)
    x = (epoch - lowest[image]).astype(np.float64)
    y = residual[comparable] / count[comparable]
    n = np.maximum(n_epochs, 1)
    sx = np.bincount(image, weights=x, minlength=images)
    sy = np.bincount(image, weights=y, minlength=images)
    sxx = np.bincount(image, weights=x * x, minlength=images) - sx * sx / n
    sxy = np.bincount(image, weights=x * y, minlength=images) - sx * sy / n
    slope = np.divide(sxy, sxx, out=np.full(images, np.nan), where=(sxx > 0) & (n >= 3))
    first, last = np.full(images, np.nan), np.full(images, np.nan)
    first_positions = epoch == lowest[image]
    last_positions = epoch == highest[image]
    first[image[first_positions]] = y[first_positions]
    last[image[last_positions]] = y[last_positions]
    return observed_count, n_epochs, slope, first, last
