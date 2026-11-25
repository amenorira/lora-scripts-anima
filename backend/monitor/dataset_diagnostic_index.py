"""Compact samples and incremental sufficient statistics for the diagnostics API."""

from array import array
from collections import defaultdict
from hashlib import sha256
import math
from typing import Any

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
        self.structures_seen: set[int] = set()
        self.digest = sha256()
        self.t_min = math.inf
        self.t_max = -math.inf

    def __len__(self):
        return len(self.loss)

    def append(self, image, structure, epoch, step, timestep, loss, source):
        self.image_rows[image].append(len(self))
        self.structures_seen.add(structure)
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


def deweight_losses(
    loss: np.ndarray,
    timestep: np.ndarray,
    scale: str,
    scheme: str | None,
) -> np.ndarray:
    """Invert sd-scripts per-sample loss weighting (sigma_sqrt / cosmap) for Anima/MOSS."""
    if scheme not in ("sigma_sqrt", "cosmap") or scale not in ("unit", "thousand"):
        return loss
    valid_t = np.isfinite(timestep)
    if not np.any(valid_t):
        return loss
    sigma = np.where(valid_t, timestep / 1000.0 if scale == "thousand" else timestep, 1.0)
    if scheme == "sigma_sqrt":
        factor = np.where(valid_t & (sigma > 0.0), sigma * sigma, 1.0)
    else:
        sigma = np.maximum(sigma, 0.0)
        bot = 1.0 - 2.0 * sigma + 2.0 * (sigma * sigma)
        factor = np.where(valid_t, (math.pi * bot) * 0.5, 1.0)
    return loss * factor


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

    def peer_epoch_totals(self, epoch_numbers, *, include_self: bool = False):
        """Each cell contains all samples of one image/group in one epoch and noise bin."""
        keys = np.asarray(self._keys)
        epoch_ids, bins = np.divmod(keys, self._num_bins)
        counts, losses = np.asarray(self._counts), np.asarray(self._loss)
        size = len(epoch_numbers)
        total = np.bincount(epoch_ids, weights=counts, minlength=size)
        loss = np.bincount(epoch_ids, weights=losses, minlength=size)

        known = (epoch_numbers[epoch_ids] >= 0) & (bins < self._num_bins - 1)
        epoch_ids, bins = epoch_ids[known], bins[known]
        counts, losses = counts[known], losses[known]
        # Compress epoch numbers before combining with bin IDs (logs may skip epochs).
        ep_vals = epoch_numbers[epoch_ids]
        unique_eps, epochs = np.unique(ep_vals, return_inverse=True)
        groups = epochs * self._num_bins + bins
        group_counts = np.bincount(groups, weights=counts)[groups]
        group_losses = np.bincount(groups, weights=losses)[groups]
        peer_counts = group_counts - counts
        if include_self:
            ref_counts = group_counts
            ref_losses = group_losses
            usable = (peer_counts > 0) & (ref_losses > 0)
        else:
            ref_counts = peer_counts
            ref_losses = group_losses - losses
            usable = (ref_counts > 0) & (ref_losses > 0)
        ref_means = ref_losses[usable] / ref_counts[usable]
        residuals = losses[usable] / ref_means - counts[usable]
        compared = np.bincount(epoch_ids[usable], weights=counts[usable], minlength=size)
        residual = np.bincount(epoch_ids[usable], weights=residuals, minlength=size)

        # Suppress single-peer leverage on an incomplete trailing epoch when earlier
        # epochs had >= 2 peers (protects slope without altering minimal 3-epoch runs).
        slope_usable = usable
        if not include_self and len(unique_eps) >= 4 and np.any(usable):
            last_epoch = int(unique_eps[-1])
            earlier_peers = peer_counts[usable & (ep_vals < last_epoch)]
            if len(earlier_peers) and float(np.median(earlier_peers)) >= 2.0:
                slope_usable = usable & ~((ep_vals == last_epoch) & (peer_counts == 1))
        if slope_usable is usable:
            slope_compared, slope_residual = compared, residual
        else:
            slope_ref_means = ref_losses[slope_usable] / ref_counts[slope_usable]
            slope_residuals = losses[slope_usable] / slope_ref_means - counts[slope_usable]
            slope_compared = np.bincount(epoch_ids[slope_usable], weights=counts[slope_usable], minlength=size)
            slope_residual = np.bincount(epoch_ids[slope_usable], weights=slope_residuals, minlength=size)
        return total, loss, compared, residual, slope_compared, slope_residual

    def matrix(self, size):
        counts = np.zeros((size, self._num_bins), dtype=np.int64)
        losses = np.zeros((size, self._num_bins), dtype=np.float64)
        if self._keys:
            keys = np.asarray(self._keys, dtype=np.int64)
            group_ids, bin_ids = np.divmod(keys, self._num_bins)
            valid = (group_ids >= 0) & (group_ids < size) & (bin_ids >= 0) & (bin_ids < self._num_bins)
            counts[group_ids[valid], bin_ids[valid]] = np.asarray(self._counts, dtype=np.int64)[valid]
            losses[group_ids[valid], bin_ids[valid]] = np.asarray(self._loss, dtype=np.float64)[valid]
        return counts, losses


DIMENSIONS = ("resolution", "subset", "batch_size", "directory")
SLOPE_DIMENSIONS = ("resolution", "subset", "directory")
_SLOPE_DIM_COLUMNS = (("resolution", 1), ("subset", 2), ("directory", 4))
ZONES = ("low", "mid", "high")
PROFILE_BINS = 18
PROFILE_LOSS_CAP = 20_000
# Columns in LossFileState.structures: image, resolution, subset, batch size, directory.
_IMAGE_COLUMN = 0


class LossIndex:
    """Index the append-only rows for a selection, resplitting only when bin edges move."""

    def __init__(self, num_bins, edges, scale, deweight_scheme=None):
        self.num_bins = num_bins
        self.edges = edges
        self.scale = scale
        self.deweight_scheme = (
            deweight_scheme
            if (deweight_scheme in ("sigma_sqrt", "cosmap") and scale in ("unit", "thousand"))
            else None
        )
        self.offsets = {}
        self.counts = np.zeros(num_bins + 1, dtype=np.int64)
        self.loss = np.zeros(num_bins + 1, dtype=np.float64)
        self._images_by_bin = [set() for _ in range(num_bins)]
        self._histograms = {name: _Histogram(num_bins + 1) for name in (*DIMENSIONS, "image", "epoch", "zone")}
        self._dim_zone_hist = {d: _Histogram(num_bins + 1) for d in DIMENSIONS}
        self.profile_counts = np.zeros(PROFILE_BINS, dtype=np.int64)
        self.profile_loss = np.zeros(PROFILE_BINS, dtype=np.float64)
        self.profile_non_finite = np.zeros(PROFILE_BINS, dtype=np.int64)
        self._profile_images = [set() for _ in range(PROFILE_BINS)]
        self._profile_histograms = {name: _Histogram(PROFILE_BINS) for name in (*DIMENSIONS, "image")}
        self._profile_epoch_codes = Codes()
        self._profile_epoch = _Histogram(PROFILE_BINS)
        self._profile_losses = [array("d") for _ in range(PROFILE_BINS)]
        self._profile_loss_seen = [0] * PROFILE_BINS
        self._epoch_totals = None
        self._profile_bins_cache: tuple[int | None, list[dict]] | None = None
        self._profile_epoch_halves_cache: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None
        self._cum_baseline_cache = None
        self._dim_epoch_codes = {d: Codes() for d in SLOPE_DIMENSIONS}
        self._dim_epoch_groups = {d: array("I") for d in SLOPE_DIMENSIONS}
        self._dim_epoch_nums = {d: array("q") for d in SLOPE_DIMENSIONS}
        self._dim_epoch_hist = {d: _Histogram(num_bins + 1) for d in SLOPE_DIMENSIONS}
        self._group_slopes_cache: dict[tuple[str, int], np.ndarray] = {}
        self.finite_structures = defaultdict(int)
        self.all_structures = defaultdict(int)
        self.non_finite = defaultdict(int)
        self.step_from = self.step_to = None
        self.epoch_from = self.epoch_to = None

    @staticmethod
    def edges_of(runs, allowed_structures=None, *, offsets=None, prev_edges=None):
        if allowed_structures is None or (len(allowed_structures) and bool(np.all(allowed_structures))):
            low = min((rows.t_min for rows in runs.values()), default=math.inf)
            high = max((rows.t_max for rows in runs.values()), default=-math.inf)
            return (low, high) if low != math.inf else (None, None)
        if not len(allowed_structures):
            return (None, None)
        if prev_edges is not None and prev_edges[0] is not None and prev_edges[1] is not None:
            low, high = float(prev_edges[0]), float(prev_edges[1])
        else:
            low, high = math.inf, -math.inf
        limit = len(allowed_structures) - 1
        for rid, rows in runs.items():
            stop = len(rows)
            start = offsets.get(rid, 0) if offsets is not None else 0
            if start >= stop:
                continue
            st_all = np.asarray(rows.structure)
            ts_all = np.asarray(rows.timestep)
            ls_all = np.asarray(rows.loss)
            for left in range(start, stop, 100_000):
                right = min(left + 100_000, stop)
                st = st_all[left:right]
                ts = ts_all[left:right]
                ls = ls_all[left:right]
                mask = (st <= limit) & allowed_structures[np.minimum(st, limit)] & np.isfinite(ts) & np.isfinite(ls)
                if np.any(mask):
                    t_valid = ts[mask]
                    low = min(low, float(t_valid.min()))
                    high = max(high, float(t_valid.max()))
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

    def extend(self, runs, structures, epoch_numbers, allowed_structures=None):
        pending = [(rid, samples) for rid, samples in runs.items() if self.offsets.get(rid, 0) < len(samples)]
        if not pending:
            return
        self._epoch_totals = None
        self._profile_bins_cache = None
        self._profile_epoch_halves_cache = None
        self._cum_baseline_cache = None
        self._group_slopes_cache.clear()
        structures = np.asarray(structures, dtype=np.int64)
        epoch_numbers = np.asarray(epoch_numbers)
        for rid, samples in pending:
            start = self.offsets.get(rid, 0)
            stop = len(samples)
            for left in range(start, stop, 100_000):
                right = min(left + 100_000, stop)
                raw_loss = np.asarray(samples.loss)[left:right]
                raw_structures = np.asarray(samples.structure)[left:right]
                raw_timestep = np.asarray(samples.timestep)[left:right]
                raw_epoch = np.asarray(samples.epoch)[left:right]
                raw_step = np.asarray(samples.step)[left:right]
                if allowed_structures is not None:
                    allowed = allowed_structures[raw_structures]
                    if not np.any(allowed):
                        continue
                    if not np.all(allowed):
                        raw_loss = raw_loss[allowed]
                        raw_structures = raw_structures[allowed]
                        raw_timestep = raw_timestep[allowed]
                        raw_epoch = raw_epoch[allowed]
                        raw_step = raw_step[allowed]
                finite = np.isfinite(raw_loss)
                self._add_counts(self.all_structures, raw_structures)
                self._add_counts(self.non_finite, structures[raw_structures[~finite], _IMAGE_COLUMN])
                if self.scale in ("unit", "thousand") and np.any(~finite):
                    nf_ts = raw_timestep[~finite]
                    nf_valid = np.isfinite(nf_ts)
                    if np.any(nf_valid):
                        nf_scaled = nf_ts[nf_valid] * 1000 if self.scale == "unit" else nf_ts[nf_valid]
                        nf_bins = np.clip(np.floor(nf_scaled * (PROFILE_BINS / 1000.0)).astype(np.int64), 0, PROFILE_BINS - 1)
                        self.profile_non_finite += np.bincount(nf_bins, minlength=PROFILE_BINS)
                loss = raw_loss[finite]
                if not len(loss):
                    continue
                structure_ids = raw_structures[finite]
                self._add_counts(self.finite_structures, structure_ids)
                meta = structures[structure_ids]
                images = meta[:, _IMAGE_COLUMN]
                epoch_ids = raw_epoch[finite]
                timestep = raw_timestep[finite]
                if self.deweight_scheme:
                    loss = deweight_losses(loss, timestep, self.scale, self.deweight_scheme)
                bins = self.bins(timestep)
                self.counts += np.bincount(bins, minlength=self.num_bins + 1)
                self.loss += np.bincount(bins, weights=loss, minlength=self.num_bins + 1)
                self._range("step", raw_step[finite])
                self._range("epoch", epoch_numbers[epoch_ids])
                for b, membership in enumerate(self._images_by_bin):
                    membership.update(np.unique(images[bins == b]).tolist())
                for dim, column in zip(DIMENSIONS, range(1, len(DIMENSIONS) + 1)):
                    self._histograms[dim].extend(meta[:, column], bins, loss)
                self._histograms["image"].extend(images, bins, loss)
                self._histograms["epoch"].extend(epoch_ids, bins, loss)
                ep_nums = epoch_numbers[epoch_ids]
                valid_ep = ep_nums >= 0
                if np.any(valid_ep):
                    ep_valid = ep_nums[valid_ep]
                    bins_valid = bins[valid_ep]
                    loss_valid = loss[valid_ep]
                    meta_valid = meta[valid_ep]
                    can_pack = (
                        int(ep_valid.max()) < (1 << 31)
                        and int(meta_valid[:, [1, 2, 4]].max()) < (1 << 31)
                    )
                    for dim, column in _SLOPE_DIM_COLUMNS:
                        codes = self._dim_epoch_codes[dim]
                        grp_arr = self._dim_epoch_groups[dim]
                        num_arr = self._dim_epoch_nums[dim]
                        g_valid = meta_valid[:, column]
                        if can_pack:
                            packed = (g_valid.astype(np.int64) << 32) | ep_valid.astype(np.int64)
                            u_packed, inverse = np.unique(packed, return_inverse=True)
                            u_g = (u_packed >> 32).tolist()
                            u_e = (u_packed & 0xFFFFFFFF).tolist()
                        else:
                            pairs = np.column_stack((g_valid, ep_valid))
                            u_pairs, inverse = np.unique(pairs, axis=0, return_inverse=True)
                            u_g = u_pairs[:, 0].tolist()
                            u_e = u_pairs[:, 1].tolist()
                        u_cids = np.empty(len(u_g), dtype=np.int64)
                        for i, (g, e) in enumerate(zip(u_g, u_e)):
                            cid = codes.get((g, e))
                            if cid == len(grp_arr):
                                grp_arr.append(g)
                                num_arr.append(e)
                            u_cids[i] = cid
                        self._dim_epoch_hist[dim].extend(u_cids[inverse], bins_valid, loss_valid)
                if self.scale in ("unit", "thousand"):
                    known = bins < self.num_bins
                    if np.any(known):
                        scaled = timestep[known] * 1000 if self.scale == "unit" else timestep[known]
                        known_loss = loss[known]
                        known_images = images[known]
                        known_meta = meta[known]
                        zone = np.searchsorted((1000 / 3, 2000 / 3), scaled, side="right")
                        self._histograms["zone"].extend(known_images * len(ZONES) + zone, bins[known], known_loss)
                        for dim, column in zip(DIMENSIONS, range(1, len(DIMENSIONS) + 1)):
                            self._dim_zone_hist[dim].extend(known_meta[:, column] * len(ZONES) + zone, bins[known], known_loss)
                        p_bins = np.clip(np.floor(scaled * (PROFILE_BINS / 1000.0)).astype(np.int64), 0, PROFILE_BINS - 1)
                        self.profile_counts += np.bincount(p_bins, minlength=PROFILE_BINS)
                        self.profile_loss += np.bincount(p_bins, weights=known_loss, minlength=PROFILE_BINS)
                        for b, membership in enumerate(self._profile_images):
                            if np.any(p_bins == b):
                                membership.update(np.unique(known_images[p_bins == b]).tolist())
                        for dim, column in zip(DIMENSIONS, range(1, len(DIMENSIONS) + 1)):
                            self._profile_histograms[dim].extend(known_meta[:, column], p_bins, known_loss)
                        self._profile_histograms["image"].extend(known_images, p_bins, known_loss)
                        known_ep_nums = epoch_numbers[epoch_ids[known]]
                        valid_ep = known_ep_nums >= 0
                        if np.any(valid_ep):
                            ep_vals = known_ep_nums[valid_ep]
                            u_eps, inv = np.unique(ep_vals, return_inverse=True)
                            ep_cids = np.array(
                                [self._profile_epoch_codes.get(int(ep)) for ep in u_eps.tolist()],
                                dtype=np.int64,
                            )
                            self._profile_epoch.extend(ep_cids[inv], p_bins[valid_ep], known_loss[valid_ep])
                        for b in range(PROFILE_BINS):
                            mask = p_bins == b
                            if np.any(mask):
                                self._append_profile_losses(b, known_loss[mask])
            self.offsets[rid] = stop

    def _append_profile_losses(self, bin_idx: int, values: np.ndarray) -> None:
        buf = self._profile_losses[bin_idx]
        seen = self._profile_loss_seen[bin_idx]
        cap = PROFILE_LOSS_CAP
        if len(buf) < cap:
            room = cap - len(buf)
            head = values[:room]
            buf.extend(head.tolist())
            seen += len(head)
            values = values[room:]
        for val in values.tolist():
            seen += 1
            # Deterministic hash keeps per-bin quartile memory bounded while tracking later epochs.
            slot = (((seen * 2654435761) & 0xFFFFFFFF) ^ (seen >> 7)) % seen
            if slot < cap:
                buf[slot] = val
        self._profile_loss_seen[bin_idx] = seen

    def _profile_epoch_halves(self, epoch_numbers=None) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        if epoch_numbers is None:
            zero_c = np.zeros(PROFILE_BINS, dtype=np.int64)
            zero_l = np.zeros(PROFILE_BINS, dtype=np.float64)
            return zero_c, zero_l, zero_c.copy(), zero_l.copy()
        if self._profile_epoch_halves_cache is not None:
            return self._profile_epoch_halves_cache
        zero_c = np.zeros(PROFILE_BINS, dtype=np.int64)
        zero_l = np.zeros(PROFILE_BINS, dtype=np.float64)
        if not self._profile_epoch._keys:
            result = (zero_c, zero_l, zero_c.copy(), zero_l.copy())
            self._profile_epoch_halves_cache = result
            return result
        keys = np.asarray(self._profile_epoch._keys, dtype=np.int64)
        ep_cids, bins = np.divmod(keys, PROFILE_BINS)
        ep_arr = np.asarray(self._profile_epoch_codes.keys, dtype=np.int64)
        ep_nums = ep_arr[ep_cids]
        counts = np.asarray(self._profile_epoch._counts, dtype=np.int64)
        losses = np.asarray(self._profile_epoch._loss, dtype=np.float64)
        unique_epochs = np.unique(ep_nums)
        if len(unique_epochs) < 2:
            result = (zero_c, zero_l, zero_c.copy(), zero_l.copy())
            self._profile_epoch_halves_cache = result
            return result
        half = len(unique_epochs) // 2
        early_max = int(unique_epochs[half - 1])
        late_min = int(unique_epochs[len(unique_epochs) - half])
        early_mask = ep_nums <= early_max
        late_mask = ep_nums >= late_min
        early_c = np.bincount(bins[early_mask], weights=counts[early_mask], minlength=PROFILE_BINS).astype(np.int64)
        early_l = np.bincount(bins[early_mask], weights=losses[early_mask], minlength=PROFILE_BINS).astype(np.float64)
        late_c = np.bincount(bins[late_mask], weights=counts[late_mask], minlength=PROFILE_BINS).astype(np.int64)
        late_l = np.bincount(bins[late_mask], weights=losses[late_mask], minlength=PROFILE_BINS).astype(np.float64)
        result = (early_c, early_l, late_c, late_l)
        self._profile_epoch_halves_cache = result
        return result

    @staticmethod
    def _halves_trend(early_c: int, early_l: float, late_c: int, late_l: float) -> float | None:
        if early_c <= 0 or late_c <= 0 or early_l <= 0:
            return None
        return float((late_l / late_c) / (early_l / early_c) - 1.0)

    def baseline(self):
        means = np.divide(self.loss, self.counts, out=np.zeros_like(self.loss), where=self.counts > 0)
        distinct = [len(membership) for membership in self._images_by_bin]
        eligible = np.asarray([count > 1 for count in distinct] + [False]) & (means > 0)
        return means, distinct, eligible

    def profile_bins(self, epoch_numbers=None) -> list[dict]:
        if self.scale not in ("unit", "thousand") or (not int(self.profile_counts.sum()) and not int(self.profile_non_finite.sum())):
            return []
        cache_key = None if epoch_numbers is None else len(epoch_numbers)
        if self._profile_bins_cache is not None and self._profile_bins_cache[0] == cache_key:
            return self._profile_bins_cache[1]
        early_c, early_l, late_c, late_l = self._profile_epoch_halves(epoch_numbers)
        width = 1000.0 / PROFILE_BINS
        bins = []
        for b in range(PROFILE_BINS):
            count = int(self.profile_counts[b])
            images = len(self._profile_images[b])
            total_loss = float(self.profile_loss[b])
            mean = (total_loss / count) if count else None
            if len(self._profile_losses[b]) >= 4:
                q25, q75 = np.percentile(np.asarray(self._profile_losses[b], dtype=np.float64), [25, 75])
                p25, p75 = float(q25), float(q75)
            else:
                p25 = p75 = None
            ec, el, lc, ll = int(early_c[b]), float(early_l[b]), int(late_c[b]), float(late_l[b])
            bins.append({
                "bin": b,
                "t_from": b * width,
                "t_to": (b + 1) * width,
                "count": count,
                "images": images,
                "comparable": bool(images > 1 and mean is not None and mean > 0),
                "mean_loss": mean,
                "p25": p25,
                "p75": p75,
                "non_finite_count": int(self.profile_non_finite[b]),
                "trend": self._halves_trend(ec, el, lc, ll),
                "early_count": ec,
                "early_loss": el,
                "late_count": lc,
                "late_loss": ll,
            })
        self._profile_bins_cache = (cache_key, bins)
        return bins

    def profile_zone_extras(self, epoch_numbers) -> dict[str, dict[str, Any]]:
        early_c, early_l, late_c, late_l = self._profile_epoch_halves(epoch_numbers)
        bounds = {"low": (0, 6), "mid": (6, 12), "high": (12, 18)}
        out: dict[str, dict[str, Any]] = {}
        for zone, (lo, hi) in bounds.items():
            ec = int(early_c[lo:hi].sum())
            el = float(early_l[lo:hi].sum())
            lc = int(late_c[lo:hi].sum())
            ll = float(late_l[lo:hi].sum())
            out[zone] = {
                "trend": self._halves_trend(ec, el, lc, ll),
                "non_finite_count": int(self.profile_non_finite[lo:hi].sum()),
            }
        return out

    def profile_matrix(self, dimension: str, size: int) -> tuple[np.ndarray, np.ndarray]:
        return self._profile_histograms[dimension].matrix(size)

    def totals(self, dimension, size, means, eligible):
        return self._histograms[dimension].totals(size, means, eligible)

    def single(self, dimension, group, means, eligible):
        return self._histograms[dimension].single(group, means, eligible)

    def dim_zone_totals(self, dimension: str, size: int, means, eligible):
        return self._dim_zone_hist[dimension].totals(size * len(ZONES), means, eligible)

    def epoch_totals(self, epoch_numbers):
        if self._epoch_totals is None or len(self._epoch_totals[0]) != len(epoch_numbers):
            self._epoch_totals = self._histograms["epoch"].peer_epoch_totals(np.asarray(epoch_numbers))
        return self._epoch_totals

    def group_slopes(self, dimension: str, size: int) -> np.ndarray:
        """Compute per-epoch all-sample-referenced residual slope for each group in a dimension."""
        if dimension not in SLOPE_DIMENSIONS or size <= 0 or not self._dim_epoch_hist[dimension]._keys:
            return np.full(max(0, size), np.nan)
        cache_key = (dimension, size)
        cached = self._group_slopes_cache.get(cache_key)
        if cached is not None:
            return cached
        ep_arr = np.asarray(self._dim_epoch_nums[dimension], dtype=np.int64)
        grp_arr = np.asarray(self._dim_epoch_groups[dimension], dtype=np.int64)
        total, _, compared, residual, slope_compared, slope_residual = self._dim_epoch_hist[dimension].peer_epoch_totals(
            ep_arr, include_self=True,
        )
        _, _, slope, _, _ = epoch_metrics(
            size, grp_arr, ep_arr, total, compared, residual, slope_compared, slope_residual,
        )
        self._group_slopes_cache[cache_key] = slope
        return slope

    def _cumulative_baseline(self, epoch_images, epoch_numbers):
        ep_len = len(epoch_numbers)
        cached = self._cum_baseline_cache
        if cached is not None and cached[0] == ep_len:
            return cached[1]
        hist = self._histograms["epoch"]
        if not hist._keys:
            result = None
            self._cum_baseline_cache = (ep_len, result)
            return result
        keys = np.asarray(hist._keys, dtype=np.int64)
        ep_ids, bin_ids = np.divmod(keys, hist._num_bins)
        counts = np.asarray(hist._counts, dtype=np.int64)
        losses = np.asarray(hist._loss, dtype=np.float64)
        ep_arr = np.asarray(epoch_numbers, dtype=np.int64)
        img_arr = np.asarray(epoch_images, dtype=np.int64)
        ep_nums = ep_arr[ep_ids]
        known = ep_nums >= 0
        if not np.any(known):
            result = None
            self._cum_baseline_cache = (ep_len, result)
            return result
        ep_nums = ep_nums[known]
        bin_ids = bin_ids[known]
        counts = counts[known]
        losses = losses[known]
        img_ids = img_arr[ep_ids[known]]

        unique_eps, ep_inv = np.unique(ep_nums, return_inverse=True)
        ep_to_pos = {int(ep): i for i, ep in enumerate(unique_eps.tolist())}
        num_e = len(unique_eps)
        num_b = self.num_bins

        in_bin = (bin_ids < num_b) & (counts > 0)
        has_in_bin = bool(np.any(in_bin))
        if not has_in_bin:
            result = (unique_eps, ep_to_pos, False, None, None)
            self._cum_baseline_cache = (ep_len, result)
            return result

        b_ep_inv = ep_inv[in_bin]
        b_bins = bin_ids[in_bin]
        b_counts = counts[in_bin]
        b_losses = losses[in_bin]
        b_imgs = img_ids[in_bin]

        cell_idx = b_ep_inv * num_b + b_bins
        ds_ep_counts = np.bincount(cell_idx, weights=b_counts, minlength=num_e * num_b).astype(np.int64, copy=False).reshape(num_e, num_b)
        ds_ep_loss = np.bincount(cell_idx, weights=b_losses, minlength=num_e * num_b).astype(np.float64, copy=False).reshape(num_e, num_b)

        pairs = b_imgs * num_b + b_bins
        u_pairs, pair_inv = np.unique(pairs, return_inverse=True)
        first_ep = np.full(len(u_pairs), num_e, dtype=np.int64)
        np.minimum.at(first_ep, pair_inv, b_ep_inv)
        u_bins = u_pairs % num_b
        distinct_delta = np.zeros((num_e, num_b), dtype=np.int64)
        np.add.at(distinct_delta, (first_ep, u_bins), 1)
        cum_ds_distinct = np.cumsum(distinct_delta, axis=0)

        cum_ds_counts = np.cumsum(ds_ep_counts, axis=0)
        cum_ds_loss = np.cumsum(ds_ep_loss, axis=0)
        cum_ds_mean = np.divide(cum_ds_loss, cum_ds_counts, out=np.zeros(cum_ds_loss.shape, dtype=np.float64), where=cum_ds_counts > 0)
        eligible = (cum_ds_distinct >= 2) & (cum_ds_mean > 0)
        result = (unique_eps, ep_to_pos, True, cum_ds_mean, eligible)
        self._cum_baseline_cache = (ep_len, result)
        return result

    def cumulative_image_trajectory_residuals(
        self, image_idx: int, epoch_images, epoch_numbers, image_epoch_ids=None,
    ) -> dict[int, tuple[int, int, float]]:
        """Compute cumulative (count, comparable_count, residual_sum) per epoch using only epochs <= ep."""
        baseline = self._cumulative_baseline(epoch_images, epoch_numbers)
        if baseline is None:
            return {}
        unique_eps, ep_to_pos, has_in_bin, cum_ds_mean, eligible = baseline
        num_e = len(unique_eps)
        num_b = self.num_bins
        hist = self._histograms["epoch"]
        ep_arr = np.asarray(epoch_numbers, dtype=np.int64)

        if image_epoch_ids is None:
            ep_id_iter = np.flatnonzero(np.asarray(epoch_images, dtype=np.int64) == image_idx).tolist()
        else:
            ep_id_iter = image_epoch_ids

        img_ep_total = np.zeros(num_e, dtype=np.int64)
        img_ep_counts = np.zeros((num_e, num_b), dtype=np.int64)
        img_ep_loss = np.zeros((num_e, num_b), dtype=np.float64)

        for ep_id in ep_id_iter:
            pos = ep_to_pos.get(int(ep_arr[ep_id]))
            if pos is None:
                continue
            base = int(ep_id) * hist._num_bins
            for b in range(hist._num_bins):
                cell = hist._cells.get(base + b)
                if cell is None:
                    continue
                c = hist._counts[cell]
                img_ep_total[pos] += c
                if b < num_b and c > 0:
                    img_ep_counts[pos, b] += c
                    img_ep_loss[pos, b] += hist._loss[cell]

        cum_total = np.cumsum(img_ep_total)
        if not has_in_bin or not np.any(img_ep_counts):
            return {int(ep): (int(cum_total[i]), 0, 0.0) for i, ep in enumerate(unique_eps.tolist())}

        cum_img_counts = np.cumsum(img_ep_counts, axis=0)
        cum_img_loss = np.cumsum(img_ep_loss, axis=0)
        quotient = np.divide(cum_img_loss, cum_ds_mean, out=np.zeros(cum_img_loss.shape, dtype=np.float64), where=eligible)
        res_matrix = np.where(eligible, quotient - cum_img_counts, 0.0)
        comp_matrix = np.where(eligible, cum_img_counts, 0)
        comp_totals = comp_matrix.sum(axis=1)
        res_totals = res_matrix.sum(axis=1)
        return {
            int(ep): (int(cum_total[i]), int(comp_totals[i]), float(res_totals[i]))
            for i, ep in enumerate(unique_eps.tolist())
        }


def epoch_metrics(images, epoch_images, epoch_numbers, total, count, residual, slope_count=None, slope_residual=None):
    epoch_images, epoch_numbers = np.asarray(epoch_images), np.asarray(epoch_numbers)
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
    y = residual[comparable] / count[comparable]

    s_count = count if slope_count is None else slope_count
    s_residual = residual if slope_residual is None else slope_residual
    s_comparable = (s_count > 0) & (epoch_numbers >= 0)
    s_image, s_epoch = epoch_images[s_comparable], epoch_numbers[s_comparable]
    s_n_epochs = np.bincount(s_image, minlength=images)
    if len(s_epoch):
        s_lowest = np.full(images, np.iinfo(np.int64).max)
        np.minimum.at(s_lowest, s_image, s_epoch)
        x = (s_epoch - s_lowest[s_image]).astype(np.float64)
        sy_vals = s_residual[s_comparable] / s_count[s_comparable]
        n = np.maximum(s_n_epochs, 1)
        sx = np.bincount(s_image, weights=x, minlength=images)
        sy = np.bincount(s_image, weights=sy_vals, minlength=images)
        sxx = np.bincount(s_image, weights=x * x, minlength=images) - sx * sx / n
        sxy = np.bincount(s_image, weights=x * sy_vals, minlength=images) - sx * sy / n
        slope = np.divide(sxy, sxx, out=np.full(images, np.nan), where=(sxx > 0) & (n >= 3))
    else:
        slope = np.full(images, np.nan)

    first, last = np.full(images, np.nan), np.full(images, np.nan)
    first_positions = epoch == lowest[image]
    last_positions = epoch == highest[image]
    first[image[first_positions]] = y[first_positions]
    last[image[last_positions]] = y[last_positions]
    return observed_count, n_epochs, slope, first, last
