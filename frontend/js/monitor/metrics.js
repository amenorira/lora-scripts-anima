/* 实时曲线合并、性能采样及单调计时；由 monitor-core.js 装配，沿用同一份监控状态。 */
window.monitorMetricsMixin = {
  _mergeMonitorMetricSnapshot(incoming) {
    // HTTP 提供完整历史，WS 提供更晚的尾部；合并后曲线不会倒退，也不会丢掉回填数据。
    const merged = new Map(incoming.map(series => [series.tag, series]));
    for (const live of this.lossSeries || []) {
      const snapshot = merged.get(live.tag);
      if (!snapshot) { merged.set(live.tag, live); continue; }
      this._appendMonitorMetricPoints(snapshot, live.points, live.diagnostic_points);
    }
    return [...merged.values()];
  },

  _appendMonitorMetricPoints(series, points, rawPoints = points) {
    const lastStep = Number(series.points.at(-1)?.step ?? -Infinity);
    const fresh = points.filter(point => Number(point.step) > lastStep);
    if (!fresh.length) return false;
    const limit = series.tag.startsWith('loss/') ? 160 : 40;
    series.diagnostic_points = (series.diagnostic_points || series.points)
      .concat(rawPoints.filter(point => Number(point.step) > lastStep)).slice(-limit);
    for (const point of fresh) {
      if (point.value < (series.min ?? Infinity)) { series.min = point.value; series.min_step = point.step; }
      series.max = Math.max(series.max ?? -Infinity, point.value);
    }
    series.points = series.points.concat(fresh).slice(-5000);
    series.latest = fresh.at(-1).value;
    return true;
  },

  _recordMonitorPerfSample(progress) {
    const step = Number(progress && progress.step);
    if (!Number.isFinite(step) || step <= 0) return;
    const sample = { step, speedSec: this._monitorSpeedSeconds(progress.speed),
      elapsedSec: this._monitorDurationSeconds(progress.elapsed), remainingSec: this._monitorDurationSeconds(progress.eta) };
    if (sample.speedSec === null && sample.elapsedSec === null) return;
    this._ingestMonitorPerfSamples([sample]);
  },

  _ingestMonitorPerfSamples(incoming) {
    const previous = this.monitorPerfSamples || [];
    const merged = this._mergeMonitorPerfSamples(previous, incoming);
    if (merged === previous) return;
    this.monitorPerfSamples = merged;
    this._monitorPerfVersion++;
  },

  _mergeMonitorPerfSamples(previous, incoming) {
    if (!incoming.length) return previous;
    const keyOf = sample => JSON.stringify([sample.step, sample.elapsedSec, sample.speedSec, sample.remainingSec]);
    const byKey = new Map(previous.map(sample => [keyOf(sample), sample]));
    const previousKeys = new Set(byKey.keys());
    for (const sample of incoming) byKey.set(keyOf(sample), sample);
    const samples = [...byKey.values()].sort((a, b) => a.step - b.step || (a.elapsedSec ?? 0) - (b.elapsedSec ?? 0));
    const visible = samples.slice(-80);
    const added = visible.filter(sample => !previousKeys.has(keyOf(sample))).length;
    if (!added) return previous;
    const end = (previous.at(-1)?.observation || 0) + added;
    // 先补齐时间顺序，再计算导数；正常追加保留旧点编号，回填允许修复中间缺口。
    return visible.map((sample, index) => {
      const last = samples[samples.length - visible.length + index - 1];
      return { ...sample, observation: end - visible.length + index + 1,
        remainingRate: last && Number.isFinite(last.elapsedSec) && Number.isFinite(last.remainingSec)
          && Number.isFinite(sample.elapsedSec) && Number.isFinite(sample.remainingSec) && sample.elapsedSec > last.elapsedSec
          ? (sample.remainingSec - last.remainingSec) / (sample.elapsedSec - last.elapsedSec) : null,
      };
    });
  },

  _parseMonitorPerfLogs(lines = []) {
    const samples = [];
    for (const line of lines || []) {
      const match = /steps:\s*\d{1,3}%\|[^\n]*?\|\s*(\d+)\s*\/\s*\d+\s*\[([^<,\]]+)(?:<([^,\]]+))?/i.exec(line);
      if (!match || Number(match[1]) <= 0) continue;
      const speed = /(\d+(?:\.\d+)?)\s*(s\/it|it\/s)(?!\w)/i.exec(line.slice(match.index));
      const sample = { step: Number(match[1]), elapsedSec: this._monitorDurationSeconds(match[2]),
        remainingSec: this._monitorDurationSeconds(match[3]), speedSec: this._monitorSpeedSeconds(speed?.[0]) };
      if (sample.elapsedSec !== null || sample.speedSec !== null) samples.push(sample);
    }
    return samples;
  },

  handleRealtimeTaskMetrics(data) {
    if (!data || !data.points) return;

    if (data.truncated) {
      // The server intentionally bounded a delayed TensorBoard catch-up.
      // Rebuild the curve from the HTTP snapshot instead of displaying a
      // convincing but incomplete increment.
      this._refreshRealtimeSnapshot(this.realtimeInstanceId, null, { preserveSubscribedCursors: true });
    }

    const points = data.points;
    let changed = false;

    for (const [tag, newPoints] of Object.entries(points)) {
      if (!newPoints || !newPoints.length) continue;

      let series = this.lossSeries.find(s => s.tag === tag);
      if (!series) {
        series = {
          tag: tag,
          name: tag.replace(/\//g, ' ').replace(/_/g, ' '),
          points: [],
          latest: null,
          min: Infinity,
          max: -Infinity,
        };
        this.lossSeries.push(series);
      }

      // HTTP 合并与 WS 增量共用去重和裁尾规则；旧点重放也不能倒退当前读数。
      if (!this._appendMonitorMetricPoints(series, newPoints)) continue;
      changed = true;
      if (this.monitorData && tag === 'lr/unet') this.monitorData.lr = series.latest.toExponential(4);
    }

    if (this.monitorData) {
      const loss = this.lossSeries.find(s => s.tag === 'loss/average') || this.lossSeries.find(s => s.tag === 'loss/current');
      if (loss && Number.isFinite(loss.latest)) this.monitorData.loss = loss.latest.toFixed(6);
    }

    if (changed) this.lossDataVersion++;
    if (!this.selectedRunDir && this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  // ── Dashboard bootstrap + realtime subscriptions ───────
  _monitorSpeedSeconds(value) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(s\/it|it\/s)\s*$/i.exec(String(value || ''));
    if (!match) return null;
    const amount = Number(match[1]);
    return amount > 0 ? (match[2].toLowerCase() === 'it/s' ? 1 / amount : amount) : null;
  },

  _monitorDurationSeconds(value) {
    const raw = String(value == null ? '' : value).trim();
    let seconds = null;
    if (/^\d+(?::\d+){1,2}$/.test(raw)) {
      const parts = raw.split(':').map(Number);
      seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    }
    if (seconds === null) {
      const compact = raw.toLowerCase().replace(/\s+/g, '');
      const units = [...compact.matchAll(/(\d+)([hms])/g)];
      if (units.length && units.map(match => match[0]).join('') === compact) {
        seconds = units.reduce((total, match) => total + Number(match[1]) * ({ h: 3600, m: 60, s: 1 })[match[2]], 0);
      }
    }
    return seconds;
  },

  _observeMonitorClock(progress) {
    if (progress.state !== 'RUNNING') return null;
    const elapsed = this._monitorDurationSeconds(progress.elapsed);
    if (elapsed === null) return null;
    const now = performance.now();
    const sample = this._monitorClockSample;
    const projected = sample && sample.taskId === this.liveTaskId
      ? sample.elapsedSeconds + (now - sample.observedAt) / 1000 : null;
    // 日志时间只有整秒且可能延迟到达；不要重置小数秒或让本地时钟倒退。
    // 单调时钟避免系统时间校准影响计时，仅在日志确实领先时向前校准。
    if (projected === null || elapsed > projected) {
      this._monitorClockSample = { taskId: this.liveTaskId, elapsedSeconds: elapsed, observedAt: now };
      return elapsed;
    }
    return projected;
  },

  _startMonitorClock() {
    if (this._monitorClockTimer) clearInterval(this._monitorClockTimer);
    // 已运行时间独立以 1 Hz 前进；预计剩余只跟随日志，不做本地倒计时。
    this._monitorClockTimer = setInterval(() => {
      if (document.hidden || this.selectedRunDir || this.currentRoute !== 'monitor-dashboard' || this.monitorTab !== 'overview') return;
      const root = document.querySelector('#monitorTabContent .m-tab-panel[data-tab="overview"]');
      if (root && this.monitorData?.state === 'RUNNING') {
        this._patchSummaryTime(root, this.monitorData, (key, fallback) => this.tMonitor(key, fallback), false, true);
      }
    }, 1000);
  },
};
