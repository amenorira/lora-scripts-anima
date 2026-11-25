/* 训练集诊断交互式散点图、早期蜂群排布、相机/编排动画与历史轨迹；由 dataset-diagnostics-render.js 聚合。 */
(() => {
  const MAX_SCATTER_EFFECTS = 72;

  function _dotEffectPriority(status) {
    if (status === 'non_finite') return 2;
    if (status === 'attention') return 1;
    return 0;
  }

  window.datasetDiagnosticsScatterMixin = {
    _ddSyncActiveDotState(wrap) {
      this._datasetDiagActiveDotId = wrap?._ddActiveDot?.image_id || '';
      this._datasetDiagPinnedDotId = wrap?._ddPinnedDot?.image_id || '';
    },

    _ddComputePannedScatterZoom(startZoom, autoBounds, dxPx, dyPx, plotW, plotH, isEarly = false) {
      if (!startZoom || !Number.isFinite(startZoom.xMin) || !Number.isFinite(startZoom.xMax) || !(plotW > 0)) {
        return null;
      }
      const shiftAxis = (sMin, sMax, bMin, bMax, delta) => {
        const span = sMax - sMin;
        if (!(span > 0)) return null;
        let min = sMin + delta;
        if (Number.isFinite(bMin) && Number.isFinite(bMax)) {
          const lo = Math.min(bMin, sMin);
          const hi = Math.max(bMax, sMax);
          min = (hi - lo <= span + 1e-12) ? sMin : Math.max(lo, Math.min(hi - span, min));
        }
        return [min, min + span];
      };
      const nextX = shiftAxis(
        startZoom.xMin, startZoom.xMax,
        autoBounds?.xMin, autoBounds?.xMax,
        -(dxPx / plotW) * (startZoom.xMax - startZoom.xMin)
      );
      if (!nextX) return null;
      const next = { xMin: nextX[0], xMax: nextX[1] };
      if (!isEarly && Number.isFinite(startZoom.yMin) && Number.isFinite(startZoom.yMax) && plotH > 0) {
        const nextY = shiftAxis(
          startZoom.yMin, startZoom.yMax,
          autoBounds?.yMin, autoBounds?.yMax,
          (dyPx / plotH) * (startZoom.yMax - startZoom.yMin)
        );
        if (nextY) {
          next.yMin = nextY[0];
          next.yMax = nextY[1];
        }
      }
      return next;
    },

    _ddComputeWheeledScatterZoom(st, currentZoom, autoBounds, camera, px, py, deltaY, deltaMode = 0, isEarly = false) {
      if (!st || st.kind !== 'scatter' || typeof st.fromX !== 'function'
        || !autoBounds || !Number.isFinite(autoBounds.xMin) || !Number.isFinite(autoBounds.xMax)
        || !deltaY) {
        return undefined;
      }
      const rawDelta = deltaMode === 1 ? deltaY * 32 : (deltaMode === 2 ? deltaY * 300 : deltaY);
      const clamped = Math.max(-240, Math.min(240, rawDelta));
      const scaleFactor = Math.exp(clamped * 0.0024);
      if (!currentZoom && scaleFactor >= 1) return undefined;

      const cx = Math.max(st.padL, Math.min(st.padL + st.plotW, px));
      const cy = Math.max(st.padT, Math.min(st.padT + st.plotH, py));
      const fx = st.plotW > 0 ? (cx - st.padL) / st.plotW : 0.5;
      const fy = st.plotH > 0 ? (st.padT + st.plotH - cy) / st.plotH : 0.5;

      const zoomAxis = (curMin, curMax, autoMin, autoMax, anchor, frac, minSpan, compressed, pxCoord, pxStart, pxSpan, fromFn) => {
        const autoSpan = autoMax - autoMin;
        if (!(autoSpan > 0)) return { min: autoMin, max: autoMax, atFull: true };
        let baseSpan;
        if (!currentZoom && compressed && typeof fromFn === 'function') {
          const d = Math.max(4, Math.min(20, pxSpan * 0.04));
          const pLo = Math.max(pxStart, pxCoord - d);
          const pHi = Math.min(pxStart + pxSpan, pxCoord + d);
          const localSpan = Math.abs(fromFn(pHi) - fromFn(pLo)) * (pxSpan / Math.max(1, pHi - pLo));
          baseSpan = Math.min(autoSpan, Math.max(minSpan, localSpan));
        } else {
          baseSpan = curMax - curMin;
        }
        const effMinSpan = Math.min(minSpan, autoSpan);
        const nextSpan = Math.max(effMinSpan, Math.min(autoSpan, baseSpan * scaleFactor));
        const rawMin = anchor - frac * nextSpan;
        const min = Math.max(autoMin, Math.min(autoMax - nextSpan, rawMin));
        return { min, max: min + nextSpan, atFull: scaleFactor > 1 && nextSpan >= autoSpan * 0.995 };
      };

      const curXMin = currentZoom ? currentZoom.xMin : autoBounds.xMin;
      const curXMax = currentZoom ? currentZoom.xMax : autoBounds.xMax;
      const xRes = zoomAxis(
        curXMin, curXMax, autoBounds.xMin, autoBounds.xMax,
        st.fromX(cx), fx, 0.001, !!(!currentZoom && camera?.symW_X > 0),
        cx, st.padL, st.plotW, st.fromX
      );
      if (isEarly || typeof st.fromY !== 'function' || !Number.isFinite(autoBounds.yMin) || !Number.isFinite(autoBounds.yMax)) {
        return xRes.atFull ? null : { xMin: xRes.min, xMax: xRes.max };
      }

      const curYMin = (currentZoom && Number.isFinite(currentZoom.yMin)) ? currentZoom.yMin : autoBounds.yMin;
      const curYMax = (currentZoom && Number.isFinite(currentZoom.yMax)) ? currentZoom.yMax : autoBounds.yMax;
      const yRes = zoomAxis(
        curYMin, curYMax, autoBounds.yMin, autoBounds.yMax,
        st.fromY(cy), fy, 0.0005, !!(!currentZoom && camera?.symW_Y > 0),
        cy, st.padT, st.plotH, st.fromY
      );
      if (xRes.atFull && yRes.atFull) return null;
      return { xMin: xRes.min, xMax: xRes.max, yMin: yRes.min, yMax: yRes.max };
    },

    _ddShouldKeepOverviewSelection(target) {
      const el = target?.nodeType === 1 ? target : target?.parentElement;
      if (!el) return false;
      if ('isConnected' in el && !el.isConnected) return true;
      return Boolean(el.closest?.(
        '.m-dd-status-row, .m-dd-status-seg, .m-dd-head-meta, .m-dd-flat-group-row.is-clickable, .m-dd-notable-btn, '
        + '.m-dd-group-dim-toggle, .m-dd-group-sort-btn, .m-dd-group-fold-btn, '
        + '.m-dd-scatter-filter-pill, .m-dd-zoom-reset-btn, .m-dd-zone-toggle, .m-dd-row-jump, '
        + '.m-dd-jump-btn, .m-dd-topbar, .m-dd-preview-pop, .preview-select-menu, '
        + '.anima-select-menu, [role="listbox"], [data-mode="quadrant"] [data-dd-hero-stage], dialog'
      ));
    },

    _bindDatasetDiagCharts(panel) {
      if (!panel || panel.hidden || panel._ddHeroRO) return;
      const wraps = Array.from(panel?.querySelectorAll?.('[data-dd-hero-wrap]') || []);
      if (!wraps.length) return;
      const cleanups = [];

      const unpinScopePop = () => {
        const host = panel.querySelector?.('[data-dd-head-scope].is-pinned');
        if (!host) return false;
        host.classList?.remove?.('is-pinned');
        host.querySelector?.('[data-dd-scope-pill]')?.setAttribute?.('aria-expanded', 'false');
        return true;
      };

      if (typeof panel.addEventListener === 'function') {
        const onPanelClick = event => {
          const pill = event.target?.closest?.('[data-dd-scope-pill]');
          if (!pill) return;
          const host = pill.closest?.('[data-dd-head-scope]');
          if (!host) return;
          const pinned = !(host.classList?.contains?.('is-pinned'));
          host.classList?.toggle?.('is-pinned', pinned);
          pill.setAttribute?.('aria-expanded', String(pinned));
        };
        panel.addEventListener('click', onPanelClick);
        cleanups.push(() => panel.removeEventListener?.('click', onPanelClick));
      }

      const sideScroll = panel.querySelector?.('[data-dd-side-scroll]');
      if (sideScroll) {
        const onSideScroll = () => {
          this._datasetDiagSideScrollingUntil = Date.now() + 180;
          if (this._datasetDiagHoverPreview) this.clearDatasetDiagPreview?.();
        };
        sideScroll.addEventListener('scroll', onSideScroll, { passive: true });
        cleanups.push(() => sideScroll.removeEventListener('scroll', onSideScroll));
      }

      wraps.forEach(wrap => {
        const stage = wrap.querySelector('[data-dd-hero-stage]');
        const svg = wrap.querySelector('[data-dd-hero-svg]');
        if (!stage || !svg) return;

        const clearHover = () => {
          const hadZone = !!wrap._ddHoverZone;
          wrap._ddHoverZone = null;
          wrap._ddHoverState = null;
          if (wrap._ddHoverFrame) cancelAnimationFrame(wrap._ddHoverFrame);
          wrap._ddHoverFrame = 0;
          stage.classList.remove('has-zone-hover');
          this._clearDatasetDiagHeroHover(wrap);
          if (hadZone) this._syncDatasetDiagStatusHighlight?.(panel);
        };

        const locate = (event, clampToPlot = false) => {
          const st = wrap._ddChartState;
          if (!st) return;
          const rect = stage.getBoundingClientRect();
          if (!rect.width) return;
          let x = event.clientX - rect.left - Math.max(0, (rect.width - st.width) / 2);
          let y = event.clientY - rect.top;
          if (clampToPlot) {
            x = Math.max(st.padL, Math.min(st.padL + st.plotW, x));
            y = Math.max(st.padT, Math.min(st.padT + st.plotH, y));
            return { x, y };
          }
          if (x < st.padL - 10 || x > st.padL + st.plotW + 10 || y < st.padT - 10 || y > st.padT + st.plotH + 10) return;
          return { x, y };
        };

        if (!wrap._ddBound) {
          wrap._ddBound = true;
          const applyPanEvent = (pan, event) => {
            if (!pan || !event) return;
            const dxPx = (event.clientX ?? pan.clientX0) - pan.clientX0;
            const dyPx = (event.clientY ?? pan.clientY0) - pan.clientY0;
            const next = this._ddComputePannedScatterZoom?.(
              pan.startZoom, wrap._ddAutoBounds, dxPx, dyPx, pan.plotW, pan.plotH, pan.isEarly
            );
            if (next) this.setDatasetDiagScatterZoom?.(next, { animate: false });
          };

          const finishPan = (event, commit) => {
            const pan = wrap._ddPan;
            if (!pan) return;
            if (pan.rafId && typeof globalThis.cancelAnimationFrame === 'function') {
              globalThis.cancelAnimationFrame(pan.rafId);
            }
            pan.rafId = 0;
            if (pan.active && commit && (event || pan.lastEvent)) {
              applyPanEvent(pan, event || pan.lastEvent);
            }
            pan.lastEvent = null;
            wrap._ddPan = null;
            wrap._ddAnimGeom = null;
            stage.classList?.remove?.('is-panning');
            try {
              if (event?.pointerId != null && stage.hasPointerCapture?.(event.pointerId)) {
                stage.releasePointerCapture(event.pointerId);
              }
            } catch (_) {}
            if (!pan.active) return;
            if (wrap._ddPinnedDot) {
              this._ddSettlePinnedPopAfterViewportChange?.(wrap);
            }
            const until = Date.now() + 80;
            wrap._ddSuppressClickUntil = until;
            this._datasetDiagSuppressDeselectUntil = until;
          };

          stage.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.isPrimary === false) return;
            if (event.target?.closest?.('[data-dd-zoom-reset]')) return;
            const st = wrap._ddChartState;
            const pos = st?.kind === 'scatter' ? locate(event, false) : null;
            if (pos && wrap.dataset.mode === 'quadrant') {
              const hit = this._ddHitTestScatterDot(st, pos.x, pos.y, wrap._ddLiveDotCoords);
              wrap._ddPressDotId = hit?.image_id || '';
              wrap._ddPressXY = { x: event.clientX, y: event.clientY };
            } else {
              wrap._ddPressDotId = '';
              wrap._ddPressXY = null;
            }
            if (!this.datasetDiagScatterZoom) return;
            if (!st || st.kind !== 'scatter' || !pos) return;
            wrap._ddPan = {
              pointerId: event.pointerId,
              clientX0: event.clientX,
              clientY0: event.clientY,
              startZoom: { ...this.datasetDiagScatterZoom },
              plotW: st.plotW,
              plotH: st.plotH,
              isEarly: svg.getAttribute?.('data-dd-svg-kind') === 'early',
              active: false,
              rafId: 0,
              lastEvent: null,
            };
          });

          stage.addEventListener('pointermove', event => {
            const pan = wrap._ddPan;
            if (pan && event.pointerId === pan.pointerId) {
              if (typeof event.buttons === 'number' && (event.buttons & 1) === 0) {
                finishPan(event, true);
                return;
              }
              const cx = event.clientX ?? pan.clientX0;
              const cy = event.clientY ?? pan.clientY0;
              if (!pan.active && Math.hypot(cx - pan.clientX0, cy - pan.clientY0) >= 4) {
                pan.active = true;
                if (!wrap._ddPinnedDot) clearHover();
                this._ddStopScatterDotChoreo?.(wrap, svg);
                const wasAnim = Boolean(wrap._ddZoomAnimRaf || typeof wrap._ddCurrentCamEval === 'function');
                const stoppedCam = this._ddStopScatterCameraAnim?.(wrap, svg);
                if (wasAnim && stoppedCam && this.datasetDiagScatterZoom
                  && Number.isFinite(stoppedCam.xMin) && Number.isFinite(stoppedCam.xMax)) {
                  if (pan.isEarly) {
                    const liveZoom = { xMin: stoppedCam.xMin, xMax: stoppedCam.xMax };
                    pan.startZoom = liveZoom;
                    this.datasetDiagScatterZoom = { ...liveZoom };
                  } else if (Number.isFinite(stoppedCam.yMin) && Number.isFinite(stoppedCam.yMax)) {
                    const liveZoom = {
                      xMin: stoppedCam.xMin,
                      xMax: stoppedCam.xMax,
                      yMin: stoppedCam.yMin,
                      yMax: stoppedCam.yMax,
                    };
                    pan.startZoom = liveZoom;
                    this.datasetDiagScatterZoom = { ...liveZoom };
                  }
                }
                const pop = wrap.querySelector?.('[data-dd-preview-pop]');
                wrap._ddAnimGeom = this._ddCaptureAnimGeom(svg, pop);
                stage.classList?.add?.('is-panning');
                try { stage.setPointerCapture?.(event.pointerId); } catch (_) {}
              }
              if (pan.active) {
                pan.lastEvent = event;
                if (typeof globalThis.requestAnimationFrame === 'function') {
                  if (!pan.rafId) {
                    pan.rafId = globalThis.requestAnimationFrame(() => {
                      pan.rafId = 0;
                      if (wrap._ddPan === pan && pan.lastEvent) {
                        const ev = pan.lastEvent;
                        pan.lastEvent = null;
                        applyPanEvent(pan, ev);
                      }
                    });
                  }
                } else {
                  pan.lastEvent = null;
                  applyPanEvent(pan, event);
                }
              }
              return;
            }
            wrap._ddHoverState = event;
            if (wrap._ddHoverFrame) return;
            wrap._ddHoverFrame = requestAnimationFrame(() => {
              wrap._ddHoverFrame = 0;
              if (wrap._ddPan?.active) return;
              const position = wrap._ddHoverState && locate(wrap._ddHoverState);
              if (position) this._updateDatasetDiagHeroHover(wrap, position.x, position.y);
              else clearHover();
            });
          });

          const onLeave = event => {
            if (wrap._ddPan?.active) return;
            wrap._ddPan = null;
            if (wrap._ddPinnedDot) return;
            const related = event.relatedTarget;
            if (related && wrap.querySelector('[data-dd-preview-pop]')?.contains(related)) return;
            clearHover();
          };
          stage.addEventListener('pointerup', event => {
            if (wrap._ddPan && event?.pointerId === wrap._ddPan.pointerId) {
              finishPan(event, true);
            }
          });
          stage.addEventListener('pointerleave', onLeave);
          stage.addEventListener('pointercancel', event => {
            wrap._ddPressDotId = '';
            wrap._ddPressXY = null;
            finishPan(event, false);
            if (!wrap._ddPinnedDot) clearHover();
          });

          stage.addEventListener('wheel', event => {
            if (wrap.dataset.mode !== 'quadrant') return;
            const st = wrap._ddChartState;
            if (!st || st.kind !== 'scatter') return;
            if (!event.deltaY || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY)) return;
            const pos = locate(event, false);
            if (!pos) return;
            if (!this.datasetDiagScatterZoom && event.deltaY > 0) return;
            const isEarly = svg.getAttribute?.('data-dd-svg-kind') === 'early';
            const camForWheel = wrap._ddTargetCamera || wrap._ddCamera;
            const next = this._ddComputeWheeledScatterZoom?.(
              st, this.datasetDiagScatterZoom, wrap._ddAutoBounds, camForWheel,
              pos.x, pos.y, event.deltaY, event.deltaMode || 0, isEarly
            );
            if (next === undefined) return;
            event.preventDefault?.();
            if (wrap._ddPan) finishPan(event, false);
            this._ddStopScatterDotChoreo?.(wrap, svg);
            if (!wrap._ddPinnedDot) clearHover();
            this.setDatasetDiagScatterZoom?.(next, { animate: true, durationMs: 150, cameraMode: 'wheel' });
          }, { passive: false });

          stage.addEventListener('click', event => {
            if (wrap._ddSuppressClickUntil && Date.now() < wrap._ddSuppressClickUntil) return;
            if (event.target?.closest?.('[data-dd-zoom-reset]')) return;
            if (wrap.dataset.mode !== 'quadrant') return;
            const st = wrap._ddChartState;
            const position = st?.kind === 'scatter' ? locate(event) : null;
            const pressId = wrap._ddPressDotId || '';
            const pressXY = wrap._ddPressXY;
            wrap._ddPressDotId = '';
            wrap._ddPressXY = null;
            if (position) {
              let dot = this._ddHitTestScatterDot(st, position.x, position.y, wrap._ddLiveDotCoords);
              if (!dot && pressId && (!pressXY || Math.hypot((event.clientX ?? pressXY.x) - pressXY.x, (event.clientY ?? pressXY.y) - pressXY.y) < 12)) {
                dot = st.coords?.find(pt => pt.image_id === pressId) || null;
              }
              if (dot?.image_id) {
                if (wrap._ddPinnedDot?.image_id === dot.image_id) {
                  this._unpinDatasetDiagScatterCard?.(wrap);
                } else {
                  this._pinDatasetDiagScatterCard?.(wrap, dot);
                }
                return;
              }
              const zone = this._ddHitTestScatterZone(st, position.x, position.y);
              if (zone?.preset) {
                this._unpinDatasetDiagScatterCard?.(wrap);
                clearHover();
                this.toggleDatasetDiagZonePreset(zone.preset);
                return;
              }
            }
            if (wrap._ddPinnedDot) {
              this._unpinDatasetDiagScatterCard?.(wrap);
              return;
            }
            if (this._datasetDiagHasActiveFilter?.()) {
              clearHover();
              this.resetDatasetDiagFilters();
            }
          });

          stage.addEventListener('dblclick', event => {
            if (wrap._ddSuppressClickUntil && Date.now() < wrap._ddSuppressClickUntil) return;
            if (!this.datasetDiagScatterZoom) return;
            if (event.target?.closest?.('[data-dd-zoom-reset]')) return;
            const st = wrap._ddChartState;
            if (!st || st.kind !== 'scatter' || !locate(event)) return;
            if (!wrap._ddPinnedDot) clearHover();
            this.resetDatasetDiagScatterZoom?.();
          });

          const pop = wrap.querySelector('[data-dd-preview-pop]');
          if (pop) {
            const img = pop.querySelector('img');
            img.addEventListener('load', () => {
              if (!wrap._ddPinnedDot) return;
              const ok = Boolean(img.getAttribute('src') && img.naturalWidth);
              img.parentElement.hidden = !ok;
              img.classList?.toggle?.('is-loaded', ok);
              pop.classList?.toggle?.('is-no-media', !ok);
              pop.hidden = false;
              if (wrap._ddPopAnchor) this._ddPositionDatasetDiagPopover(pop, wrap._ddPopAnchor, { wasHidden: false, keepPlacement: true });
            });
            img.addEventListener('error', () => {
              img.classList?.remove?.('is-loaded');
              img.parentElement.hidden = true;
              if (wrap._ddPinnedDot) {
                pop.classList?.add?.('is-no-media');
                pop.hidden = false;
                if (wrap._ddPopAnchor) this._ddPositionDatasetDiagPopover(pop, wrap._ddPopAnchor, { wasHidden: false, keepPlacement: true });
              }
            });
            pop.addEventListener?.('pointerenter', () => {
              wrap._ddPopHovered = true;
            });
            pop.addEventListener?.('pointerleave', () => {
              wrap._ddPopHovered = false;
              if (wrap._ddPinnedDot && wrap._ddPopRepositionPending) {
                wrap._ddPopRepositionPending = false;
                wrap._ddPopDetached = false;
                this._ddUpdatePinnedPopPosition?.(wrap);
                this._updateDatasetDiagPinTether?.(wrap);
              }
            });
            pop.addEventListener?.('click', event => {
              if (!wrap._ddPinnedDot?.image_id) return;
              const mediaHit = event.target?.closest?.('.m-dd-pop-media');
              if (mediaHit || !wrap._ddPinnedDot.thumb_url || pop.classList?.contains?.('is-no-media')) {
                event.stopPropagation?.();
                const id = wrap._ddPinnedDot.image_id;
                this._unpinDatasetDiagScatterCard?.(wrap);
                this.openDatasetDiagModal(id);
              }
            });
          }

          if (wrap.dataset.mode === 'timestep') {
            wrap.querySelectorAll('[data-dd-zone-col]').forEach(col => {
              const zKey = col.dataset.ddZoneCol;
              if (!zKey) return;
              col.addEventListener('pointerenter', () => {
                wrap.querySelectorAll('[data-dd-zone-col]').forEach(el => {
                  el.classList.toggle('is-zone-hover', el.dataset.ddZoneCol === zKey);
                });
              });
              col.addEventListener('pointerleave', () => {
                if (wrap._ddActiveBar) return;
                col.classList.remove('is-zone-hover');
              });
            });
          }
        }

        let frame = 0;
        const render = () => {
          frame = 0;
          const nextWidth = Math.round(stage.clientWidth || 0);
          const nextHeight = Math.round(stage.clientHeight || 0);
          const dw = Math.abs(nextWidth - (wrap._ddMeasuredWidth || 0));
          const dh = Math.abs(nextHeight - (wrap._ddMeasuredHeight || 0));
          if (nextWidth > 120 && (dw >= 4 || (nextHeight > 80 && dh >= 1))) {
            wrap._ddMeasuredWidth = nextWidth;
            wrap._ddMeasuredHeight = nextHeight;
            if (!wrap._ddPinnedDot) clearHover();
            this._renderDatasetDiagHeroSvg(wrap, stage, svg);
          }
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
          if (!frame) frame = requestAnimationFrame(render);
        });
        observer?.observe(stage);
        cleanups.push(() => {
          observer?.disconnect();
          if (frame) cancelAnimationFrame(frame);
          if (wrap._ddPan?.rafId && typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(wrap._ddPan.rafId);
          }
          wrap._ddPan = null;
          wrap._ddAnimGeom = null;
          stage.classList?.remove?.('is-panning');
          this._ddStopTimestepMorphAnim?.(svg);
          this._ddStopScatterDotChoreo?.(wrap, svg);
          this._ddStopScatterCameraAnim?.(wrap, svg);
          this._unpinDatasetDiagScatterCard?.(wrap);
          clearHover();
        });
        render();
      });

      if (typeof document !== 'undefined') {
        const onDocClick = event => {
          if (event.defaultPrevented || (event.button != null && event.button !== 0)) return;
          if (this._datasetDiagSuppressDeselectUntil && Date.now() < this._datasetDiagSuppressDeselectUntil) return;
          if ((this.currentRoute && this.currentRoute !== 'monitor-dashboard') || this.monitorTab !== 'dataset') return;
          if (this._ddActiveSubTab?.(this.datasetDiagData) !== 'overview') return;
          if (!event.target?.closest?.('[data-dd-head-scope]')) unpinScopePop();
          const quadWrap = document.querySelector?.('.m-tab-panel[data-tab="dataset"] [data-dd-hero-wrap][data-mode="quadrant"]');
          if (quadWrap?._ddPinnedDot && !event.target?.closest?.('.m-dd-preview-pop, [data-mode="quadrant"] [data-dd-hero-stage]')) {
            this._unpinDatasetDiagScatterCard?.(quadWrap);
          }
          if (!this._datasetDiagHasActiveFilter?.()) return;
          if (this.datasetDiagModalOpen || document.querySelector?.('dialog[open]')) return;
          if (this._ddShouldKeepOverviewSelection(event.target)) return;
          this.resetDatasetDiagFilters();
        };
        const onDocKeydown = event => {
          if (event.defaultPrevented || event.isComposing || event.key !== 'Escape') return;
          if ((this.currentRoute && this.currentRoute !== 'monitor-dashboard') || this.monitorTab !== 'dataset') return;
          if (this._ddActiveSubTab?.(this.datasetDiagData) !== 'overview') return;
          if (this.datasetDiagModalOpen || document.querySelector?.('dialog[open]')) return;
          if (document.querySelector?.('.preview-select-menu:not([inert]), .anima-select-menu:not([inert])')) return;
          if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
          if (unpinScopePop()) {
            event.preventDefault();
            return;
          }
          const quadWrap = document.querySelector?.('.m-tab-panel[data-tab="dataset"] [data-dd-hero-wrap][data-mode="quadrant"]');
          if (quadWrap?._ddPinnedDot) {
            this._unpinDatasetDiagScatterCard?.(quadWrap);
            event.preventDefault();
            return;
          }
          if (!this._datasetDiagHasActiveFilter?.()) return;
          event.preventDefault();
          this.resetDatasetDiagFilters();
        };
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onDocKeydown);
        cleanups.push(() => {
          document.removeEventListener('click', onDocClick);
          document.removeEventListener('keydown', onDocKeydown);
        });
      }

      panel._ddHeroRO = {
        disconnect() {
          cleanups.forEach(fn => fn());
        },
      };
    },

    _rerenderDatasetDiagScatter(opts = {}) {
      const panel = globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const wrap = panel?.querySelector?.('[data-dd-hero-wrap][data-mode="quadrant"]')
        || panel?.querySelector?.('[data-dd-hero-wrap]');
      const stage = wrap?.querySelector?.('[data-dd-hero-stage]');
      const svg = wrap?.querySelector?.('[data-dd-hero-svg]');
      if (!wrap || !stage || !svg) return;
      if (!wrap._ddPinnedDot) this._clearDatasetDiagHeroHover?.(wrap);
      const renderOpts = { animate: !!opts.animate };
      if (opts.durationMs != null) renderOpts.durationMs = opts.durationMs;
      if (opts.cameraMode) renderOpts.cameraMode = opts.cameraMode;
      this._renderDatasetDiagHeroSvg(wrap, stage, svg, renderOpts);
    },

    _pauseDatasetDiagCharts(panel) {
      if (!panel?._ddHeroRO) return;
      panel._ddHeroRO.disconnect();
      panel._ddHeroRO = null;
    },

    _renderDatasetDiagHeroSvg(wrap, stage, svg, options = {}) {
      const data = this.datasetDiagData;
      if (!data || !data.available) return;
      const t = k => this.tMonitor(k);
      const mode = wrap?.dataset?.mode === 'timestep' ? 'timestep' : 'quadrant';
      const width = Math.max(260, Math.round(stage.clientWidth || 700));
      this._ddStopScatterDotChoreo?.(wrap, svg);
      const interruptedCam = this._ddStopScatterCameraAnim?.(wrap, svg) || wrap?._ddCurrentCamera || wrap?._ddCamera || null;
      const renderOpts = {
        ...options,
        stageHeight: Math.round(stage.clientHeight || 0),
        prevCamera: interruptedCam ? { ...interruptedCam } : null,
      };

      const modeChanged = wrap?._ddLastMode && wrap._ddLastMode !== mode;
      if (wrap) wrap._ddLastMode = mode;
      svg.classList.toggle('is-mode-enter', !!modeChanged);
      const wantMotion = !!(options.animate && (!this._monitorMotionAllowed || this._monitorMotionAllowed()));
      if (wantMotion && svg.classList && typeof svg.classList.add === 'function' && !svg.classList.contains?.('is-live-motion')) {
        svg.classList.add('is-live-motion');
        void svg.getBoundingClientRect?.();
      } else {
        svg.classList?.toggle?.('is-live-motion', wantMotion);
      }

      if (mode === 'timestep') {
        this._renderDatasetDiagTimestepSvg(wrap, svg, data, width, t, renderOpts);
        return;
      }
      if (data.summary?.has_slope) {
        this._renderDatasetDiagQuadrantSvg(wrap, svg, data, width, t, renderOpts);
      } else {
        this._renderDatasetDiagEarlySvg(wrap, svg, data, width, t, renderOpts);
      }
    },

    _ddCanReconcileSvg(svg, kind, width, height, expectedSelector) {
      return typeof svg?.querySelector === 'function'
        && typeof globalThis.document?.createElementNS === 'function'
        && svg.getAttribute?.('data-dd-svg-kind') === kind
        && Number(svg.getAttribute?.('data-dd-svg-width') || 0) === width
        && Number(svg.getAttribute?.('data-dd-svg-height') || 0) === height
        && !!svg.querySelector(expectedSelector);
    },

    _ddCaptureAnimGeom(svg, pop) {
      const svgRect = svg?.getBoundingClientRect?.() || null;
      const popSize = pop
        ? { width: pop.offsetWidth || 244, height: pop.offsetHeight || 256 }
        : null;
      return { svgRect, popSize };
    },

    _ddStopScatterDotChoreo(wrap, svg) {
      if (!wrap) return;
      wrap._ddDotChoreoToken = (wrap._ddDotChoreoToken || 0) + 1;
      if (wrap._ddDotChoreoRaf && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(wrap._ddDotChoreoRaf);
      }
      wrap._ddDotChoreoRaf = 0;
      if (wrap._ddDotChoreoTimer && typeof globalThis.clearTimeout === 'function') {
        globalThis.clearTimeout(wrap._ddDotChoreoTimer);
      }
      wrap._ddDotChoreoTimer = 0;
      wrap._ddLiveDotCoords = null;
      if (!wrap._ddZoomAnimRaf && !wrap._ddPan?.active) wrap._ddAnimGeom = null;
      svg?.classList?.remove?.('is-dot-choreo');
      const commit = wrap._ddDotChoreoCommit;
      wrap._ddDotChoreoCommit = null;
      if (typeof commit === 'function') {
        try { commit(); } catch (_) {}
      } else {
        const trailsGroup = svg?.querySelector?.('.m-dd-trails');
        if (trailsGroup) trailsGroup.innerHTML = '';
      }
    },

    _ddBuildArrowGeometry(x1, y1, x2, y2, p = 1) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const tipX = x1 + dx * p;
      const tipY = y1 + dy * p;
      const wingScale = p >= 0.18 ? 1 : (0.3 + 0.7 * (p / 0.18));
      const wingLen = 5.5 * wingScale;
      const cosA = 0.8829;
      const sinA = 0.4695;
      const bx = tipX - ux * wingLen * cosA;
      const by = tipY - uy * wingLen * cosA;
      const px = -uy * wingLen * sinA;
      const py = ux * wingLen * sinA;
      const headPath = `M ${(bx + px).toFixed(1)} ${(by + py).toFixed(1)} L ${tipX.toFixed(1)} ${tipY.toFixed(1)} L ${(bx - px).toFixed(1)} ${(by - py).toFixed(1)}`;
      return { x1, y1, tipX, tipY, headPath };
    },

    _ddCreateScatterArrowNode(trailsGroup, x1, y1, x2, y2, color, imageId) {
      const ns = 'http://www.w3.org/2000/svg';
      const g = globalThis.document.createElementNS(ns, 'g');
      g.setAttribute('class', 'm-dd-move-arrow');
      if (imageId) g.setAttribute('data-dd-image-id', imageId);
      const shaft = globalThis.document.createElementNS(ns, 'line');
      shaft.setAttribute('class', 'm-dd-dot-arrow-shaft');
      shaft.setAttribute('x1', x1.toFixed(1));
      shaft.setAttribute('y1', y1.toFixed(1));
      shaft.setAttribute('x2', x1.toFixed(1));
      shaft.setAttribute('y2', y1.toFixed(1));
      shaft.style.stroke = color;
      const head = globalThis.document.createElementNS(ns, 'path');
      head.setAttribute('class', 'm-dd-dot-arrow-head');
      head.style.stroke = color;
      g.appendChild?.(shaft);
      g.appendChild?.(head);
      trailsGroup.appendChild(g);
      return {
        g, shaft, head, x1, y1, x2, y2,
        update: (p, opacity) => {
          const geom = this._ddBuildArrowGeometry(x1, y1, x2, y2, p);
          shaft.setAttribute('x2', geom.tipX.toFixed(1));
          shaft.setAttribute('y2', geom.tipY.toFixed(1));
          head.setAttribute('d', geom.headPath);
          if (g.style) g.style.opacity = opacity.toFixed(3);
        },
        remove: () => g.remove?.(),
      };
    },

    _ddSpawnScatterTrails(trailsGroup, wrap, coords, options) {
      if (options?.scaleChanged) return;
      if (!trailsGroup || !options?.animate || !options?.pulseSeq || options.pulseSeq === wrap?._ddLastTrailSeq) return;
      if (!options.updatedIds?.size || (this._monitorMotionAllowed && !this._monitorMotionAllowed())) return;
      const prevMap = wrap?._ddPrevDotCoords;
      if (!prevMap || !prevMap.size) return;
      wrap._ddLastTrailSeq = options.pulseSeq;
      const candidates = [];
      for (const d of coords) {
        if (!options.updatedIds.has(d.image_id)) continue;
        const prev = prevMap.get(d.image_id);
        if (!prev) continue;
        const dist = Math.hypot(d.cx - prev.cx, d.cy - prev.cy);
        if (dist <= 8) continue;
        candidates.push({ d, prev, dist, prio: _dotEffectPriority(d.status) });
      }
      if (candidates.length > MAX_SCATTER_EFFECTS) {
        candidates.sort((a, b) => (b.prio - a.prio) || (b.dist - a.dist));
        candidates.length = MAX_SCATTER_EFFECTS;
      }
      for (const item of candidates) {
        const { d, prev } = item;
        const arrow = this._ddCreateScatterArrowNode(trailsGroup, prev.cx, prev.cy, d.cx, d.cy, d.fill, d.image_id);
        arrow.update(1, 0.78);
        setTimeout(() => arrow.remove(), 1100);
      }
    },

    _ddSpawnScatterPulses(pulsesGroup, wrap, coords, options) {
      if (!pulsesGroup || !options?.pulseSeq || options.pulseSeq === wrap?._ddLastPulseSeq) return;
      if (this._monitorMotionAllowed && !this._monitorMotionAllowed()) return;
      const newIds = options.newIds instanceof Set ? options.newIds : null;
      const targetIds = newIds || options.updatedIds;
      if (!targetIds?.size) return;
      wrap._ddLastPulseSeq = options.pulseSeq;
      const prevMap = wrap?._ddPrevDotCoords;
      const candidates = [];
      for (const d of coords) {
        if (!targetIds.has(d.image_id)) continue;
        const prev = prevMap?.get?.(d.image_id);
        const dist = prev ? Math.hypot(d.cx - prev.cx, d.cy - prev.cy) : Math.abs(Number(d.mean_residual) || 0);
        candidates.push({ d, prio: _dotEffectPriority(d.status), dist });
      }
      if (candidates.length > MAX_SCATTER_EFFECTS) {
        candidates.sort((a, b) => (b.prio - a.prio) || (b.dist - a.dist));
        candidates.length = MAX_SCATTER_EFFECTS;
      }
      const ns = 'http://www.w3.org/2000/svg';
      for (const { d } of candidates) {
        const ring = globalThis.document.createElementNS(ns, 'circle');
        ring.setAttribute('class', 'm-dd-dot-pulse');
        ring.setAttribute('data-dd-image-id', d.image_id);
        ring.setAttribute('cx', d.cx.toFixed(1));
        ring.setAttribute('cy', d.cy.toFixed(1));
        ring.setAttribute('r', (d.r + 1.5).toFixed(1));
        ring.style.stroke = d.fill;
        let removed = false;
        const cleanup = () => {
          if (removed) return;
          removed = true;
          ring.remove();
        };
        ring.addEventListener?.('animationend', cleanup, { once: true });
        setTimeout(cleanup, 1350);
        pulsesGroup.appendChild(ring);
      }
    },

    _ddStartScatterDotChoreo(svg, wrap, movingEntries, existingRings, dotsGroup, newIds, liveCoordsMap) {
      const ns = 'http://www.w3.org/2000/svg';
      const trailsGroup = svg.querySelector('.m-dd-trails');
      const token = (wrap._ddDotChoreoToken = (wrap._ddDotChoreoToken || 0) + 1);
      wrap._ddLiveDotCoords = liveCoordsMap;
      const entryById = new Map(movingEntries.map(e => [e.d.image_id, e]));

      const applyEntryAppearance = entry => {
        const { d, dot } = entry;
        dot.setAttribute('class', d.cls || 'm-dd-dot');
        dot.setAttribute('data-dd-status', d.status || '');
        dot.setAttribute('r', d.r.toFixed(1));
        dot.style.fill = d.fill;
        let ring = entry.ring ?? existingRings.get(d.image_id);
        if (d.status === 'non_finite') {
          if (!ring) {
            ring = globalThis.document.createElementNS(ns, 'circle');
            ring.setAttribute('class', 'm-dd-dot-nan-ring');
            ring.setAttribute('data-dd-image-id', d.image_id);
            ring.setAttribute('data-dd-status', 'non_finite');
            dotsGroup.appendChild(ring);
          }
          const live = liveCoordsMap.get(d.image_id) || { cx: d.cx, cy: d.cy };
          ring.setAttribute('cx', live.cx.toFixed(1));
          ring.setAttribute('cy', live.cy.toFixed(1));
          ring.setAttribute('r', (d.r + 3.2).toFixed(1));
          entry.ring = ring;
          existingRings.set(d.image_id, ring);
        } else if (ring) {
          ring.remove();
          entry.ring = null;
          existingRings.delete(d.image_id);
        }
      };

      wrap._ddDotChoreoCommit = () => {
        if (trailsGroup) trailsGroup.innerHTML = '';
        svg.classList?.remove?.('is-dot-choreo');
        wrap._ddLiveDotCoords = null;
        wrap._ddAnimGeom = null;
        for (const entry of movingEntries) {
          const { d, dot } = entry;
          applyEntryAppearance(entry);
          dot.setAttribute('cx', d.cx.toFixed(1));
          dot.setAttribute('cy', d.cy.toFixed(1));
          if (entry.ring) {
            entry.ring.setAttribute('cx', d.cx.toFixed(1));
            entry.ring.setAttribute('cy', d.cy.toFixed(1));
          }
        }
      };

      const nowFn = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());
      const ENTER_MS = newIds.size > 0 ? 520 : 0;
      const ARROW_GROW_MS = 1250;
      const ARROW_HOLD_MS = 220;
      const MOVE_MS = 950;
      const EXPO_DENOM = 1 - Math.pow(2, -9);

      const startStage3 = arrowBindings => {
        if (wrap._ddDotChoreoToken !== token) return;
        svg.classList?.add?.('is-dot-choreo');
        for (const entry of movingEntries) applyEntryAppearance(entry);
        this._syncDatasetDiagScatterFilter?.(wrap, { skipReorder: true, skipPopReposition: true });
        const pop = wrap.querySelector?.('[data-dd-preview-pop]');
        wrap._ddAnimGeom = this._ddCaptureAnimGeom(svg, pop);
        const startTs = nowFn();
        const tickMove = () => {
          if (wrap._ddDotChoreoToken !== token) return;
          const raw = Math.min(1, Math.max(0, (nowFn() - startTs) / MOVE_MS));
          const eased = raw <= 0 ? 0 : (raw >= 1 ? 1 : (1 - Math.pow(2, -9 * raw)) / EXPO_DENOM);
          const arrowOp = raw <= 0.25 ? 0.78 : 0.78 * Math.max(0, 1 - (raw - 0.25) / 0.75);

          for (const entry of movingEntries) {
            const cx = entry.prevCx + (entry.d.cx - entry.prevCx) * eased;
            const cy = entry.prevCy + (entry.d.cy - entry.prevCy) * eased;
            entry.dot.setAttribute('cx', cx.toFixed(1));
            entry.dot.setAttribute('cy', cy.toFixed(1));
            if (entry.ring) {
              entry.ring.setAttribute('cx', cx.toFixed(1));
              entry.ring.setAttribute('cy', cy.toFixed(1));
            }
            liveCoordsMap.set(entry.d.image_id, { cx, cy });
          }
          for (const ab of arrowBindings) ab.update(1, arrowOp);

          const focusId = wrap._ddPinnedDot?.image_id || wrap._ddHoverDot?.image_id;
          const focusEntry = focusId ? entryById.get(focusId) : null;
          if (focusEntry && liveCoordsMap.has(focusId)) {
            const livePos = liveCoordsMap.get(focusId);
            const focusPt = focusEntry.d;
            this._ddSyncScatterFocusVisuals?.(wrap, svg, focusPt, livePos.cx, livePos.cy);
            if (wrap._ddPinnedDot?.image_id === focusId) {
              if (wrap._ddPopHovered) {
                wrap._ddPopRepositionPending = true;
              } else {
                wrap._ddPopRepositionPending = false;
                this._ddUpdatePinnedPopPosition?.(wrap, { wasHidden: false, immediate: true, cx: livePos.cx, cy: livePos.cy });
              }
              this._updateDatasetDiagPinTether?.(wrap, livePos.cx, livePos.cy);
            }
          }

          if (raw < 1) {
            wrap._ddDotChoreoRaf = globalThis.requestAnimationFrame(tickMove);
          } else {
            wrap._ddDotChoreoRaf = 0;
            wrap._ddDotChoreoCommit = null;
            wrap._ddLiveDotCoords = null;
            wrap._ddAnimGeom = null;
            if (trailsGroup) trailsGroup.innerHTML = '';
            svg.classList?.remove?.('is-dot-choreo');
            this._refreshDatasetDiagActiveHover?.(wrap);
            this._syncDatasetDiagScatterTrajectory?.(wrap);
          }
        };
        wrap._ddDotChoreoRaf = globalThis.requestAnimationFrame(tickMove);
      };

      const startStage2 = () => {
        if (wrap._ddDotChoreoToken !== token) return;
        const arrowBindings = [];
        if (trailsGroup) {
          trailsGroup.innerHTML = '';
          for (const entry of movingEntries) {
            if (!entry.showArrow) continue;
            arrowBindings.push(this._ddCreateScatterArrowNode(
              trailsGroup, entry.prevCx, entry.prevCy, entry.d.cx, entry.d.cy, entry.d.fill, entry.d.image_id
            ));
          }
        }
        if (!arrowBindings.length) {
          startStage3(arrowBindings);
          return;
        }
        const startTs = nowFn();
        const tickGrow = () => {
          if (wrap._ddDotChoreoToken !== token) return;
          const raw = Math.min(1, Math.max(0, (nowFn() - startTs) / ARROW_GROW_MS));
          for (const ab of arrowBindings) ab.update(raw, 0.78);
          if (raw < 1) {
            wrap._ddDotChoreoRaf = globalThis.requestAnimationFrame(tickGrow);
          } else {
            wrap._ddDotChoreoRaf = 0;
            wrap._ddDotChoreoTimer = globalThis.setTimeout(() => {
              wrap._ddDotChoreoTimer = 0;
              startStage3(arrowBindings);
            }, ARROW_HOLD_MS);
          }
        };
        wrap._ddDotChoreoRaf = globalThis.requestAnimationFrame(tickGrow);
      };

      if (ENTER_MS > 0) {
        wrap._ddDotChoreoTimer = globalThis.setTimeout(() => {
          wrap._ddDotChoreoTimer = 0;
          startStage2();
        }, ENTER_MS);
      } else {
        startStage2();
      }
    },

    _ddReconcileScatterDots(svg, wrap, coords, options) {
      this._ddStopScatterDotChoreo?.(wrap, svg);
      const dotsGroup = svg.querySelector('.m-dd-dots');
      if (!dotsGroup) return;
      const ns = 'http://www.w3.org/2000/svg';
      const prevMap = wrap?._ddPrevDotCoords || null;

      const existingDots = new Map();
      const existingRings = new Map();
      for (const child of Array.from(dotsGroup.children)) {
        const id = child.dataset?.ddImageId;
        if (!id) continue;
        if (child.classList.contains('m-dd-dot')) existingDots.set(id, child);
        else if (child.classList.contains('m-dd-dot-nan-ring')) existingRings.set(id, child);
      }
      const nextIds = new Set(coords.map(c => c.image_id));
      for (const [id, el] of existingDots) {
        if (!nextIds.has(id)) el.remove();
      }
      for (const [id, el] of existingRings) {
        if (!nextIds.has(id)) el.remove();
      }

      const newIds = new Set();
      const movingEntries = [];
      for (const d of coords) {
        const dot = existingDots.get(d.image_id);
        if (!dot) {
          newIds.add(d.image_id);
          continue;
        }
        let prev = prevMap?.get?.(d.image_id) || null;
        if (!prev) {
          const ax = Number(dot.getAttribute?.('cx'));
          const ay = Number(dot.getAttribute?.('cy'));
          if (Number.isFinite(ax) && Number.isFinite(ay)) prev = { cx: ax, cy: ay };
        }
        if (prev && Number.isFinite(prev.cx) && Number.isFinite(prev.cy)) {
          const dist = Math.hypot(d.cx - prev.cx, d.cy - prev.cy);
          if (dist > 0.1) {
            const wantArrow = !options?.scaleChanged && dist > 8
              && (!options?.updatedIds || options.updatedIds.has(d.image_id));
            movingEntries.push({
              d, dot, ring: existingRings.get(d.image_id) || null,
              prevCx: prev.cx, prevCy: prev.cy, dist, showArrow: wantArrow,
              prio: _dotEffectPriority(d.status),
            });
          }
        }
      }

      // Cap concurrent displacement arrows while letting every moving dot glide smoothly.
      const arrowCandidates = movingEntries.filter(e => e.showArrow);
      if (arrowCandidates.length > MAX_SCATTER_EFFECTS) {
        arrowCandidates.sort((a, b) => (b.prio - a.prio) || (b.dist - a.dist));
        for (let i = MAX_SCATTER_EFFECTS; i < arrowCandidates.length; i++) {
          arrowCandidates[i].showArrow = false;
        }
      }

      const useChoreo = Boolean(
        options?.animate
        && !options?.scaleChanged
        && movingEntries.length > 0
        && (!this._monitorMotionAllowed || this._monitorMotionAllowed())
        && typeof globalThis.requestAnimationFrame === 'function'
        && typeof globalThis.setTimeout === 'function'
      );
      const movingMap = useChoreo ? new Map(movingEntries.map(e => [e.d.image_id, e])) : null;
      const liveCoordsMap = useChoreo ? new Map() : null;
      const animateEnter = !!(options?.animate && (!this._monitorMotionAllowed || this._monitorMotionAllowed()));

      for (const d of coords) {
        let dot = existingDots.get(d.image_id);
        const isNewDot = !dot;
        if (!dot) {
          dot = globalThis.document.createElementNS(ns, 'circle');
          dot.setAttribute('data-dd-image-id', d.image_id);
          dotsGroup.appendChild(dot);
        }
        const movingEntry = movingMap?.get(d.image_id);
        if (movingEntry) {
          dot.setAttribute('cx', movingEntry.prevCx.toFixed(1));
          dot.setAttribute('cy', movingEntry.prevCy.toFixed(1));
          liveCoordsMap.set(d.image_id, { cx: movingEntry.prevCx, cy: movingEntry.prevCy });
          continue;
        }

        dot.setAttribute('class', (d.cls || 'm-dd-dot') + (isNewDot && animateEnter ? ' is-dot-enter' : ''));
        dot.setAttribute('data-dd-status', d.status || '');
        dot.setAttribute('cx', d.cx.toFixed(1));
        dot.setAttribute('cy', d.cy.toFixed(1));
        dot.setAttribute('r', d.r.toFixed(1));
        dot.style.fill = d.fill;
        if (isNewDot && animateEnter) {
          const endEnter = () => dot.classList?.remove('is-dot-enter');
          dot.addEventListener?.('animationend', endEnter, { once: true });
          setTimeout(endEnter, 520);
        }

        const existingRing = existingRings.get(d.image_id);
        if (d.status === 'non_finite') {
          const ring = existingRing || globalThis.document.createElementNS(ns, 'circle');
          if (!existingRing) {
            ring.setAttribute('class', 'm-dd-dot-nan-ring');
            ring.setAttribute('data-dd-image-id', d.image_id);
            ring.setAttribute('data-dd-status', 'non_finite');
            dotsGroup.appendChild(ring);
          }
          ring.setAttribute('cx', d.cx.toFixed(1));
          ring.setAttribute('cy', d.cy.toFixed(1));
          ring.setAttribute('r', (d.r + 3.2).toFixed(1));
        } else if (existingRing) {
          existingRing.remove();
        }
      }

      if (!useChoreo) {
        this._ddSpawnScatterTrails(svg.querySelector('.m-dd-trails'), wrap, coords, options);
      }
      if (wrap) {
        wrap._ddPrevDotCoords = new Map(coords.map(d => [d.image_id, { cx: d.cx, cy: d.cy }]));
      }
      this._ddSpawnScatterPulses(svg.querySelector('.m-dd-pulses'), wrap, coords, { ...options, newIds });
      if (useChoreo) {
        this._ddStartScatterDotChoreo(svg, wrap, movingEntries, existingRings, dotsGroup, newIds, liveCoordsMap);
      }
    },

    _ddRepresentativePoints(points, limit, extrema) {
      if (points.length <= limit) return points;
      const selected = new Set(extrema);
      const spread = (items, count) => {
        const size = Math.min(items.length, count);
        for (let index = 0; index < size; index++) {
          const position = size === 1 ? 0 : Math.round(index * (items.length - 1) / (size - 1));
          selected.add(items[position]);
        }
      };
      spread(points.filter(point => point.status === 'non_finite'), Math.floor(limit / 4));
      spread(points.filter(point => point.status === 'attention'), Math.floor(limit / 4));
      spread(points.filter(point => !selected.has(point)), limit - selected.size);
      return Array.from(selected);
    },

    _ddFindScatterResetBtn(wrap) {
      return wrap?.querySelector?.('[data-dd-zoom-reset]')
        || wrap?.closest?.('[data-dd-analysis]')?.querySelector?.('[data-dd-zoom-reset]')
        || wrap?.closest?.('[data-dd-slot="analysis"]')?.querySelector?.('[data-dd-zoom-reset]')
        || null;
    },

    _ddSetChartCoverage(wrap, t, shown, eligible, total) {
      const element = wrap?.querySelector?.('[data-dd-chart-coverage]')
        || wrap?.closest?.('[data-dd-analysis]')?.querySelector?.('[data-dd-chart-coverage]')
        || wrap?.closest?.('[data-dd-slot="analysis"]')?.querySelector?.('[data-dd-chart-coverage]')
        || wrap?.closest?.('[data-dd-slot="hero"]')?.querySelector?.('[data-dd-chart-coverage]');
      if (!element) return;
      if (shown < eligible) {
        element.textContent = t('ddChartCoverage')
          .replace('{shown}', shown).replace('{eligible}', eligible);
      } else if (eligible < total) {
        element.textContent = t('ddChartShown')
          .replace('{n}', eligible).replace('{total}', total);
      } else {
        element.textContent = '';
      }
      this._ddSyncDashActionsVisibility(element.closest?.('[data-dd-dash-actions]'));
    },

    _syncDatasetDiagScatterFilter(root, opts = {}) {
      const container = root || globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const wrap = container?.matches?.('[data-dd-hero-wrap]')
        ? container
        : (container?.querySelector?.('[data-dd-hero-wrap][data-mode="quadrant"]') || container?.querySelector?.('[data-dd-hero-wrap]'));
      const svg = wrap?.querySelector?.('[data-dd-hero-svg]');
      const st = wrap?._ddChartState;
      if (!svg || !st || st.kind !== 'scatter') return;

      const preview = this._datasetDiagHoverPreview;
      let active = false;
      let matchedIds = null;
      if (preview?.kind === 'image' && preview.imageId) {
        active = true;
        matchedIds = new Set([preview.imageId]);
      } else if (preview?.kind === 'preset' && preview.preset) {
        active = true;
        const rows = this.datasetDiagData?.by_image || [];
        matchedIds = new Set(
          rows.filter(img => (this._datasetDiagImageMatchesPreset
            ? this._datasetDiagImageMatchesPreset(img, preview.preset)
            : img.status === preview.preset)).map(img => img.image_id)
        );
      } else if (preview?.kind === 'group' && preview.dim && preview.dim !== 'batch_size') {
        active = true;
        const rows = this.datasetDiagData?.by_image || [];
        matchedIds = new Set(rows.filter(img => {
          if (preview.dim === 'resolution') return (img.resolutions || [img.resolution]).includes(preview.key);
          if (preview.dim === 'subset') return (img.subsets || [img.subset]).includes(preview.key);
          if (preview.dim === 'directory') return (img.directory || '(root)') === preview.key;
          return false;
        }).map(img => img.image_id));
      } else {
        active = this._datasetDiagHasActiveFilter?.() || false;
        matchedIds = active ? this._datasetDiagFilteredIdSet?.() : null;
      }

      const dotsGroup = svg.querySelector?.('.m-dd-dots');
      const matchedNodes = [];
      svg.querySelectorAll?.('.m-dd-dot').forEach?.(dot => {
        const id = dot.dataset?.ddImageId || '';
        const isMatched = !active || !!matchedIds?.has(id);
        dot.classList?.toggle('is-dimmed', active && !isMatched);
        dot.classList?.toggle('is-matched', active && isMatched);
        if (active && isMatched) matchedNodes.push(dot);
      });
      svg.querySelectorAll?.('.m-dd-dot-nan-ring').forEach?.(ring => {
        const id = ring.dataset?.ddImageId || '';
        const isMatched = !active || !!matchedIds?.has(id);
        ring.classList?.toggle('is-dimmed', active && !isMatched);
        ring.classList?.toggle('is-matched', active && isMatched);
        if (active && isMatched) matchedNodes.push(ring);
      });
      if (dotsGroup && matchedNodes.length && !opts.skipReorder && typeof dotsGroup.appendChild === 'function') {
        const kids = Array.from(dotsGroup.children || []);
        const tailStart = kids.length - matchedNodes.length;
        const alreadyAtEnd = tailStart >= 0 && matchedNodes.every((node, idx) => kids[tailStart + idx] === node);
        if (!alreadyAtEnd) {
          matchedNodes.forEach(node => dotsGroup.appendChild(node));
        }
      }

      if (!wrap._ddActiveDot) {
        const ch = svg.querySelector?.('[data-dd-crosshair]');
        const focusRing = svg.querySelector?.('[data-dd-dot-focus]');
        if (preview?.kind === 'image' && preview.imageId) {
          const target = st.coords?.find(pt => pt.image_id === preview.imageId);
          const inBounds = target
            && target.cx >= st.padL - 2 && target.cx <= st.padL + st.plotW + 2
            && target.cy >= st.padT - 2 && target.cy <= st.padT + st.plotH + 2;
          if (inBounds) {
            wrap._ddPreviewFocusId = target.image_id;
            if (ch) {
              const vx = ch.querySelector?.('[data-dd-ch-x]');
              const hy = ch.querySelector?.('[data-dd-ch-y]');
              if (vx) { vx.setAttribute('x1', target.cx.toFixed(1)); vx.setAttribute('x2', target.cx.toFixed(1)); }
              if (hy) {
                if (Number.isFinite(target.slope)) {
                  hy.setAttribute('y1', target.cy.toFixed(1));
                  hy.setAttribute('y2', target.cy.toFixed(1));
                  hy.removeAttribute?.('display');
                } else {
                  hy.setAttribute('display', 'none');
                }
              }
              ch.removeAttribute('display');
            }
            if (focusRing) {
              focusRing.setAttribute('cx', target.cx.toFixed(1));
              focusRing.setAttribute('cy', target.cy.toFixed(1));
              focusRing.setAttribute('r', (target.r + 3.5).toFixed(1));
              focusRing.style.stroke = target.fill;
              focusRing.removeAttribute('display');
            }
          } else {
            wrap._ddPreviewFocusId = '';
            ch?.setAttribute('display', 'none');
            focusRing?.setAttribute('display', 'none');
          }
        } else if (wrap._ddPreviewFocusId) {
          wrap._ddPreviewFocusId = '';
          ch?.setAttribute('display', 'none');
          focusRing?.setAttribute('display', 'none');
        }
      }

      const preset = preview?.kind === 'preset' ? preview.preset : (this.datasetDiagPreset || 'all');
      svg.querySelectorAll?.('[data-dd-zone-preset]').forEach?.(zone => {
        const zp = zone.dataset?.ddZonePreset;
        zone.classList?.toggle('is-active', !!zp && preset === zp);
      });
      st.matchedIds = matchedIds;
      st.filterActive = active;
      this._syncDatasetDiagScatterTrajectory?.(wrap, opts.skipPopReposition ? { skipPopReposition: true } : null);
    },

    _syncDatasetDiagZonesVisibility(root) {
      const panel = root || globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const show = !!this.datasetDiagShowZones;
      const toggleEl = panel?.querySelector?.('#ddZoneShadingToggle');
      if (toggleEl) toggleEl.checked = show;
      const wrap = panel?.querySelector?.('[data-dd-hero-wrap][data-mode="quadrant"]');
      const svg = wrap?.querySelector?.('[data-dd-hero-svg]');
      const stage = wrap?.querySelector?.('[data-dd-hero-stage]');
      svg?.classList?.toggle?.('is-zones-on', show);
      if (!show && wrap?._ddHoverZone) {
        wrap._ddHoverZone = null;
        stage?.classList?.remove?.('has-zone-hover');
        this._syncDatasetDiagStatusHighlight?.(panel);
      }
    },

    _ddHitTestScatterDot(st, x, y, liveCoords = null) {
      if (!st || !Array.isArray(st.coords)) return null;
      const posOf = pt => {
        const live = liveCoords?.get?.(pt.image_id);
        return live ? { cx: live.cx, cy: live.cy } : pt;
      };
      const inBox = pos => pos.cx >= st.padL - 2 && pos.cx <= st.padL + st.plotW + 2
        && pos.cy >= st.padT - 2 && pos.cy <= st.padT + st.plotH + 2;
      if (st.filterActive && st.matchedIds) {
        let best = null, bestD2 = 22 * 22;
        for (const pt of st.coords) {
          const pos = posOf(pt);
          if (!inBox(pos) || !st.matchedIds.has(pt.image_id)) continue;
          const dx = pos.cx - x, dy = pos.cy - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) { bestD2 = d2; best = pt; }
        }
        if (best) return best;
        let dimBest = null, dimD2 = 14 * 14;
        for (const pt of st.coords) {
          const pos = posOf(pt);
          if (!inBox(pos)) continue;
          const dx = pos.cx - x, dy = pos.cy - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= dimD2) { dimD2 = d2; dimBest = pt; }
        }
        return dimBest;
      }
      let best = null, bestD2 = 22 * 22;
      for (const pt of st.coords) {
        const pos = posOf(pt);
        if (!inBox(pos)) continue;
        const dx = pos.cx - x, dy = pos.cy - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) { bestD2 = d2; best = pt; }
      }
      return best;
    },

    _ddHitTestScatterZone(st, x, y) {
      if (!this.datasetDiagShowZones || !st || !Array.isArray(st.zones)) return null;
      return st.zones.find(z => x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) || null;
    },

    _ddReconcileZoneRect(group, preset, x, y, w, h, show) {
      const el = group?.querySelector?.(`[data-dd-zone-preset="${preset}"]`);
      if (!el) return;
      el.removeAttribute('display');
      el.setAttribute('x', x.toFixed(1));
      el.setAttribute('y', y.toFixed(1));
      el.setAttribute('width', (show ? Math.max(0, w) : 0).toFixed(1));
      el.setAttribute('height', (show ? Math.max(0, h) : 0).toFixed(1));
    },

    _ddScatterAxisConfig(axis) {
      return axis === 'x'
        ? { linThresh: 1.0, trigger: 1.2, k: 0.50 }
        : { linThresh: 0.20, trigger: 0.24, k: 0.50 };
    },

    _ddAxisWarp(v, linThresh, k, weight = 1) {
      if (weight <= 0) return v;
      const abs = Math.abs(v);
      const comp = abs <= linThresh ? v : Math.sign(v) * linThresh * (1 + k * Math.log(abs / linThresh));
      return weight >= 1 ? comp : ((1 - weight) * v + weight * comp);
    },

    _ddAxisUnwarp(u, linThresh, k, weight = 1) {
      if (weight <= 0) return u;
      if (weight >= 1) {
        const abs = Math.abs(u);
        return abs <= linThresh ? u : Math.sign(u) * linThresh * Math.exp((abs / linThresh - 1) / k);
      }
      const abs = Math.abs(u);
      if (abs <= linThresh) return u;
      const sign = Math.sign(u);
      let lo = linThresh;
      let hi = Math.max(linThresh * 2, abs * 2);
      while (this._ddAxisWarp(hi, linThresh, k, weight) < abs && hi < 1e9) hi *= 2;
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) * 0.5;
        if (this._ddAxisWarp(mid, linThresh, k, weight) < abs) lo = mid;
        else hi = mid;
      }
      return sign * ((lo + hi) * 0.5);
    },

    _ddBuildAxisScale(min, max, linThresh, k, symWeight, pxStart, pxSpan, invertY = false) {
      const wMin = this._ddAxisWarp(min, linThresh, k, symWeight);
      const wMax = this._ddAxisWarp(max, linThresh, k, symWeight);
      const wSpan = Math.max(wMax - wMin, 1e-6);
      const toPx = invertY
        ? v => pxStart + pxSpan - ((this._ddAxisWarp(v, linThresh, k, symWeight) - wMin) / wSpan) * pxSpan
        : v => pxStart + ((this._ddAxisWarp(v, linThresh, k, symWeight) - wMin) / wSpan) * pxSpan;
      const fromPx = invertY
        ? py => this._ddAxisUnwarp(wMin + (Math.max(0, Math.min(pxSpan, pxStart + pxSpan - py)) / pxSpan) * wSpan, linThresh, k, symWeight)
        : px => this._ddAxisUnwarp(wMin + (Math.max(0, Math.min(pxSpan, px - pxStart)) / pxSpan) * wSpan, linThresh, k, symWeight);
      return { toPx, fromPx };
    },

    _ddMakeAxisAnimator(fromMin, fromMax, fromSymW, toMin, toMax, toSymW, linThresh, k, pxStart, pxSpan, invertY = false) {
      const useToAnchor = (toMax - toMin) <= (fromMax - fromMin);
      const z0 = useToAnchor ? toMin : fromMin;
      const z1 = useToAnchor ? toMax : fromMax;
      const wFMin = this._ddAxisWarp(fromMin, linThresh, k, fromSymW);
      const wFSpan = Math.max(this._ddAxisWarp(fromMax, linThresh, k, fromSymW) - wFMin, 1e-6);
      const p0Start = (this._ddAxisWarp(z0, linThresh, k, fromSymW) - wFMin) / wFSpan;
      const p1Start = (this._ddAxisWarp(z1, linThresh, k, fromSymW) - wFMin) / wFSpan;
      const wTMin = this._ddAxisWarp(toMin, linThresh, k, toSymW);
      const wTSpan = Math.max(this._ddAxisWarp(toMax, linThresh, k, toSymW) - wTMin, 1e-6);
      const p0End = (this._ddAxisWarp(z0, linThresh, k, toSymW) - wTMin) / wTSpan;
      const p1End = (this._ddAxisWarp(z1, linThresh, k, toSymW) - wTMin) / wTSpan;
      const s0 = Math.max(1e-6, p1Start - p0Start);
      const s1 = Math.max(1e-6, p1End - p0End);
      const ratio = s1 / s0;
      return e => {
        const symW = fromSymW + (toSymW - fromSymW) * e;
        const u = Math.abs(s1 - s0) < 1e-4 ? e : (s0 * Math.pow(ratio, e) - s0) / (s1 - s0);
        const p0 = p0Start + (p0End - p0Start) * u;
        const p1 = p1Start + (p1End - p1Start) * u;
        const pSpan = Math.max(1e-9, p1 - p0);
        const w0 = this._ddAxisWarp(z0, linThresh, k, symW);
        const w1 = this._ddAxisWarp(z1, linThresh, k, symW);
        const wSpan = Math.max(1e-9, w1 - w0);
        const toPx = invertY
          ? v => pxStart + pxSpan - (p0 + ((this._ddAxisWarp(v, linThresh, k, symW) - w0) / wSpan) * pSpan) * pxSpan
          : v => pxStart + (p0 + ((this._ddAxisWarp(v, linThresh, k, symW) - w0) / wSpan) * pSpan) * pxSpan;
        const fromPx = invertY
          ? py => {
              const f = Math.max(0, Math.min(1, (pxStart + pxSpan - py) / pxSpan));
              return this._ddAxisUnwarp(w0 + ((f - p0) / pSpan) * wSpan, linThresh, k, symW);
            }
          : px => {
              const f = Math.max(0, Math.min(1, (px - pxStart) / pxSpan));
              return this._ddAxisUnwarp(w0 + ((f - p0) / pSpan) * wSpan, linThresh, k, symW);
            };
        const getCamera = () => ({
          min: this._ddAxisUnwarp(w0 + ((0 - p0) / pSpan) * wSpan, linThresh, k, symW),
          max: this._ddAxisUnwarp(w0 + ((1 - p0) / pSpan) * wSpan, linThresh, k, symW),
          symW,
        });
        return { symW, toPx, fromPx, getCamera };
      };
    },

    _ddSnapOutward(val, axis, dir) {
      const abs = Math.abs(val);
      let step;
      if (axis === 'x') {
        step = abs <= 1.0 ? 0.20 : (abs <= 3.0 ? 0.50 : (abs <= 10.0 ? 2.0 : Math.pow(10, Math.floor(Math.log10(abs)))));
      } else {
        step = abs <= 0.12 ? 0.04 : (abs <= 0.40 ? 0.08 : (abs <= 2.0 ? 0.20 : Math.pow(10, Math.floor(Math.log10(abs)))));
      }
      const snapped = dir < 0 ? Math.floor(val / step) * step : Math.ceil(val / step) * step;
      return Math.round(snapped * 1e6) / 1e6;
    },

    _ddSoftCenterAxisBounds(min, max, axis) {
      const cfg = this._ddScatterAxisConfig(axis);
      const compressed = max > cfg.trigger || min < -cfg.trigger;
      const symW = compressed ? 1 : 0;
      const wPos = this._ddAxisWarp(max, cfg.linThresh, cfg.k, symW);
      const wNeg = -this._ddAxisWarp(min, cfg.linThresh, cfg.k, symW);
      if (!(wPos > 0) || !(wNeg > 0)) return [min, max];

      const big = Math.max(wPos, wNeg);
      const small = Math.min(wPos, wNeg);
      const targetW = (small / big) >= 0.60 ? big : (big * 0.52);
      if (targetW <= small + 1e-6) return [min, max];

      const rawVal = this._ddAxisUnwarp(targetW, cfg.linThresh, cfg.k, symW);
      if (wNeg < wPos) {
        const negCap = axis === 'x' ? 1.0 : (compressed ? cfg.linThresh : cfg.trigger);
        const snappedMag = this._ddSnapOutward(rawVal, axis, 1);
        min = Math.min(min, -Math.min(negCap, snappedMag));
      } else {
        const posCap = compressed ? cfg.linThresh : cfg.trigger;
        const snappedPos = this._ddSnapOutward(rawVal, axis, 1);
        max = Math.max(max, Math.min(posCap, snappedPos));
      }
      return [min, max];
    },

    _ddResolveScatterAutoBounds(wrap, key, raw, hasY = true) {
      const snappedXMin = this._ddSnapOutward(Math.min(-0.35, raw.xMin - Math.max(0.05, Math.abs(raw.xMin) * 0.08)), 'x', -1);
      let xMin = raw.xMin >= -1.0 ? Math.max(-1.0, snappedXMin) : snappedXMin;
      let xMax = this._ddSnapOutward(Math.max(0.40, raw.xMax + Math.max(0.06, Math.abs(raw.xMax) * 0.08)), 'x', 1);
      [xMin, xMax] = this._ddSoftCenterAxisBounds(xMin, xMax, 'x');
      let yMin = hasY ? this._ddSnapOutward(Math.min(-0.08, raw.yMin - Math.max(0.016, Math.abs(raw.yMin) * 0.14)), 'y', -1) : -1;
      let yMax = hasY ? this._ddSnapOutward(Math.max(0.08, raw.yMax + Math.max(0.016, Math.abs(raw.yMax) * 0.14)), 'y', 1) : 1;
      if (hasY) [yMin, yMax] = this._ddSoftCenterAxisBounds(yMin, yMax, 'y');

      if (wrap && wrap._ddAutoBoundsKey === key && wrap._ddAutoBounds) {
        const prev = wrap._ddAutoBounds;
        if (raw.xMin >= prev.xMin + 0.02 && xMin > prev.xMin && Math.abs(xMin) >= Math.abs(prev.xMin) * 0.55) xMin = prev.xMin;
        if (raw.xMax <= prev.xMax - 0.02 && xMax < prev.xMax && Math.abs(xMax) >= Math.abs(prev.xMax) * 0.55) xMax = prev.xMax;
        if (hasY) {
          if (raw.yMin >= prev.yMin + 0.008 && yMin > prev.yMin && Math.abs(yMin) >= Math.abs(prev.yMin) * 0.55) yMin = prev.yMin;
          if (raw.yMax <= prev.yMax - 0.008 && yMax < prev.yMax && Math.abs(yMax) >= Math.abs(prev.yMax) * 0.55) yMax = prev.yMax;
        }
      }
      const bounds = hasY ? { xMin, xMax, yMin, yMax } : { xMin, xMax };
      if (wrap) {
        wrap._ddAutoBoundsKey = key;
        wrap._ddAutoBounds = bounds;
      }
      return bounds;
    },

    _ddFormatTickPct(v, decimals = 0) {
      const pct = v * 100;
      if (Math.abs(pct) < 1e-6) return '0%';
      if (decimals <= 0) {
        const rounded = Math.round(pct);
        return rounded === 0 ? '0%' : (rounded > 0 ? '+' : '') + rounded + '%';
      }
      const fixed = pct.toFixed(decimals).replace(/\.?0+$/, '');
      if (fixed === '0' || fixed === '-0') return '0%';
      return (pct > 0 ? '+' : '') + fixed + '%';
    },

    _ddPickScatterTicks(min, max, compressed, linThresh, axis, toPx, minPx, maxPx, avoidPx, minGap, plotSpanPx, skipValues = []) {
      const kept = [];
      const tryAdd = (v, label, isComp = false, isBoundary = false) => {
        if (skipValues.some(s => Math.abs(v - s) < 1e-3)) return;
        if (Math.abs(v) < 1e-9 && avoidPx != null) return;
        const px = toPx(v);
        if (!Number.isFinite(px) || px < minPx || px > maxPx) return;
        if (avoidPx != null && Math.abs(px - avoidPx) < minGap) return;
        if (kept.some(item => Math.abs(item.px - px) < minGap)) return;
        kept.push({ v, px, label, compressed: isComp, boundary: isBoundary });
      };

      if (!compressed) {
        const span = Math.max(1e-4, max - min);
        const maxCount = Math.max(4, Math.min(8, Math.floor((plotSpanPx || 400) / (axis === 'x' ? 92 : 56))));
        const steps = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.10, 0.20, 0.25, 0.50, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0];
        const step = steps.find(s => span / s <= maxCount) || Math.pow(10, Math.ceil(Math.log10(span / Math.max(2, maxCount - 1))));
        const decimals = step < 0.001 ? 2 : (step < 0.01 ? 1 : 0);
        const start = Math.ceil((min + 1e-9) / step) * step;
        for (let raw = start; raw <= max - 1e-9; raw += step) {
          const v = Math.abs(raw) < 1e-9 ? 0 : Math.round(raw * 1e6) / 1e6;
          tryAdd(v, this._ddFormatTickPct(v, decimals), false, false);
        }
      } else {
        const coreMin = Math.max(min, -linThresh);
        const coreMax = Math.min(max, linThresh);
        if (coreMax > coreMin + 1e-6) {
          const corePxSpan = Math.abs(toPx(coreMax) - toPx(coreMin));
          const maxCore = Math.max(2, Math.floor(corePxSpan / (axis === 'x' ? 76 : 44)));
          const coreSteps = axis === 'x' ? [0.20, 0.25, 0.50, 1.0] : [0.04, 0.05, 0.10, 0.20];
          const step = coreSteps.find(s => (coreMax - coreMin) / s <= maxCore) || linThresh;
          if (max > linThresh + 1e-6) tryAdd(linThresh, this._ddFormatTickPct(linThresh, 0), false, true);
          if (min < -linThresh - 1e-6) tryAdd(-linThresh, this._ddFormatTickPct(-linThresh, 0), false, true);
          const start = Math.ceil((coreMin + 1e-9) / step) * step;
          for (let raw = start; raw <= coreMax - 1e-9; raw += step) {
            const v = Math.abs(raw) < 1e-9 ? 0 : Math.round(raw * 1e6) / 1e6;
            if (Math.abs(Math.abs(v) - linThresh) < 1e-6) continue;
            tryAdd(v, this._ddFormatTickPct(v, 0), false, false);
          }
        }
        const tailMags = axis === 'x' ? [2, 5, 10, 20, 50, 100] : [0.5, 1, 2, 5, 10];
        for (const m of tailMags) {
          if (m > linThresh + 1e-6 && m < max - 1e-6) tryAdd(m, this._ddFormatTickPct(m, 0), true, false);
          if (-m < -linThresh - 1e-6 && -m > min + 1e-6) tryAdd(-m, this._ddFormatTickPct(-m, 0), true, false);
        }
      }
      return kept.sort((a, b) => a.v - b.v);
    },

    _ddComputeScatterAxisLayout(axisX, axisY, xZero, yZero, padL, padT, plotW, plotH, hasZoom) {
      const xDockedLeft = xZero < padL + 12;
      const xDockedRight = xZero > padL + plotW - 12;
      const yDockedTop = yZero < padT + 12;
      const yDockedBottom = yZero > padT + plotH - 12;
      const showOriginZero = !xDockedLeft && !xDockedRight && !yDockedTop && !yDockedBottom;
      const yTicksRight = xDockedLeft || axisX < padL + 44;
      const yTickX = yTicksRight ? 7 : -7;
      const yTickAnchor = yTicksRight ? 'start' : 'end';
      const xTicksAbove = yDockedBottom || axisY > padT + plotH - 24;
      const xTickY = xTicksAbove ? -7 : 13;
      const xDirY = xTicksAbove ? -20 : (axisY >= padT + 18 ? -6 : 25);
      const yDirOnLeft = !yTicksRight && axisX > padL + plotW - 110;
      const yDirX = yDirOnLeft ? -7 : 7;
      const yDirAnchor = yDirOnLeft ? 'end' : 'start';
      const originX = axisX < padL + 30 ? 6 : -6;
      const originAnchor = axisX < padL + 30 ? 'start' : 'end';
      const originY = xTicksAbove ? -6 : 13;
      const xTickMinPx = yTicksRight ? padL + 46 : padL + 18;
      const xTickMaxPx = (!yTicksRight && xDockedRight) ? padL + plotW - 46 : padL + plotW - 18;
      const yTickMinPx = ((!hasZoom && plotH > 140) || (!xTicksAbove && yDockedTop)) ? padT + 22 : padT + 18;
      const yTickMaxPx = ((!hasZoom && plotH > 140) || xTicksAbove) ? padT + plotH - 22 : padT + plotH - 16;
      return {
        xDockedLeft, xDockedRight, yDockedTop, yDockedBottom, showOriginZero,
        yTicksRight, yTickX, yTickAnchor, xTicksAbove, xTickY, xDirY,
        yDirOnLeft, yDirX, yDirAnchor, originX, originAnchor, originY,
        xTickMinPx, xTickMaxPx, yTickMinPx, yTickMaxPx,
      };
    },

    _ddComputeCompressedBandSpecs(padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, symWX, symWY, toX, toY, layout, linX, linY, hasY = true, attShow = false) {
      const specs = { xPos: null, xNeg: null, yPos: null, yNeg: null };
      if (symWX > 0.01) {
        const op = symWX < 0.99 ? symWX.toFixed(2) : '';
        if (xMax > linX + 1e-6) {
          const bx = Math.max(padL, Math.min(padL + plotW, toX(linX)));
          const bw = Math.max(0, padL + plotW - bx);
          if (bw > 2) {
            const fitsBesideAlert = bw > 148 || !attShow;
            specs.xPos = {
              rx: bx, ry: padT, rw: bw, rh: plotH,
              lx1: bx, lx2: bx, ly1: padT, ly2: padT + plotH,
              showLabel: bw > 48 && fitsBesideAlert,
              tx: bx + 4, ty: padT + 11, anchor: 'start', op,
            };
          }
        }
        if (xMin < -linX - 1e-6) {
          const bx = Math.max(padL, Math.min(padL + plotW, toX(-linX)));
          const bw = Math.max(0, bx - padL);
          if (bw > 2) {
            specs.xNeg = {
              rx: padL, ry: padT, rw: bw, rh: plotH,
              lx1: bx, lx2: bx, ly1: padT, ly2: padT + plotH,
              showLabel: bw > 54,
              tx: bx - 4, ty: padT + 11, anchor: 'end', op,
            };
          }
        }
      }
      if (hasY && symWY > 0.01 && typeof toY === 'function') {
        const op = symWY < 0.99 ? symWY.toFixed(2) : '';
        const yLabelX = layout?.yTicksRight ? padL + 52 : padL + 4;
        if (yMax > linY + 1e-6) {
          const by = Math.max(padT, Math.min(padT + plotH, toY(linY)));
          const bh = Math.max(0, by - padT);
          if (bh > 2) {
            specs.yPos = {
              rx: padL, ry: padT, rw: plotW, rh: bh,
              lx1: padL, lx2: padL + plotW, ly1: by, ly2: by,
              showLabel: bh > 18,
              tx: yLabelX, ty: padT + 11, anchor: 'start', op,
            };
          }
        }
        if (yMin < -linY - 1e-6) {
          const by = Math.max(padT, Math.min(padT + plotH, toY(-linY)));
          const bh = Math.max(0, padT + plotH - by);
          if (bh > 2) {
            specs.yNeg = {
              rx: padL, ry: by, rw: plotW, rh: bh,
              lx1: padL, lx2: padL + plotW, ly1: by, ly2: by,
              showLabel: bh > 18,
              tx: yLabelX, ty: by + 11, anchor: 'start', op,
            };
          }
        }
      }
      return specs;
    },

    _ddCompressedBandsHtml(t, padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, symWX, symWY, toX, toY, layout, linX, linY, hasY = true, attShow = false) {
      const specs = this._ddComputeCompressedBandSpecs(
        padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, symWX, symWY, toX, toY, layout, linX, linY, hasY, attShow
      );
      const logLabel = this.esc(t('ddAxisLogZone'));
      const parts = [];
      for (const slot of ['xPos', 'xNeg', 'yPos', 'yNeg']) {
        const s = specs[slot];
        if (!s) continue;
        const opAttr = s.op ? ` opacity="${s.op}"` : '';
        parts.push(`<rect class="m-dd-compressed-band" x="${s.rx.toFixed(1)}" y="${s.ry}" width="${s.rw.toFixed(1)}" height="${s.rh.toFixed(1)}"${opAttr}/>`
          + `<line class="m-dd-compressed-sep" x1="${s.lx1.toFixed(1)}" x2="${s.lx2.toFixed(1)}" y1="${s.ly1.toFixed(1)}" y2="${s.ly2.toFixed(1)}"${opAttr}/>`);
        if (s.showLabel) {
          parts.push(`<text class="m-dd-compressed-label m-dd-text-halo" x="${s.tx.toFixed(1)}" y="${s.ty.toFixed(1)}" text-anchor="${s.anchor}"${opAttr}>${logLabel}</text>`);
        }
      }
      return parts.join('');
    },

    _ddEnsureBandSlots(bandsGroup, t) {
      if (!bandsGroup || typeof globalThis.document?.createElementNS !== 'function') return null;
      const ns = 'http://www.w3.org/2000/svg';
      const slots = {};
      const names = ['xPos', 'xNeg', 'yPos', 'yNeg'];
      let ready = true;
      for (const name of names) {
        const g = bandsGroup.querySelector?.(`[data-dd-band-slot="${name}"]`);
        if (!g) { ready = false; break; }
        slots[name] = {
          g,
          rect: g.querySelector('rect'),
          line: g.querySelector('line'),
          text: g.querySelector('text'),
        };
      }
      if (!ready) {
        bandsGroup.innerHTML = '';
        const logLabel = t('ddAxisLogZone');
        for (const name of names) {
          const g = globalThis.document.createElementNS(ns, 'g');
          g.setAttribute('data-dd-band-slot', name);
          g.setAttribute('display', 'none');
          const rect = globalThis.document.createElementNS(ns, 'rect');
          rect.setAttribute('class', 'm-dd-compressed-band');
          const line = globalThis.document.createElementNS(ns, 'line');
          line.setAttribute('class', 'm-dd-compressed-sep');
          const text = globalThis.document.createElementNS(ns, 'text');
          text.setAttribute('class', 'm-dd-compressed-label m-dd-text-halo');
          text.textContent = logLabel;
          g.appendChild(rect);
          g.appendChild(line);
          g.appendChild(text);
          bandsGroup.appendChild(g);
          slots[name] = { g, rect, line, text };
        }
      }
      return slots;
    },

    _ddPatchBandSlots(bandSlots, padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, symWX, symWY, toX, toY, layout, linX, linY, hasY, attShow) {
      if (!bandSlots) return;
      const specs = this._ddComputeCompressedBandSpecs(
        padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, symWX, symWY, toX, toY, layout, linX, linY, hasY, attShow
      );
      for (const name of ['xPos', 'xNeg', 'yPos', 'yNeg']) {
        const node = bandSlots[name];
        const s = specs[name];
        if (!node) continue;
        if (!s) {
          node.g.setAttribute('display', 'none');
          continue;
        }
        node.g.removeAttribute('display');
        if (s.op) node.g.setAttribute('opacity', s.op);
        else node.g.removeAttribute('opacity');
        node.rect.setAttribute('x', s.rx.toFixed(1));
        node.rect.setAttribute('y', s.ry.toFixed(1));
        node.rect.setAttribute('width', s.rw.toFixed(1));
        node.rect.setAttribute('height', s.rh.toFixed(1));
        node.line.setAttribute('x1', s.lx1.toFixed(1));
        node.line.setAttribute('x2', s.lx2.toFixed(1));
        node.line.setAttribute('y1', s.ly1.toFixed(1));
        node.line.setAttribute('y2', s.ly2.toFixed(1));
        if (s.showLabel) {
          node.text.removeAttribute('display');
          node.text.setAttribute('x', s.tx.toFixed(1));
          node.text.setAttribute('y', s.ty.toFixed(1));
          node.text.setAttribute('text-anchor', s.anchor);
        } else {
          node.text.setAttribute('display', 'none');
        }
      }
    },

    _ddStopScatterCameraAnim(wrap, svg) {
      const rafId = wrap?._ddZoomAnimRaf;
      if (rafId && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(rafId);
      }
      if (wrap) {
        wrap._ddZoomAnimRaf = 0;
        if (!wrap._ddDotChoreoRaf && !wrap._ddPan?.active) wrap._ddAnimGeom = null;
      }
      svg?.classList?.remove?.('is-camera-anim');
      let cam = null;
      if (typeof wrap?._ddCurrentCamEval === 'function') {
        try { cam = wrap._ddCurrentCamEval(); } catch (_) {}
        wrap._ddCurrentCamEval = null;
      }
      if (cam && wrap) wrap._ddCurrentCamera = cam;
      return cam || wrap?._ddCurrentCamera || wrap?._ddCamera || null;
    },

    _ddStartScatterCameraAnim(svg, wrap, spec) {
      const {
        kind, padL, padT, plotW, plotH, hasZoom, t,
        highResVal, convSlopeVal, linX, linY, animX, animY,
        xTicks, yTicks, xDirHtml, yDirHtml, targetLabelsHtml,
        commitFinal,
      } = spec;
      const cameraMode = spec.cameraMode || '';
      const durationMs = Number(spec.durationMs) > 0 ? Number(spec.durationMs) : 240;
      const nowFn = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());
      const token = (wrap._ddZoomAnimToken = (wrap._ddZoomAnimToken || 0) + 1);
      svg.classList?.remove?.('is-live-motion');
      svg.classList?.add?.('is-camera-anim');

      const dotsGroup = svg.querySelector?.('.m-dd-dots');
      const gridGroup = svg.querySelector?.('[data-dd-grid-lines]');
      const bandsGroup = svg.querySelector?.('[data-dd-compressed-bands]');
      const zonesGroup = svg.querySelector?.('[data-dd-zones]');
      const axisXGroup = svg.querySelector?.('[data-dd-axis-x-group]');
      const axisYGroup = svg.querySelector?.('[data-dd-axis-y-group]');
      const axisXTicks = svg.querySelector?.('[data-dd-axis-x-ticks]');
      const axisYTicks = svg.querySelector?.('[data-dd-axis-y-ticks]');
      const axesGroup = svg.querySelector?.('.m-chart-axes');
      const axisOrigin = svg.querySelector?.('[data-dd-axis-origin]');
      const labelsGroup = svg.querySelector?.('.m-dd-quad-labels');
      const pop = wrap.querySelector?.('[data-dd-preview-pop]');

      // Pre-cache DOM geometry and fixed band slots once before rAF starts.
      wrap._ddAnimGeom = this._ddCaptureAnimGeom(svg, pop);
      const bandSlots = this._ddEnsureBandSlots(bandsGroup, t);

      const dotMap = new Map();
      const ringMap = new Map();
      if (dotsGroup) {
        for (const child of Array.from(dotsGroup.children || [])) {
          const id = child.dataset?.ddImageId;
          if (!id) continue;
          if (child.classList?.contains?.('m-dd-dot')) dotMap.set(id, child);
          else if (child.classList?.contains?.('m-dd-dot-nan-ring')) ringMap.set(id, child);
        }
      }
      const dotBindings = spec.coords.map(d => ({
        x: d.mean_residual,
        y: d.slope,
        prevCy: d.prevCy,
        nextCy: d.cy,
        dotEl: dotMap.get(d.image_id) || null,
        ringEl: ringMap.get(d.image_id) || null,
      })).filter(b => b.dotEl || b.ringEl);

      if (gridGroup) {
        const gLines = [
          ...xTicks.filter(tk => !tk.boundary).map((tk, i) =>
            `<line data-dd-ag="x" data-dd-ai="${i}"${tk.compressed ? ' class="is-compressed"' : ''} x1="${tk.px.toFixed(1)}" x2="${tk.px.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>`),
          ...yTicks.filter(tk => !tk.boundary).map((tk, i) =>
            `<line data-dd-ag="y" data-dd-ai="${i}"${tk.compressed ? ' class="is-compressed"' : ''} x1="${padL}" x2="${padL + plotW}" y1="${tk.px.toFixed(1)}" y2="${tk.px.toFixed(1)}"/>`),
        ].join('');
        gridGroup.innerHTML = gLines;
      }
      const xGridNodes = [];
      const yGridNodes = [];
      if (gridGroup) {
        const xGridSrc = xTicks.filter(tk => !tk.boundary);
        const yGridSrc = yTicks.filter(tk => !tk.boundary);
        for (const el of Array.from(gridGroup.children || [])) {
          const gType = el.getAttribute?.('data-dd-ag');
          const idx = Number(el.getAttribute?.('data-dd-ai'));
          if (gType === 'x' && xGridSrc[idx]) xGridNodes.push({ el, v: xGridSrc[idx].v });
          else if (gType === 'y' && yGridSrc[idx]) yGridNodes.push({ el, v: yGridSrc[idx].v });
        }
      }

      const xTickY0 = padT + 13;
      if (kind === 'quadrant' && axisXTicks) {
        axisXTicks.innerHTML = xTicks.map((tk, i) =>
          `<line class="m-dd-axis-tick" data-dd-at="xl" data-dd-ai="${i}" x1="${tk.px.toFixed(1)}" x2="${tk.px.toFixed(1)}" y1="-3" y2="3"/>`
          + `<text data-dd-at="xt" data-dd-ai="${i}" x="${tk.px.toFixed(1)}" y="${xTickY0}" text-anchor="middle">${this.esc(tk.label)}</text>`
        ).join('') + (xDirHtml || '');
      } else if (kind === 'early' && axesGroup) {
        axesGroup.innerHTML = xTicks.map((tk, i) =>
          `<text data-dd-at="xt" data-dd-ai="${i}" x="${tk.px.toFixed(1)}" y="${spec.earlyTickY}" text-anchor="middle">${this.esc(tk.label)}</text>`
        ).join('') + (xDirHtml || '');
      }
      if (kind === 'quadrant' && axisYTicks) {
        axisYTicks.innerHTML = yTicks.map((tk, i) =>
          `<line class="m-dd-axis-tick" data-dd-at="yl" data-dd-ai="${i}" x1="-3" x2="3" y1="${tk.px.toFixed(1)}" y2="${tk.px.toFixed(1)}"/>`
          + `<text data-dd-at="yt" data-dd-ai="${i}" x="-7" y="${(tk.px + 3.5).toFixed(1)}" text-anchor="end">${this.esc(tk.label)}</text>`
        ).join('') + (yDirHtml || '');
      }

      const xTickNodes = xTicks.map(() => ({ line: null, text: null }));
      const xHost = kind === 'early' ? axesGroup : axisXTicks;
      if (xHost) {
        for (const el of Array.from(xHost.children || [])) {
          const at = el.getAttribute?.('data-dd-at');
          const idx = Number(el.getAttribute?.('data-dd-ai'));
          if (!Number.isInteger(idx) || !xTickNodes[idx]) continue;
          if (at === 'xl') xTickNodes[idx].line = el;
          else if (at === 'xt') xTickNodes[idx].text = el;
        }
      }
      const yTickNodes = yTicks.map(() => ({ line: null, text: null }));
      if (axisYTicks) {
        for (const el of Array.from(axisYTicks.children || [])) {
          const at = el.getAttribute?.('data-dd-at');
          const idx = Number(el.getAttribute?.('data-dd-ai'));
          if (!Number.isInteger(idx) || !yTickNodes[idx]) continue;
          if (at === 'yl') yTickNodes[idx].line = el;
          else if (at === 'yt') yTickNodes[idx].text = el;
        }
      }

      if (labelsGroup && targetLabelsHtml != null) labelsGroup.innerHTML = targetLabelsHtml;
      const threshHighEl = labelsGroup?.querySelector?.('[data-dd-thresh-label="high"]') || null;
      const threshConvEl = labelsGroup?.querySelector?.('[data-dd-thresh-label="conv"]') || null;
      const zoneAttEl = labelsGroup?.querySelector?.('[data-dd-zone-label="attention"]') || null;
      const zoneLrnEl = labelsGroup?.querySelector?.('[data-dd-zone-label="learning"]') || null;

      const pinnedId = wrap?._ddPinnedDot?.image_id || '';
      const pinnedSpec = pinnedId ? (spec.coords.find(c => c.image_id === pinnedId) || null) : null;
      const focusRing = svg.querySelector?.('[data-dd-dot-focus]');
      const ch = svg.querySelector?.('[data-dd-crosshair]');
      const chVx = ch?.querySelector?.('[data-dd-ch-x]') || null;
      const chHy = ch?.querySelector?.('[data-dd-ch-y]') || null;
      const tether = svg.querySelector?.('[data-dd-pin-tether]') || null;

      const applyFrame = (e, rawP) => {
        const fx = animX(e);
        const curToX = fx.toPx;
        const fy = animY ? animY(e) : null;
        const curToY = fy ? fy.toPx : null;
        wrap._ddCurrentCamEval = () => {
          const xc = fx.getCamera();
          const yc = fy ? fy.getCamera() : { min: -1, max: 1, symW: 0 };
          return {
            kind,
            xMin: xc.min, xMax: xc.max, symW_X: xc.symW,
            yMin: yc.min, yMax: yc.max, symW_Y: yc.symW,
          };
        };

        for (const b of dotBindings) {
          const cxStr = curToX(b.x).toFixed(1);
          const cyVal = curToY ? curToY(b.y) : (b.prevCy + (b.nextCy - b.prevCy) * e);
          const cyStr = cyVal.toFixed(1);
          if (b.dotEl) {
            b.dotEl.setAttribute('cx', cxStr);
            b.dotEl.setAttribute('cy', cyStr);
          }
          if (b.ringEl) {
            b.ringEl.setAttribute('cx', cxStr);
            b.ringEl.setAttribute('cy', cyStr);
          }
        }

        if (pinnedSpec) {
          const pCx = curToX(pinnedSpec.mean_residual);
          const pCy = curToY ? curToY(pinnedSpec.slope) : (pinnedSpec.prevCy + (pinnedSpec.cy - pinnedSpec.prevCy) * e);
          this._ddSyncScatterFocusVisuals?.(wrap, svg, pinnedSpec, pCx, pCy, { focusRing, ch, chVx, chHy });
          if (kind === 'quadrant' && !this._ddUpdateScatterTrajectoryInPlace(wrap, curToX, curToY)) {
            this._syncDatasetDiagScatterTrajectory?.(wrap, { toX: curToX, toY: curToY, skipDomScan: true });
          }
          wrap._ddPopDetached = true;
          if (wrap._ddPopHovered) wrap._ddPopRepositionPending = true;
          this._updateDatasetDiagPinTether?.(wrap, pCx, pCy, tether);
        }

        const curXZero = curToX(0);
        const curYZero = curToY ? curToY(0) : (padT + plotH * 0.5);
        const curAxisX = Math.max(padL, Math.min(padL + plotW, curXZero));
        const curAxisY = curToY ? Math.max(padT, Math.min(padT + plotH, curYZero)) : (padT + plotH * 0.5);
        const layout = this._ddComputeScatterAxisLayout(curAxisX, curAxisY, curXZero, curYZero, padL, padT, plotW, plotH, hasZoom);

        if (kind === 'quadrant' && axisXGroup) {
          axisXGroup.style.transform = `translateY(${curAxisY.toFixed(1)}px)`;
        }
        if (axisYGroup) {
          axisYGroup.style.transform = `translateX(${curAxisX.toFixed(1)}px)`;
        }
        if (axisOrigin) {
          const origY = kind === 'early' ? spec.earlyTickY : curAxisY;
          axisOrigin.style.transform = `translate(${curAxisX.toFixed(1)}px,${origY.toFixed(1)}px)`;
          const ax = Math.max(0, Math.min(1, (Math.min(curXZero - padL, padL + plotW - curXZero) - 2) / 14));
          const ay = kind === 'early' ? 1 : Math.max(0, Math.min(1, (Math.min(curYZero - padT, padT + plotH - curYZero) - 2) / 14));
          axisOrigin.style.opacity = (ax * ay).toFixed(2);
          const ot = axisOrigin.querySelector?.('text');
          if (ot && kind === 'quadrant') {
            ot.setAttribute('x', String(layout.originX));
            ot.setAttribute('y', String(layout.originY));
            ot.setAttribute('text-anchor', layout.originAnchor);
          }
        }

        const curXHigh = curToX(highResVal);
        const curAttX = Math.max(padL, Math.min(padL + plotW, curXHigh));
        const curAttW = Math.max(0, padL + plotW - curAttX);
        if (kind === 'quadrant') {
          const curYConv = curToY(convSlopeVal);
          const curThreshY = Math.max(padT, Math.min(padT + plotH, curYConv));
          const curAttH = Math.max(0, curThreshY - padT);
          const curLrnH = Math.max(0, padT + plotH - curThreshY);
          const attOk = curAttW > 4 && curAttH > 4;
          const lrnOk = curAttW > 4 && curLrnH > 4;
          this._ddReconcileZoneRect(zonesGroup, 'attention', curAttX, padT, curAttW, curAttH, attOk);
          this._ddReconcileZoneRect(zonesGroup, 'learning', curAttX, curThreshY, curAttW, curLrnH, lrnOk);
          if (threshHighEl) {
            const vis = curXHigh >= padL + 8 && curXHigh <= padL + plotW - 16;
            const hlx = curXHigh > padL + plotW - 44 ? curXHigh - 4 : curXHigh + 4;
            threshHighEl.setAttribute('x', hlx.toFixed(1));
            threshHighEl.setAttribute('text-anchor', curXHigh > padL + plotW - 44 ? 'end' : 'start');
            threshHighEl.style.opacity = vis ? '1' : '0';
          }
          if (threshConvEl) {
            const vis = curAttW > 28 && curYConv >= padT + 14 && curYConv <= padT + plotH - 8;
            const cly = Math.abs(curYConv - curAxisY) < 12 ? curYConv + 11 : curYConv - 4;
            threshConvEl.setAttribute('x', (curAttX + 4).toFixed(1));
            threshConvEl.setAttribute('y', cly.toFixed(1));
            threshConvEl.style.opacity = vis ? '1' : '0';
          }
          if (zoneAttEl) zoneAttEl.style.opacity = (curAttW > 54 && curAttH > 20) ? '1' : '0';
          if (zoneLrnEl) zoneLrnEl.style.opacity = (curAttW > 54 && curLrnH > 20) ? '1' : '0';
        } else {
          this._ddReconcileZoneRect(zonesGroup, 'attention', curAttX, padT, curAttW, plotH, curAttW > 4);
          if (threshHighEl) {
            const vis = curXHigh >= padL + 8 && curXHigh <= padL + plotW - 16;
            const hlx = curXHigh > padL + plotW - 44 ? curXHigh - 4 : curXHigh + 4;
            threshHighEl.setAttribute('x', hlx.toFixed(1));
            threshHighEl.setAttribute('text-anchor', curXHigh > padL + plotW - 44 ? 'end' : 'start');
            threshHighEl.style.opacity = vis ? '1' : '0';
          }
          if (zoneAttEl) zoneAttEl.style.opacity = curAttW > 54 ? '1' : '0';
        }

        if (bandsGroup) {
          if (fx.symW > 0.01 || (fy && fy.symW > 0.01)) {
            const curCamNow = wrap._ddCurrentCamEval();
            if (bandSlots) {
              this._ddPatchBandSlots(
                bandSlots, padL, padT, plotW, plotH,
                curCamNow.xMin, curCamNow.xMax, curCamNow.yMin, curCamNow.yMax,
                fx.symW, fy ? fy.symW : 0, curToX, curToY, layout, linX, linY,
                kind === 'quadrant', curAttW > 54
              );
            }
          } else if (bandSlots) {
            for (const name of ['xPos', 'xNeg', 'yPos', 'yNeg']) {
              bandSlots[name]?.g?.setAttribute?.('display', 'none');
            }
          }
        }

        const fadeAlpha = cameraMode === 'wheel'
          ? '1'
          : Math.min(1, Math.max(0.55, rawP * 2.2)).toFixed(2);
        xGridNodes.forEach(({ el, v }) => {
          const px = curToX(v);
          const vis = px >= padL + 1 && px <= padL + plotW - 1;
          el.style.display = vis ? '' : 'none';
          if (vis) {
            el.setAttribute('x1', px.toFixed(1));
            el.setAttribute('x2', px.toFixed(1));
            el.style.opacity = fadeAlpha;
          }
        });
        yGridNodes.forEach(({ el, v }) => {
          const px = curToY(v);
          const vis = px >= padT + 1 && px <= padT + plotH - 1;
          el.style.display = vis ? '' : 'none';
          if (vis) {
            el.setAttribute('y1', px.toFixed(1));
            el.setAttribute('y2', px.toFixed(1));
            el.style.opacity = fadeAlpha;
          }
        });
        xTicks.forEach((tk, i) => {
          const node = xTickNodes[i];
          if (!node) return;
          const px = curToX(tk.v);
          const vis = px >= layout.xTickMinPx && px <= layout.xTickMaxPx;
          if (node.line) {
            node.line.style.display = vis ? '' : 'none';
            if (vis) {
              node.line.setAttribute('x1', px.toFixed(1));
              node.line.setAttribute('x2', px.toFixed(1));
              node.line.style.opacity = fadeAlpha;
            }
          }
          if (node.text) {
            node.text.style.display = vis ? '' : 'none';
            if (vis) {
              node.text.setAttribute('x', px.toFixed(1));
              if (kind === 'quadrant') node.text.setAttribute('y', String(layout.xTickY));
              node.text.style.opacity = fadeAlpha;
            }
          }
        });
        yTicks.forEach((tk, i) => {
          const node = yTickNodes[i];
          if (!node) return;
          const px = curToY(tk.v);
          const vis = px >= layout.yTickMinPx && px <= layout.yTickMaxPx;
          if (node.line) {
            node.line.style.display = vis ? '' : 'none';
            if (vis) {
              node.line.setAttribute('y1', px.toFixed(1));
              node.line.setAttribute('y2', px.toFixed(1));
              node.line.style.opacity = fadeAlpha;
            }
          }
          if (node.text) {
            node.text.style.display = vis ? '' : 'none';
            if (vis) {
              node.text.setAttribute('x', String(layout.yTickX));
              node.text.setAttribute('y', (px + 3.5).toFixed(1));
              node.text.setAttribute('text-anchor', layout.yTickAnchor);
              node.text.style.opacity = fadeAlpha;
            }
          }
        });
      };

      const startTs = nowFn();
      applyFrame(0, 0);
      const tick = () => {
        if (wrap._ddZoomAnimToken !== token) return;
        const elapsed = Math.max(0, nowFn() - startTs);
        const rawP = Math.min(1, elapsed / durationMs);
        const eased = 1 - Math.pow(1 - rawP, 3);
        if (rawP >= 1) {
          wrap._ddZoomAnimRaf = 0;
          wrap._ddCurrentCamEval = null;
          wrap._ddAnimGeom = null;
          commitFinal();
          svg.classList?.remove?.('is-camera-anim');
          return;
        }
        applyFrame(eased, rawP);
        wrap._ddZoomAnimRaf = globalThis.requestAnimationFrame(tick);
      };
      const firstRaf = globalThis.requestAnimationFrame(tick);
      if (!firstRaf) {
        wrap._ddZoomAnimRaf = 0;
        wrap._ddCurrentCamEval = null;
        wrap._ddAnimGeom = null;
        commitFinal();
        svg.classList?.remove?.('is-camera-anim');
        return false;
      }
      wrap._ddZoomAnimRaf = firstRaf;
      return true;
    },

    _ddDotOrderWeight(status) {
      if (status === 'non_finite') return 4;
      if (status === 'attention') return 3;
      if (status === 'learning') return 2;
      if (status === 'easy') return 1;
      return 0;
    },

    _ddPlaceEarlyBeeswarm(points, toX, midY, maxDy) {
      const placed = [];
      const sorted = points.slice().sort((a, b) =>
        (a.mean_residual - b.mean_residual) || String(a.image_id).localeCompare(String(b.image_id))
      );
      const yMin = midY - maxDy;
      const yMax = midY + maxDy;
      const pad = 1.6;
      const maxR = 5.2;
      let winStart = 0;
      const collidesNear = (near, cx, cy, r) => {
        for (let j = 0; j < near.length; j++) {
          const p = near[j];
          const minD = r + p.r + pad;
          const dx = cx - p.cx;
          const dy = cy - p.cy;
          if (dx * dx + dy * dy < minD * minD) return true;
        }
        return false;
      };
      for (let i = 0; i < sorted.length; i++) {
        const img = sorted[i];
        const cx = toX(img.mean_residual);
        const r = this._ddScatterDotSpec ? this._ddScatterDotSpec(img.status).r : 4.0;
        while (winStart < placed.length && (cx - placed[winStart].cx) >= r + maxR + pad) {
          winStart++;
        }
        const near = [];
        for (let j = winStart; j < placed.length; j++) {
          const p = placed[j];
          if ((cx - p.cx) < r + p.r + pad) near.push(p);
        }
        let cy = midY;
        if (collidesNear(near, cx, cy, r)) {
          const seed = parseInt(String(img.image_id || '0').slice(-4), 16) || i;
          const preferUp = (seed % 2) === 0;
          const cands = [];
          for (let j = 0; j < near.length; j++) {
            const p = near[j];
            const minD = r + p.r + pad + 0.25;
            const dx = cx - p.cx;
            const dy = Math.sqrt(Math.max(0, minD * minD - dx * dx));
            const top = p.cy - dy;
            const bot = p.cy + dy;
            if (top >= yMin && top <= yMax) cands.push(top);
            if (bot >= yMin && bot <= yMax) cands.push(bot);
          }
          cands.sort((a, b) => {
            const da = Math.abs(a - midY);
            const db = Math.abs(b - midY);
            if (Math.abs(da - db) > 1e-4) return da - db;
            return ((a < midY) === preferUp ? -1 : 1);
          });
          let bestCy = null;
          for (let k = 0; k < cands.length; k++) {
            if (!collidesNear(near, cx, cands[k], r)) {
              bestCy = cands[k];
              break;
            }
          }
          if (bestCy != null) {
            cy = bestCy;
          } else {
            const frac = ((seed % 97) / 96) * 2 - 1;
            cy = midY + frac * maxDy;
          }
        }
        placed.push({ ...img, cx, cy, r });
      }
      return placed;
    },

    _ddGetQuadrantPointSet(wrap, data, minCount) {
      const cache = wrap?._ddQuadPointCache;
      if (cache && cache.data === data && cache.minCount === minCount) return cache;
      const images = data.by_image || [];
      const points = images.filter(i => i.comparable_count >= minCount
        && Number.isFinite(i.mean_residual) && Number.isFinite(i.slope));
      if (!points.length) {
        const empty = { data, minCount, imagesCount: images.length, points, displayed: [], ordered: [] };
        if (wrap) wrap._ddQuadPointCache = empty;
        return empty;
      }
      let leftmost = points[0], rightmost = points[0], lowest = points[0], highest = points[0];
      for (const point of points) {
        if (point.mean_residual < leftmost.mean_residual) leftmost = point;
        if (point.mean_residual > rightmost.mean_residual) rightmost = point;
        if (point.slope < lowest.slope) lowest = point;
        if (point.slope > highest.slope) highest = point;
      }
      const displayed = this._ddRepresentativePoints(points, 1000, [leftmost, rightmost, lowest, highest]);
      const ordered = displayed.slice().sort((a, b) => this._ddDotOrderWeight(a.status) - this._ddDotOrderWeight(b.status));
      const next = { data, minCount, imagesCount: images.length, points, displayed, ordered, leftmost, rightmost, lowest, highest };
      if (wrap) wrap._ddQuadPointCache = next;
      return next;
    },

    _ddGetEarlyPointSet(wrap, data) {
      const cache = wrap?._ddEarlyPointCache;
      if (cache && cache.data === data) return cache;
      const images = data.by_image || [];
      const points = images.filter(i => Number.isFinite(i.mean_residual));
      if (!points.length) {
        const empty = { data, imagesCount: images.length, points, displayed: [] };
        if (wrap) wrap._ddEarlyPointCache = empty;
        return empty;
      }
      let leftmost = points[0], rightmost = points[0];
      for (const point of points) {
        if (point.mean_residual < leftmost.mean_residual) leftmost = point;
        if (point.mean_residual > rightmost.mean_residual) rightmost = point;
      }
      const displayed = this._ddRepresentativePoints(points, 400, [leftmost, rightmost]);
      const next = { data, imagesCount: images.length, points, displayed, leftmost, rightmost };
      if (wrap) wrap._ddEarlyPointCache = next;
      return next;
    },

    _renderDatasetDiagQuadrantSvg(wrap, svg, data, width, t, options = {}) {
      const measuredH = Math.round(options.stageHeight || wrap?.querySelector?.('[data-dd-hero-stage]')?.clientHeight || 0);
      let height = measuredH > 100 ? Math.max(360, Math.min(720, measuredH - 4)) : 440;
      const prevSvgH = Number(svg.getAttribute?.('data-dd-svg-height') || 0);
      if (options.animate && prevSvgH >= 360 && Math.abs(prevSvgH - height) <= 6) {
        height = prevSvgH;
      }
      const padL = 12, padR = 12, padT = 8, padB = 10;
      const plotW = Math.max(120, width - padL - padR);
      const plotH = Math.max(72, height - padT - padB);
      const minCount = Number(data.thresholds?.min_count || 3);
      const ptSet = this._ddGetQuadrantPointSet(wrap, data, minCount);
      const { points, displayed, ordered, leftmost, rightmost, lowest, highest } = ptSet;

      const isPanFrame = Boolean(wrap?._ddPan?.active) && this._ddCanReconcileSvg(svg, 'quadrant', width, height, '.m-dd-dots');
      if (!isPanFrame) {
        const resetBtn = this._ddFindScatterResetBtn(wrap);
        if (resetBtn) {
          resetBtn.hidden = !this.datasetDiagScatterZoom;
          this._ddSyncDashActionsVisibility(resetBtn.closest?.('[data-dd-dash-actions]'));
        }
      }
      const stageEl = wrap?.querySelector?.('[data-dd-hero-stage]');
      if (!points.length) {
        stageEl?.classList?.toggle?.('is-zoomed', false);
        this._ddSetChartCoverage(wrap, t, 0, 0, ptSet.imagesCount);
        svg.removeAttribute?.('data-dd-svg-kind');
        svg.removeAttribute?.('data-dd-svg-width');
        svg.removeAttribute?.('data-dd-svg-height');
        svg.removeAttribute?.('data-dd-svg-zoom');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(height));
        svg.innerHTML = `<text class="is-sans" x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--text-tertiary)" font-size="12">${this.esc(t('ddNoQuadrantPoints'))}</text>`;
        if (wrap) {
          wrap._ddPrevDotCoords = null;
          wrap._ddLastBoundsSig = '';
          wrap._ddCamera = null;
          wrap._ddCurrentCamera = null;
          wrap._ddTargetCamera = null;
        }
        wrap._ddChartState = null;
        return;
      }

      if (!isPanFrame) {
        this._ddSetChartCoverage(wrap, t, displayed.length, points.length, ptSet.imagesCount);
      }
      const autoBounds = this._ddResolveScatterAutoBounds(
        wrap,
        `q|${data.run_id || ''}|${minCount}`,
        {
          xMin: leftmost.mean_residual,
          xMax: rightmost.mean_residual,
          yMin: lowest.slope,
          yMax: highest.slope,
        },
        true
      );
      const z = this.datasetDiagScatterZoom;
      const hasZoom = !!(z && Number.isFinite(z.xMin) && Number.isFinite(z.xMax)
        && Number.isFinite(z.yMin) && Number.isFinite(z.yMax)
        && (z.xMax - z.xMin) >= 0.0005 && (z.yMax - z.yMin) >= 0.0002);
      if (!isPanFrame) stageEl?.classList?.toggle?.('is-zoomed', hasZoom);
      const xMin = hasZoom ? z.xMin : autoBounds.xMin;
      const xMax = hasZoom ? z.xMax : autoBounds.xMax;
      const yMin = hasZoom ? z.yMin : autoBounds.yMin;
      const yMax = hasZoom ? z.yMax : autoBounds.yMax;
      const xCfg = this._ddScatterAxisConfig('x');
      const yCfg = this._ddScatterAxisConfig('y');
      const xCompressed = !hasZoom && (xMax > xCfg.trigger || xMin < -xCfg.trigger);
      const yCompressed = !hasZoom && (yMax > yCfg.trigger || yMin < -yCfg.trigger);
      const symWX = xCompressed ? 1 : 0;
      const symWY = yCompressed ? 1 : 0;
      const zoomSig = hasZoom
        ? [xMin.toFixed(5), xMax.toFixed(5), yMin.toFixed(5), yMax.toFixed(5)].join(':')
        : '';
      const boundsSig = `q|${hasZoom ? 'z' : 'a'}|${symWX}${symWY}|${xMin.toFixed(5)}|${xMax.toFixed(5)}|${yMin.toFixed(5)}|${yMax.toFixed(5)}`;
      const scaleChanged = !!(wrap?._ddLastBoundsSig && wrap._ddLastBoundsSig !== boundsSig);
      if (wrap) wrap._ddLastBoundsSig = boundsSig;

      const { toPx: toX, fromPx: fromX } = this._ddBuildAxisScale(xMin, xMax, xCfg.linThresh, xCfg.k, symWX, padL, plotW, false);
      const { toPx: toY, fromPx: fromY } = this._ddBuildAxisScale(yMin, yMax, yCfg.linThresh, yCfg.k, symWY, padT, plotH, true);

      const xZero = toX(0);
      const yZero = toY(0);
      const axisX = Math.max(padL, Math.min(padL + plotW, xZero));
      const axisY = Math.max(padT, Math.min(padT + plotH, yZero));
      const layout = this._ddComputeScatterAxisLayout(axisX, axisY, xZero, yZero, padL, padT, plotW, plotH, hasZoom);

      const highResVal = data.thresholds?.high_residual ?? 0.20;
      const convSlopeVal = data.thresholds?.converging_slope ?? -0.02;
      const xHigh = toX(highResVal);
      const yConv = toY(convSlopeVal);

      const coords = ordered.map(img => {
        const cx = toX(img.mean_residual);
        const cy = toY(img.slope);
        const spec = this._ddScatterDotSpec(img.status);
        const fill = this._ddStatusDotColor(img.status);
        return { ...img, cx, cy, r: spec.r, fill, cls: spec.cls };
      });

      const attX = Math.max(padL, Math.min(padL + plotW, xHigh));
      const attW = Math.max(0, padL + plotW - attX);
      const attY = padT;
      const attH = Math.max(0, Math.min(padT + plotH, yConv) - padT);
      const attShow = attW > 4 && attH > 4;

      const lrnX = attX;
      const lrnW = attW;
      const lrnY = Math.max(padT, Math.min(padT + plotH, yConv));
      const lrnH = Math.max(0, padT + plotH - lrnY);
      const lrnShow = lrnW > 4 && lrnH > 4;

      const zones = [];
      if (attShow) zones.push({ preset: 'attention', x1: attX, x2: padL + plotW, y1: attY, y2: attY + attH });
      if (lrnShow) zones.push({ preset: 'learning', x1: lrnX, x2: padL + plotW, y1: lrnY, y2: padT + plotH });

      const xTicks = this._ddPickScatterTicks(
        xMin, xMax, xCompressed, xCfg.linThresh, 'x', toX,
        layout.xTickMinPx, layout.xTickMaxPx, layout.showOriginZero ? axisX : null, 42, plotW,
        []
      );
      const yTicks = this._ddPickScatterTicks(
        yMin, yMax, yCompressed, yCfg.linThresh, 'y', toY,
        layout.yTickMinPx, layout.yTickMaxPx, layout.showOriginZero ? axisY : null, 24, plotH,
        []
      );

      const xDirHtml = (!hasZoom && plotW > 220)
        ? `<text class="m-dd-axis-dir" x="${padL + 2}" y="${layout.xDirY}" text-anchor="start">${this.esc(t('ddQuadAxisResEasy'))}</text>`
          + `<text class="m-dd-axis-dir" x="${padL + plotW - 2}" y="${layout.xDirY}" text-anchor="end">${this.esc(t('ddQuadAxisResHard'))}</text>`
        : '';
      const yDirHtml = (!hasZoom && plotH > 140)
        ? `<text class="m-dd-axis-dir" x="${layout.yDirX}" y="${padT + 11}" text-anchor="${layout.yDirAnchor}">${this.esc(t('ddQuadAxisSlopeUp'))}</text>`
          + `<text class="m-dd-axis-dir" x="${layout.yDirX}" y="${padT + plotH - 4}" text-anchor="${layout.yDirAnchor}">${this.esc(t('ddQuadAxisSlopeDown'))}</text>`
        : '';
      const targetCamera = { kind: 'quadrant', xMin, xMax, symW_X: symWX, yMin, yMax, symW_Y: symWY };

      // Fast camera-only pan path: reuse dot nodes & cached points, skip reconcile/pulses/trails/filter DOM walk.
      if (isPanFrame) {
        svg.setAttribute('data-dd-svg-zoom', zoomSig);
        const dotsGroup = svg.querySelector('.m-dd-dots');
        if (dotsGroup) {
          if (!wrap._ddPanDotCache || wrap._ddPanDotCache.group !== dotsGroup || wrap._ddPanDotCache.count !== coords.length) {
            const dotMap = new Map();
            const ringMap = new Map();
            for (const child of Array.from(dotsGroup.children || [])) {
              const id = child.dataset?.ddImageId;
              if (!id) continue;
              if (child.classList?.contains?.('m-dd-dot')) dotMap.set(id, child);
              else if (child.classList?.contains?.('m-dd-dot-nan-ring')) ringMap.set(id, child);
            }
            wrap._ddPanDotCache = { group: dotsGroup, count: coords.length, dotMap, ringMap };
          }
          const { dotMap, ringMap } = wrap._ddPanDotCache;
          for (const d of coords) {
            const cxStr = d.cx.toFixed(1);
            const cyStr = d.cy.toFixed(1);
            const dotEl = dotMap.get(d.image_id);
            if (dotEl) { dotEl.setAttribute('cx', cxStr); dotEl.setAttribute('cy', cyStr); }
            const ringEl = ringMap.get(d.image_id);
            if (ringEl) { ringEl.setAttribute('cx', cxStr); ringEl.setAttribute('cy', cyStr); }
          }
        }
        const gridGroup = svg.querySelector('[data-dd-grid-lines]');
        if (gridGroup) {
          gridGroup.innerHTML = [
            ...xTicks.filter(tk => !tk.boundary).map(tk => `<line${tk.compressed ? ' class="is-compressed"' : ''} x1="${tk.px.toFixed(1)}" x2="${tk.px.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>`),
            ...yTicks.filter(tk => !tk.boundary).map(tk => `<line${tk.compressed ? ' class="is-compressed"' : ''} x1="${padL}" x2="${padL + plotW}" y1="${tk.px.toFixed(1)}" y2="${tk.px.toFixed(1)}"/>`),
          ].join('');
        }
        const bandsGroup = svg.querySelector('[data-dd-compressed-bands]');
        if (bandsGroup && bandsGroup.innerHTML) bandsGroup.innerHTML = '';
        const zonesGroup = svg.querySelector('[data-dd-zones]');
        this._ddReconcileZoneRect(zonesGroup, 'attention', attX, attY, attW, attH, attShow);
        this._ddReconcileZoneRect(zonesGroup, 'learning', lrnX, lrnY, lrnW, lrnH, lrnShow);
        const axisXGroup = svg.querySelector('[data-dd-axis-x-group]');
        const axisYGroup = svg.querySelector('[data-dd-axis-y-group]');
        const axisXTicks = svg.querySelector('[data-dd-axis-x-ticks]');
        const axisYTicks = svg.querySelector('[data-dd-axis-y-ticks]');
        const axisOrigin = svg.querySelector('[data-dd-axis-origin]');
        if (axisXGroup) axisXGroup.style.transform = `translateY(${axisY.toFixed(1)}px)`;
        if (axisYGroup) axisYGroup.style.transform = `translateX(${axisX.toFixed(1)}px)`;
        if (axisXTicks) {
          axisXTicks.innerHTML = xTicks.map(tk =>
            `<line class="m-dd-axis-tick" x1="${tk.px.toFixed(1)}" x2="${tk.px.toFixed(1)}" y1="-3" y2="3"/>`
            + `<text x="${tk.px.toFixed(1)}" y="${layout.xTickY}" text-anchor="middle">${this.esc(tk.label)}</text>`
          ).join('');
        }
        if (axisYTicks) {
          axisYTicks.innerHTML = yTicks.map(tk =>
            `<line class="m-dd-axis-tick" x1="-3" x2="3" y1="${tk.px.toFixed(1)}" y2="${tk.px.toFixed(1)}"/>`
            + `<text x="${layout.yTickX}" y="${(tk.px + 3.5).toFixed(1)}" text-anchor="${layout.yTickAnchor}">${this.esc(tk.label)}</text>`
          ).join('');
        }
        if (axisOrigin) {
          axisOrigin.style.transform = `translate(${axisX.toFixed(1)}px,${axisY.toFixed(1)}px)`;
          axisOrigin.style.opacity = layout.showOriginZero ? '1' : '0';
          const ot = axisOrigin.querySelector?.('text');
          if (ot) {
            ot.setAttribute('x', String(layout.originX));
            ot.setAttribute('y', String(layout.originY));
            ot.setAttribute('text-anchor', layout.originAnchor);
          }
        }
        const labelsGroup = svg.querySelector('.m-dd-quad-labels');
        const yConvX1 = Math.max(padL, Math.min(padL + plotW, xHigh));
        const attCount = points.reduce((n, p) => n + (p.status === 'attention' ? 1 : 0), 0);
        const lrnCount = points.reduce((n, p) => n + (p.status === 'learning' ? 1 : 0), 0);
        const showHighTick = xHigh >= padL + 8 && xHigh <= padL + plotW - 16;
        const showConvTick = attW > 28 && yConv >= padT + 14 && yConv <= padT + plotH - 8;
        const highLabelX = xHigh > padL + plotW - 44 ? xHigh - 4 : xHigh + 4;
        const highLabelAnchor = xHigh > padL + plotW - 44 ? 'end' : 'start';
        const convLabelY = Math.abs(yConv - axisY) < 12 ? yConv + 11 : yConv - 4;
        if (labelsGroup) {
          labelsGroup.innerHTML = `
            ${showHighTick ? `<text class="m-dd-thresh-label m-dd-text-halo" data-dd-thresh-label="high" x="${highLabelX.toFixed(1)}" y="${padT + 11}" text-anchor="${highLabelAnchor}">+${Math.round(highResVal * 100)}%</text>` : ''}
            ${showConvTick ? `<text class="m-dd-thresh-label m-dd-text-halo" data-dd-thresh-label="conv" x="${(yConvX1 + 4).toFixed(1)}" y="${convLabelY.toFixed(1)}" text-anchor="start">${Math.round(convSlopeVal * 100)}%</text>` : ''}
            ${(attW > 54 && attH > 20) ? `<text class="is-alert m-dd-text-halo" data-dd-zone-label="attention" x="${(padL + plotW - 6).toFixed(1)}" y="${padT + 13}" text-anchor="end">${this.esc(t('ddQuadTopRight'))}${attCount ? ' · ' + attCount : ''}</text>` : ''}
            ${(lrnW > 54 && lrnH > 20) ? `<text class="is-learning m-dd-text-halo" data-dd-zone-label="learning" x="${(padL + plotW - 6).toFixed(1)}" y="${(padT + plotH - 6).toFixed(1)}" text-anchor="end">${this.esc(t('ddQuadBottomRight'))}${lrnCount ? ' · ' + lrnCount : ''}</text>` : ''}`;
        }
        wrap._ddCamera = targetCamera;
        wrap._ddCurrentCamera = targetCamera;
        wrap._ddTargetCamera = targetCamera;
        wrap._ddPrevDotCoords = new Map(coords.map(d => [d.image_id, { cx: d.cx, cy: d.cy }]));
        const prevChart = wrap._ddChartState;
        wrap._ddChartState = {
          kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, axisX, axisY,
          coords, zones, toX, toY, fromX, fromY,
          matchedIds: prevChart?.matchedIds || null, filterActive: !!prevChart?.filterActive,
        };
        if (wrap._ddPinnedDot?.image_id) {
          const nextDot = coords.find(pt => pt.image_id === wrap._ddPinnedDot.image_id);
          if (nextDot) {
            wrap._ddPinnedDot = nextDot;
            wrap._ddHoverDot = nextDot;
            wrap._ddActiveDot = nextDot;
            this._ddSyncActiveDotState(wrap);
            wrap._ddPopDetached = true;
            this._ddSyncScatterFocusVisuals(wrap, svg, nextDot);
            if (!this._ddUpdateScatterTrajectoryInPlace(wrap, toX, toY)) {
              this._syncDatasetDiagScatterTrajectory(wrap, { toX, toY, skipDomScan: true });
            }
            this._updateDatasetDiagPinTether(wrap, nextDot.cx, nextDot.cy);
          }
        }
        return;
      }

      const bandsHtml = this._ddCompressedBandsHtml(
        t, padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, symWX, symWY, toX, toY, layout, xCfg.linThresh, yCfg.linThresh, true, attShow
      );
      const gridLinesHtml = [
        ...xTicks.filter(tk => !tk.boundary).map(tk => `<line${tk.compressed ? ' class="is-compressed"' : ''} x1="${tk.px.toFixed(1)}" x2="${tk.px.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>`),
        ...yTicks.filter(tk => !tk.boundary).map(tk => `<line${tk.compressed ? ' class="is-compressed"' : ''} x1="${padL}" x2="${padL + plotW}" y1="${tk.px.toFixed(1)}" y2="${tk.px.toFixed(1)}"/>`),
      ].join('');

      const xAxisTicksHtml = xTicks.map(tk =>
        `<line class="m-dd-axis-tick" x1="${tk.px.toFixed(1)}" x2="${tk.px.toFixed(1)}" y1="-3" y2="3"/>`
        + `<text x="${tk.px.toFixed(1)}" y="${layout.xTickY}" text-anchor="middle">${this.esc(tk.label)}</text>`
      ).join('') + xDirHtml;
      const yAxisTicksHtml = yTicks.map(tk =>
        `<line class="m-dd-axis-tick" x1="-3" x2="3" y1="${tk.px.toFixed(1)}" y2="${tk.px.toFixed(1)}"/>`
        + `<text x="${layout.yTickX}" y="${(tk.px + 3.5).toFixed(1)}" text-anchor="${layout.yTickAnchor}">${this.esc(tk.label)}</text>`
      ).join('') + yDirHtml;

      const zonesHtml = `<rect class="m-dd-alert-zone m-dd-zone-hit" data-dd-zone-preset="attention" x="${attX.toFixed(1)}" y="${attY.toFixed(1)}" width="${(attShow ? attW : 0).toFixed(1)}" height="${(attShow ? attH : 0).toFixed(1)}"/>`
        + `<rect class="m-dd-learn-zone m-dd-zone-hit" data-dd-zone-preset="learning" x="${lrnX.toFixed(1)}" y="${lrnY.toFixed(1)}" width="${(lrnShow ? lrnW : 0).toFixed(1)}" height="${(lrnShow ? lrnH : 0).toFixed(1)}"/>`;

      const yConvX1 = Math.max(padL, Math.min(padL + plotW, xHigh));
      const attCount = points.reduce((n, p) => n + (p.status === 'attention' ? 1 : 0), 0);
      const lrnCount = points.reduce((n, p) => n + (p.status === 'learning' ? 1 : 0), 0);
      const showHighTick = xHigh >= padL + 8 && xHigh <= padL + plotW - 16;
      const showConvTick = attW > 28 && yConv >= padT + 14 && yConv <= padT + plotH - 8;
      const highLabelX = xHigh > padL + plotW - 44 ? xHigh - 4 : xHigh + 4;
      const highLabelAnchor = xHigh > padL + plotW - 44 ? 'end' : 'start';
      const convLabelY = Math.abs(yConv - axisY) < 12 ? yConv + 11 : yConv - 4;
      const topRightY = padT + 13;
      const quadLabelsHtml = `
        ${showHighTick ? `<text class="m-dd-thresh-label m-dd-text-halo" data-dd-thresh-label="high" x="${highLabelX.toFixed(1)}" y="${padT + 11}" text-anchor="${highLabelAnchor}">+${Math.round(highResVal * 100)}%</text>` : ''}
        ${showConvTick ? `<text class="m-dd-thresh-label m-dd-text-halo" data-dd-thresh-label="conv" x="${(yConvX1 + 4).toFixed(1)}" y="${convLabelY.toFixed(1)}" text-anchor="start">${Math.round(convSlopeVal * 100)}%</text>` : ''}
        ${(attW > 54 && attH > 20) ? `<text class="is-alert m-dd-text-halo" data-dd-zone-label="attention" x="${(padL + plotW - 6).toFixed(1)}" y="${topRightY}" text-anchor="end">${this.esc(t('ddQuadTopRight'))}${attCount ? ' · ' + attCount : ''}</text>` : ''}
        ${(lrnW > 54 && lrnH > 20) ? `<text class="is-learning m-dd-text-halo" data-dd-zone-label="learning" x="${(padL + plotW - 6).toFixed(1)}" y="${(padT + plotH - 6).toFixed(1)}" text-anchor="end">${this.esc(t('ddQuadBottomRight'))}${lrnCount ? ' · ' + lrnCount : ''}</text>` : ''}`;

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(height));

      const clipId = 'm-dd-clip-q-' + (this.selectedRunDir ? 'h' : 'l');
      const dotOpts = { ...options, scaleChanged };
      if (this._ddCanReconcileSvg(svg, 'quadrant', width, height, '.m-dd-dots')) {
        svg.setAttribute('data-dd-svg-zoom', zoomSig);
        svg.classList?.toggle?.('is-zones-on', !!this.datasetDiagShowZones);
        const gridGroup = svg.querySelector('[data-dd-grid-lines]');
        const bandsGroup = svg.querySelector('[data-dd-compressed-bands]');
        const zonesGroup = svg.querySelector('[data-dd-zones]');
        const axisXGroup = svg.querySelector('[data-dd-axis-x-group]');
        const axisYGroup = svg.querySelector('[data-dd-axis-y-group]');
        const axisXTicks = svg.querySelector('[data-dd-axis-x-ticks]');
        const axisYTicks = svg.querySelector('[data-dd-axis-y-ticks]');
        const axisOrigin = svg.querySelector('[data-dd-axis-origin]');
        const labelsGroup = svg.querySelector('.m-dd-quad-labels');

        const commitStatic = (skipDotAnim = false, refreshOpts = null) => {
          if (gridGroup) gridGroup.innerHTML = gridLinesHtml;
          if (bandsGroup) bandsGroup.innerHTML = bandsHtml;
          this._ddReconcileZoneRect(zonesGroup, 'attention', attX, attY, attW, attH, attShow);
          this._ddReconcileZoneRect(zonesGroup, 'learning', lrnX, lrnY, lrnW, lrnH, lrnShow);
          if (axisXGroup) axisXGroup.style.transform = `translateY(${axisY.toFixed(1)}px)`;
          if (axisYGroup) axisYGroup.style.transform = `translateX(${axisX.toFixed(1)}px)`;
          if (axisXTicks) axisXTicks.innerHTML = xAxisTicksHtml;
          if (axisYTicks) axisYTicks.innerHTML = yAxisTicksHtml;
          if (axisOrigin) {
            axisOrigin.style.transform = `translate(${axisX.toFixed(1)}px,${axisY.toFixed(1)}px)`;
            axisOrigin.style.opacity = layout.showOriginZero ? '1' : '0';
            const ot = axisOrigin.querySelector?.('text');
            if (ot) {
              ot.setAttribute('x', String(layout.originX));
              ot.setAttribute('y', String(layout.originY));
              ot.setAttribute('text-anchor', layout.originAnchor);
            }
          }
          if (labelsGroup) labelsGroup.innerHTML = quadLabelsHtml;
          this._ddReconcileScatterDots(svg, wrap, coords, skipDotAnim ? { ...dotOpts, animate: false } : dotOpts);
          if (wrap) {
            wrap._ddPanDotCache = null;
            wrap._ddCamera = targetCamera;
            wrap._ddCurrentCamera = targetCamera;
            wrap._ddTargetCamera = targetCamera;
          }
          wrap._ddChartState = { kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, axisX, axisY, coords, zones, toX, toY, fromX, fromY };
          this._syncDatasetDiagScatterFilter?.(wrap, { skipReorder: !!options.animate, skipPopReposition: true });
          const effectiveRefreshOpts = refreshOpts || (scaleChanged && !wrap?._ddPan?.active && wrap?._ddPinnedDot ? { settleAfterViewport: true } : undefined);
          this._refreshDatasetDiagActiveHover?.(wrap, effectiveRefreshOpts);
        };

        const prevCam = options.prevCamera;
        const canCameraRaf = scaleChanged
          && options.animate
          && prevCam
          && prevCam.kind === 'quadrant'
          && (!this._monitorMotionAllowed || this._monitorMotionAllowed())
          && typeof globalThis.requestAnimationFrame === 'function';

        if (canCameraRaf) {
          if (wrap) wrap._ddTargetCamera = targetCamera;
          const animX = this._ddMakeAxisAnimator(prevCam.xMin, prevCam.xMax, prevCam.symW_X, xMin, xMax, symWX, xCfg.linThresh, xCfg.k, padL, plotW, false);
          const animY = this._ddMakeAxisAnimator(prevCam.yMin, prevCam.yMax, prevCam.symW_Y, yMin, yMax, symWY, yCfg.linThresh, yCfg.k, padT, plotH, true);
          const fx0 = animX(0);
          const fy0 = animY(0);
          const startCoords = coords.map(d => ({ ...d, cx: fx0.toPx(d.mean_residual), cy: fy0.toPx(d.slope) }));
          this._ddReconcileScatterDots(svg, wrap, startCoords, dotOpts);
          wrap._ddChartState = { kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, axisX, axisY, coords, zones, toX, toY, fromX, fromY };
          this._syncDatasetDiagScatterFilter?.(wrap, { skipReorder: true, skipPopReposition: true });
          const animLabelsHtml = `
            <text class="m-dd-thresh-label m-dd-text-halo" data-dd-thresh-label="high" x="${highLabelX.toFixed(1)}" y="${padT + 11}" text-anchor="${highLabelAnchor}">+${Math.round(highResVal * 100)}%</text>
            <text class="m-dd-thresh-label m-dd-text-halo" data-dd-thresh-label="conv" x="${(yConvX1 + 4).toFixed(1)}" y="${convLabelY.toFixed(1)}" text-anchor="start">${Math.round(convSlopeVal * 100)}%</text>
            <text class="is-alert m-dd-text-halo" data-dd-zone-label="attention" x="${(padL + plotW - 6).toFixed(1)}" y="${topRightY}" text-anchor="end">${this.esc(t('ddQuadTopRight'))}${attCount ? ' · ' + attCount : ''}</text>
            <text class="is-learning m-dd-text-halo" data-dd-zone-label="learning" x="${(padL + plotW - 6).toFixed(1)}" y="${(padT + plotH - 6).toFixed(1)}" text-anchor="end">${this.esc(t('ddQuadBottomRight'))}${lrnCount ? ' · ' + lrnCount : ''}</text>`;
          this._ddStartScatterCameraAnim(svg, wrap, {
            kind: 'quadrant',
            width, height, padL, padT, plotW, plotH, hasZoom, t,
            highResVal, convSlopeVal, linX: xCfg.linThresh, linY: yCfg.linThresh,
            animX, animY, coords, xTicks, yTicks, xDirHtml, yDirHtml,
            durationMs: options.durationMs,
            cameraMode: options.cameraMode || '',
            targetLabelsHtml: animLabelsHtml,
            commitFinal: () => commitStatic(true, { settleAfterViewport: true }),
          });
          return;
        }
        commitStatic(false);
        return;
      }

      const dotsHtml = coords.map(d =>
        `<circle class="${d.cls}" data-dd-image-id="${this.esc(d.image_id)}" data-dd-status="${this.esc(d.status)}" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${d.r.toFixed(1)}" style="fill:${d.fill}"/>`
        + (d.status === 'non_finite'
          ? `<circle class="m-dd-dot-nan-ring" data-dd-image-id="${this.esc(d.image_id)}" data-dd-status="non_finite" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${(d.r + 3.2).toFixed(1)}"/>`
          : '')
      ).join('');

      svg.setAttribute('data-dd-svg-kind', 'quadrant');
      svg.setAttribute('data-dd-svg-width', String(width));
      svg.setAttribute('data-dd-svg-height', String(height));
      svg.setAttribute('data-dd-svg-zoom', zoomSig);
      svg.classList?.toggle?.('is-zones-on', !!this.datasetDiagShowZones);
      svg.innerHTML = `
        <defs>
          <clipPath id="${clipId}"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath>
        </defs>
        <g data-dd-compressed-bands clip-path="url(#${clipId})">${bandsHtml}</g>
        <g class="m-dd-grid-lines" data-dd-grid-lines clip-path="url(#${clipId})">${gridLinesHtml}</g>
        <g data-dd-zones clip-path="url(#${clipId})">${zonesHtml}</g>
        <g class="m-dd-axis-group" data-dd-axis-x-group style="transform:translateY(${axisY.toFixed(1)}px)">
          <line class="m-dd-axis-line" x1="${padL}" x2="${padL + plotW}" y1="0" y2="0"/>
          <g data-dd-axis-x-ticks>${xAxisTicksHtml}</g>
        </g>
        <g class="m-dd-axis-group" data-dd-axis-y-group style="transform:translateX(${axisX.toFixed(1)}px)">
          <line class="m-dd-axis-line" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}"/>
          <g data-dd-axis-y-ticks>${yAxisTicksHtml}</g>
        </g>
        <g class="m-dd-axis-origin" data-dd-axis-origin style="transform:translate(${axisX.toFixed(1)}px,${axisY.toFixed(1)}px);opacity:${layout.showOriginZero ? 1 : 0}">
          <text x="${layout.originX}" y="${layout.originY}" text-anchor="${layout.originAnchor}">0%</text>
        </g>
        <g class="m-dd-quad-labels">${quadLabelsHtml}</g>
        <g class="m-dd-crosshair" data-dd-crosshair display="none">
          <line data-dd-ch-x y1="${padT}" y2="${padT + plotH}"/>
          <line data-dd-ch-y x1="${padL}" x2="${padL + plotW}"/>
        </g>
        <g class="m-dd-history" data-dd-history clip-path="url(#${clipId})"></g>
        <g class="m-dd-trails" clip-path="url(#${clipId})"></g>
        <g class="m-dd-dots" clip-path="url(#${clipId})">${dotsHtml}</g>
        <g class="m-dd-pulses" clip-path="url(#${clipId})"></g>
        <line class="m-dd-pin-tether" data-dd-pin-tether display="none"/>
        <circle class="m-dd-dot-focus" data-dd-dot-focus r="7" display="none"/>`;
      const prevRebuildMap = wrap?._ddPrevDotCoords || null;
      if (wrap) {
        wrap._ddPanDotCache = null;
        wrap._ddCamera = targetCamera;
        wrap._ddCurrentCamera = targetCamera;
        wrap._ddTargetCamera = targetCamera;
        wrap._ddPrevDotCoords = new Map(coords.map(d => [d.image_id, { cx: d.cx, cy: d.cy }]));
      }
      if (typeof svg.querySelector === 'function' && typeof globalThis.document?.createElementNS === 'function') {
        const initNewIds = prevRebuildMap
          ? new Set(coords.filter(d => !prevRebuildMap.has(d.image_id)).map(d => d.image_id))
          : null;
        this._ddSpawnScatterPulses(
          svg.querySelector('.m-dd-pulses'),
          wrap,
          coords,
          initNewIds ? { ...dotOpts, newIds: initNewIds } : dotOpts
        );
      }

      wrap._ddChartState = { kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, axisX, axisY, coords, zones, toX, toY, fromX, fromY };
      this._syncDatasetDiagScatterFilter?.(wrap, { skipReorder: !!options.animate, skipPopReposition: true });
      this._refreshDatasetDiagActiveHover?.(wrap);
    },

    _renderDatasetDiagEarlySvg(wrap, svg, data, width, t, options = {}) {
      const measuredH = Math.round(options.stageHeight || wrap?.querySelector?.('[data-dd-hero-stage]')?.clientHeight || 0);
      let height = measuredH > 100 ? Math.max(360, Math.min(720, measuredH - 4)) : 440;
      const prevSvgH = Number(svg.getAttribute?.('data-dd-svg-height') || 0);
      if (options.animate && prevSvgH >= 360 && Math.abs(prevSvgH - height) <= 6) {
        height = prevSvgH;
      }
      const padL = 12, padR = 12, padT = 8, padB = 20;
      const plotW = Math.max(120, width - padL - padR);
      const plotH = Math.max(70, height - padT - padB);
      const ptSet = this._ddGetEarlyPointSet(wrap, data);
      const { points, displayed, leftmost, rightmost } = ptSet;

      const isPanFrame = Boolean(wrap?._ddPan?.active) && this._ddCanReconcileSvg(svg, 'early', width, height, '.m-dd-dots');
      if (!isPanFrame) {
        const resetBtn = this._ddFindScatterResetBtn(wrap);
        if (resetBtn) {
          resetBtn.hidden = !this.datasetDiagScatterZoom;
          this._ddSyncDashActionsVisibility(resetBtn.closest?.('[data-dd-dash-actions]'));
        }
      }
      const stageEl = wrap?.querySelector?.('[data-dd-hero-stage]');
      if (!points.length) {
        stageEl?.classList?.toggle?.('is-zoomed', false);
        this._ddSetChartCoverage(wrap, t, 0, 0, ptSet.imagesCount);
        svg.removeAttribute?.('data-dd-svg-kind');
        svg.removeAttribute?.('data-dd-svg-width');
        svg.removeAttribute?.('data-dd-svg-height');
        svg.removeAttribute?.('data-dd-svg-zoom');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(height));
        svg.innerHTML = `<text class="is-sans" x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--text-tertiary)" font-size="12">${this.esc(t('ddNoReferencePoints'))}</text>`;
        if (wrap) {
          wrap._ddPrevDotCoords = null;
          wrap._ddLastBoundsSig = '';
          wrap._ddCamera = null;
          wrap._ddCurrentCamera = null;
          wrap._ddTargetCamera = null;
        }
        wrap._ddChartState = null;
        return;
      }

      if (!isPanFrame) {
        this._ddSetChartCoverage(wrap, t, displayed.length, points.length, ptSet.imagesCount);
      }
      const autoBounds = this._ddResolveScatterAutoBounds(
        wrap,
        `e|${data.run_id || ''}`,
        { xMin: leftmost.mean_residual, xMax: rightmost.mean_residual },
        false
      );
      const z = this.datasetDiagScatterZoom;
      const hasZoom = !!(z && Number.isFinite(z.xMin) && Number.isFinite(z.xMax) && (z.xMax - z.xMin) >= 0.0005);
      if (!isPanFrame) stageEl?.classList?.toggle?.('is-zoomed', hasZoom);
      const xMin = hasZoom ? z.xMin : autoBounds.xMin;
      const xMax = hasZoom ? z.xMax : autoBounds.xMax;
      const xCfg = this._ddScatterAxisConfig('x');
      const xCompressed = !hasZoom && (xMax > xCfg.trigger || xMin < -xCfg.trigger);
      const symWX = xCompressed ? 1 : 0;
      const zoomSig = hasZoom ? [xMin.toFixed(5), xMax.toFixed(5)].join(':') : '';
      const boundsSig = `e|${hasZoom ? 'z' : 'a'}|${symWX}|${xMin.toFixed(5)}|${xMax.toFixed(5)}`;
      const scaleChanged = !!(wrap?._ddLastBoundsSig && wrap._ddLastBoundsSig !== boundsSig);
      if (wrap) wrap._ddLastBoundsSig = boundsSig;

      const { toPx: toX, fromPx: fromX } = this._ddBuildAxisScale(xMin, xMax, xCfg.linThresh, xCfg.k, symWX, padL, plotW, false);

      const midY = padT + plotH / 2;
      const maxDy = Math.max(24, plotH / 2 - 14);
      let coords;
      if (isPanFrame && wrap._ddEarlyLayoutCache?.data === data && wrap._ddEarlyLayoutCache.plotW === plotW && wrap._ddEarlyLayoutCache.xMin === xMin && wrap._ddEarlyLayoutCache.xMax === xMax) {
        coords = wrap._ddEarlyLayoutCache.coords;
      } else {
        const placed = this._ddPlaceEarlyBeeswarm(displayed, toX, midY, maxDy);
        const ordered = placed.slice().sort((a, b) => this._ddDotOrderWeight(a.status) - this._ddDotOrderWeight(b.status));
        const prevMap = wrap?._ddPrevDotCoords;
        coords = ordered.map(img => {
          const spec = this._ddScatterDotSpec(img.status);
          const fill = this._ddStatusDotColor(img.status);
          const prevCy = prevMap?.get?.(img.image_id)?.cy ?? img.cy;
          return { ...img, prevCy, fill, cls: spec.cls };
        });
        if (wrap) wrap._ddEarlyLayoutCache = { data, plotW, xMin, xMax, coords };
      }

      const xZero = toX(0);
      const axisX = Math.max(padL, Math.min(padL + plotW, xZero));
      const showXZero = xZero >= padL + 12 && xZero <= padL + plotW - 12;
      const highResVal = data.thresholds?.high_residual ?? 0.20;
      const xHigh = toX(highResVal);
      const attX = Math.max(padL, Math.min(padL + plotW, xHigh));
      const zoneW = Math.max(0, padL + plotW - attX);
      const zoneShow = zoneW > 4;
      const zones = [];
      if (zoneShow) {
        zones.push({ preset: 'attention', x1: attX, x2: padL + plotW, y1: padT, y2: padT + plotH });
      }

      const earlyTickY = height - 6;
      const xTicks = this._ddPickScatterTicks(
        xMin, xMax, xCompressed, xCfg.linThresh, 'x', toX,
        padL + 18, padL + plotW - 18, showXZero ? axisX : null, 42, plotW,
        []
      );
      const bandsHtml = this._ddCompressedBandsHtml(
        t, padL, padT, plotW, plotH, xMin, xMax, -1, 1, symWX, 0, toX, null, null, xCfg.linThresh, 1, false, zoneShow
      );
      const gridLinesHtml = xTicks.filter(tk => !tk.boundary).map(tk =>
        `<line${tk.compressed ? ' class="is-compressed"' : ''} x1="${tk.px.toFixed(1)}" x2="${tk.px.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>`
      ).join('');
      const xDirHtml = (!hasZoom && plotW > 220)
        ? `<text class="m-dd-axis-dir" x="${padL + 2}" y="${padT + 11}" text-anchor="start">${this.esc(t('ddQuadAxisResEasy'))}</text>`
          + `<text class="m-dd-axis-dir" x="${padL + plotW - 2}" y="${padT + plotH - 6}" text-anchor="end">${this.esc(t('ddQuadAxisResHard'))}</text>`
        : '';
      const xTicksHtml = xTicks.map(tk =>
        `<text x="${tk.px.toFixed(1)}" y="${earlyTickY}" text-anchor="middle">${this.esc(tk.label)}</text>`
      ).join('') + xDirHtml;

      const zoneHtml = `<rect class="m-dd-alert-zone m-dd-zone-hit" data-dd-zone-preset="attention" x="${attX.toFixed(1)}" y="${padT}" width="${(zoneShow ? zoneW : 0).toFixed(1)}" height="${plotH.toFixed(1)}"/>`;
      const attCount = points.reduce((n, p) => n + (p.status === 'attention' ? 1 : 0), 0);
      const showHighTick = xHigh >= padL + 8 && xHigh <= padL + plotW - 16;
      const highLabelX = xHigh > padL + plotW - 44 ? xHigh - 4 : xHigh + 4;
      const highLabelAnchor = xHigh > padL + plotW - 44 ? 'end' : 'start';
      const labelsHtml = `
        ${showHighTick ? `<text class="m-dd-thresh-label m-dd-text-halo" data-dd-thresh-label="high" x="${highLabelX.toFixed(1)}" y="${padT + 11}" text-anchor="${highLabelAnchor}">+${Math.round(highResVal * 100)}%</text>` : ''}
        ${zoneW > 54 ? `<text class="is-alert m-dd-text-halo" data-dd-zone-label="attention" x="${(padL + plotW - 6).toFixed(1)}" y="${padT + 13}" text-anchor="end">${this.esc(t('ddEarlyRight'))}${attCount ? ' · ' + attCount : ''}</text>` : ''}`;

      const targetCamera = { kind: 'early', xMin, xMax, symW_X: symWX, yMin: -1, yMax: 1, symW_Y: 0 };
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(height));

      const clipId = 'm-dd-clip-e-' + (this.selectedRunDir ? 'h' : 'l');
      const dotOpts = { ...options, scaleChanged };
      if (this._ddCanReconcileSvg(svg, 'early', width, height, '.m-dd-dots')) {
        svg.setAttribute('data-dd-svg-zoom', zoomSig);
        svg.classList?.toggle?.('is-zones-on', !!this.datasetDiagShowZones);
        const gridGroup = svg.querySelector('[data-dd-grid-lines]');
        const bandsGroup = svg.querySelector('[data-dd-compressed-bands]');
        const zonesGroup = svg.querySelector('[data-dd-zones]');
        const axisYGroup = svg.querySelector('[data-dd-axis-y-group]');
        const axisOrigin = svg.querySelector('[data-dd-axis-origin]');
        const labelsGroup = svg.querySelector('.m-dd-quad-labels');
        const axesGroup = svg.querySelector('.m-chart-axes');

        const commitStatic = (skipDotAnim = false, refreshOpts = null) => {
          if (gridGroup) gridGroup.innerHTML = gridLinesHtml;
          if (bandsGroup) bandsGroup.innerHTML = bandsHtml;
          this._ddReconcileZoneRect(zonesGroup, 'attention', attX, padT, zoneW, plotH, zoneShow);
          if (axisYGroup) axisYGroup.style.transform = `translateX(${axisX.toFixed(1)}px)`;
          if (axisOrigin) {
            axisOrigin.style.transform = `translate(${axisX.toFixed(1)}px,${earlyTickY.toFixed(1)}px)`;
            axisOrigin.style.opacity = showXZero ? '1' : '0';
          }
          if (labelsGroup) labelsGroup.innerHTML = labelsHtml;
          if (axesGroup) axesGroup.innerHTML = xTicksHtml;
          this._ddReconcileScatterDots(svg, wrap, coords, skipDotAnim ? { ...dotOpts, animate: false } : dotOpts);
          if (wrap) {
            wrap._ddCamera = targetCamera;
            wrap._ddCurrentCamera = targetCamera;
            wrap._ddTargetCamera = targetCamera;
          }
          wrap._ddChartState = { kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, axisX, axisY: midY, coords, zones, toX, fromX };
          this._syncDatasetDiagScatterFilter?.(wrap, { skipReorder: !!options.animate, skipPopReposition: true });
          const effectiveRefreshOpts = refreshOpts || (scaleChanged && !wrap?._ddPan?.active && wrap?._ddPinnedDot ? { settleAfterViewport: true } : undefined);
          this._refreshDatasetDiagActiveHover?.(wrap, effectiveRefreshOpts);
        };

        const prevCam = options.prevCamera;
        const canCameraRaf = scaleChanged
          && options.animate
          && prevCam
          && prevCam.kind === 'early'
          && (!this._monitorMotionAllowed || this._monitorMotionAllowed())
          && typeof globalThis.requestAnimationFrame === 'function';

        if (canCameraRaf) {
          if (wrap) wrap._ddTargetCamera = targetCamera;
          const animX = this._ddMakeAxisAnimator(prevCam.xMin, prevCam.xMax, prevCam.symW_X, xMin, xMax, symWX, xCfg.linThresh, xCfg.k, padL, plotW, false);
          const fx0 = animX(0);
          const startCoords = coords.map(d => ({ ...d, cx: fx0.toPx(d.mean_residual), cy: d.prevCy }));
          this._ddReconcileScatterDots(svg, wrap, startCoords, dotOpts);
          wrap._ddChartState = { kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, axisX, axisY: midY, coords, zones, toX, fromX };
          this._syncDatasetDiagScatterFilter?.(wrap, { skipReorder: true, skipPopReposition: true });
          const animLabelsHtml = `
            <text class="m-dd-thresh-label m-dd-text-halo" data-dd-thresh-label="high" x="${highLabelX.toFixed(1)}" y="${padT + 11}" text-anchor="${highLabelAnchor}">+${Math.round(highResVal * 100)}%</text>
            <text class="is-alert m-dd-text-halo" data-dd-zone-label="attention" x="${(padL + plotW - 6).toFixed(1)}" y="${padT + 13}" text-anchor="end">${this.esc(t('ddEarlyRight'))}${attCount ? ' · ' + attCount : ''}</text>`;
          this._ddStartScatterCameraAnim(svg, wrap, {
            kind: 'early',
            width, height, padL, padT, plotW, plotH, hasZoom, t,
            highResVal, convSlopeVal: 0, linX: xCfg.linThresh, linY: 1,
            earlyTickY,
            animX, animY: null, coords, xTicks, yTicks: [], xDirHtml, yDirHtml: '',
            durationMs: options.durationMs,
            cameraMode: options.cameraMode || '',
            targetLabelsHtml: animLabelsHtml,
            commitFinal: () => commitStatic(true, { settleAfterViewport: true }),
          });
          return;
        }
        commitStatic(false);
        return;
      }

      const dotsHtml = coords.map(d =>
        `<circle class="${d.cls}" data-dd-image-id="${this.esc(d.image_id)}" data-dd-status="${this.esc(d.status)}" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${d.r.toFixed(1)}" style="fill:${d.fill}"/>`
        + (d.status === 'non_finite'
          ? `<circle class="m-dd-dot-nan-ring" data-dd-image-id="${this.esc(d.image_id)}" data-dd-status="non_finite" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${(d.r + 3.2).toFixed(1)}"/>`
          : '')
      ).join('');

      svg.setAttribute('data-dd-svg-kind', 'early');
      svg.setAttribute('data-dd-svg-width', String(width));
      svg.setAttribute('data-dd-svg-height', String(height));
      svg.setAttribute('data-dd-svg-zoom', zoomSig);
      svg.classList?.toggle?.('is-zones-on', !!this.datasetDiagShowZones);
      svg.innerHTML = `
        <defs>
          <clipPath id="${clipId}"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath>
        </defs>
        <g data-dd-compressed-bands clip-path="url(#${clipId})">${bandsHtml}</g>
        <g class="m-dd-grid-lines" data-dd-grid-lines clip-path="url(#${clipId})">${gridLinesHtml}</g>
        <line class="m-dd-axis-line m-dd-early-midline" x1="${padL}" x2="${padL + plotW}" y1="${midY.toFixed(1)}" y2="${midY.toFixed(1)}"/>
        <g data-dd-zones clip-path="url(#${clipId})">${zoneHtml}</g>
        <g class="m-dd-axis-group" data-dd-axis-y-group style="transform:translateX(${axisX.toFixed(1)}px)">
          <line class="m-dd-axis-line" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}"/>
        </g>
        <g class="m-dd-axis-origin" data-dd-axis-origin style="transform:translate(${axisX.toFixed(1)}px,${earlyTickY.toFixed(1)}px);opacity:${showXZero ? 1 : 0}">
          <text x="0" y="0" text-anchor="middle">0%</text>
        </g>
        <g class="m-dd-quad-labels">${labelsHtml}</g>
        <g class="m-dd-crosshair" data-dd-crosshair display="none">
          <line data-dd-ch-x y1="${padT}" y2="${padT + plotH}"/>
          <line data-dd-ch-y x1="${padL}" x2="${padL + plotW}"/>
        </g>
        <g class="m-dd-trails" clip-path="url(#${clipId})"></g>
        <g class="m-dd-dots" clip-path="url(#${clipId})">${dotsHtml}</g>
        <g class="m-dd-pulses" clip-path="url(#${clipId})"></g>
        <line class="m-dd-pin-tether" data-dd-pin-tether display="none"/>
        <circle class="m-dd-dot-focus" data-dd-dot-focus r="7" display="none"/>
        <g class="m-chart-axes m-dd-axis-group">${xTicksHtml}</g>`;
      const prevEarlyMap = wrap?._ddPrevDotCoords || null;
      if (wrap) {
        wrap._ddCamera = targetCamera;
        wrap._ddCurrentCamera = targetCamera;
        wrap._ddTargetCamera = targetCamera;
        wrap._ddPrevDotCoords = new Map(coords.map(d => [d.image_id, { cx: d.cx, cy: d.cy }]));
      }
      if (typeof svg.querySelector === 'function' && typeof globalThis.document?.createElementNS === 'function') {
        const initEarlyNewIds = prevEarlyMap
          ? new Set(coords.filter(d => !prevEarlyMap.has(d.image_id)).map(d => d.image_id))
          : null;
        this._ddSpawnScatterPulses(
          svg.querySelector('.m-dd-pulses'),
          wrap,
          coords,
          initEarlyNewIds ? { ...dotOpts, newIds: initEarlyNewIds } : dotOpts
        );
      }

      wrap._ddChartState = { kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, axisX, axisY: midY, coords, zones, toX, fromX };
      this._syncDatasetDiagScatterFilter?.(wrap, { skipReorder: !!options.animate, skipPopReposition: true });
      this._refreshDatasetDiagActiveHover?.(wrap);
    },

    _ddPositionDatasetDiagPopover(pop, anchor, opts = {}) {
      if (!pop || !anchor) return;
      const win = (typeof window !== 'undefined' ? window : globalThis);
      const vw = win.innerWidth || 1440;
      const vh = win.innerHeight || 900;
      const popW = opts.popSize?.width || pop.offsetWidth || 244;
      const popH = opts.popSize?.height || pop.offsetHeight || 256;
      const pad = 8;
      const trajPoints = Array.isArray(anchor.trajPoints) && anchor.trajPoints.length >= 2 ? anchor.trajPoints : null;
      const gap = trajPoints ? 28 : 16;
      const vGapTop = trajPoints ? 26 : 14;
      const vGapBot = trajPoints ? 16 : 14;

      const minLeft = Number.isFinite(anchor.svgLeft) ? Math.max(12, anchor.svgLeft + pad) : 12;
      const maxRight = Number.isFinite(anchor.svgRight) ? Math.min(vw - 12, anchor.svgRight - pad) : (vw - 12);
      const minTop = Number.isFinite(anchor.svgTop) ? Math.max(12, anchor.svgTop + pad) : 12;
      const maxBottom = Number.isFinite(anchor.svgBottom) ? Math.min(vh - 12, anchor.svgBottom - pad) : (vh - 12);
      const maxLeft = Math.max(minLeft, maxRight - popW);
      const maxTop = Math.max(minTop, maxBottom - popH);

      const relY = Math.max(0, Math.min(1, (anchor.y - minTop) / Math.max(1, maxBottom - minTop)));
      const horizTop = Math.max(minTop, Math.min(maxTop, anchor.y - popH * (0.14 + relY * 0.72)));

      const coords = Array.isArray(anchor.coords) ? anchor.coords : null;
      const ox = Number.isFinite(anchor.svgLeft) ? anchor.svgLeft : 0;
      const oy = Number.isFinite(anchor.svgTop) ? anchor.svgTop : 0;
      const countOccluded = (rx, ry, rw, rh) => {
        if (!coords || !coords.length) return 0;
        const x1 = rx - 4, x2 = rx + rw + 4, y1 = ry - 4, y2 = ry + rh + 4;
        let n = 0;
        for (const pt of coords) {
          if (!pt || pt.image_id === anchor.activeId) continue;
          const px = ox + pt.cx;
          const py = oy + pt.cy;
          if (px >= x1 && px <= x2 && py >= y1 && py <= y2) n += 1;
        }
        return n;
      };

      const scoreTrajectoryOcclusion = trajPoints
        ? (rx, ry, rw, rh) => {
            const x1 = rx - 12;
            const x2 = rx + rw + 12;
            const y1 = ry - 12;
            const y2 = ry + rh + 12;
            const segHitsRect = (ax, ay, bx, by) => {
              let t0 = 0;
              let t1 = 1;
              const dx = bx - ax;
              const dy = by - ay;
              const clip = (p, q) => {
                if (Math.abs(p) < 1e-9) return q >= 0;
                const r = q / p;
                if (p < 0) {
                  if (r > t1) return false;
                  if (r > t0) t0 = r;
                } else {
                  if (r < t0) return false;
                  if (r < t1) t1 = r;
                }
                return true;
              };
              return clip(-dx, ax - x1) && clip(dx, x2 - ax) && clip(-dy, ay - y1) && clip(dy, y2 - ay);
            };
            let score = 0;
            for (const pt of trajPoints) {
              const px = ox + pt.cx;
              const py = oy + pt.cy;
              if (px >= x1 && px <= x2 && py >= y1 && py <= y2) score += 10;
            }
            const fracs = [0.16, 0.33, 0.50, 0.67, 0.84];
            for (let i = 0; i < trajPoints.length - 1; i++) {
              const ax = ox + trajPoints[i].cx;
              const ay = oy + trajPoints[i].cy;
              const bx = ox + trajPoints[i + 1].cx;
              const by = oy + trajPoints[i + 1].cy;
              if (segHitsRect(ax, ay, bx, by)) score += 6;
              for (const f of fracs) {
                const sx = ax + (bx - ax) * f;
                const sy = ay + (by - ay) * f;
                if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) score += 1;
              }
            }
            return score;
          }
        : null;

      const rightX = anchor.x + gap;
      const leftX = anchor.x - popW - gap;
      const rightFits = rightX >= minLeft && (rightX + popW) <= maxRight;
      const leftFits = leftX >= minLeft && (leftX + popW) <= maxRight;
      const centerX = Math.max(minLeft, Math.min(maxLeft, anchor.x - popW / 2));
      const topY = anchor.y - popH - vGapTop;
      const botY = anchor.y + vGapBot;
      const topFits = topY >= minTop && (topY + popH) <= maxBottom;
      const botFits = botY >= minTop && (botY + popH) <= maxBottom;

      const resolveVertical = vAlign => (vAlign === 'top' ? minTop : (vAlign === 'bottom' ? maxTop : horizTop));
      const geomFor = (side, vAlign = 'auto') => {
        if (side === 'right') return { placement: 'right', vAlign, left: rightX, top: resolveVertical(vAlign), fits: rightFits };
        if (side === 'left') return { placement: 'left', vAlign, left: leftX, top: resolveVertical(vAlign), fits: leftFits };
        if (side === 'top') return { placement: 'top', vAlign: 'auto', left: centerX, top: topY, fits: topFits };
        return { placement: 'bottom', vAlign: 'auto', left: centerX, top: botY, fits: botFits };
      };

      const prevSide = opts.wasHidden ? null : (pop._ddPopPlacement || null);
      const prevVAlign = opts.wasHidden ? 'auto' : (pop._ddPopVAlign || 'auto');
      let placement = 'right';
      let vAlign = 'auto';
      let left = rightX;
      let top = horizTop;
      let resolved = false;

      if (!opts.wasHidden && prevSide && (opts.immediate || opts.keepPlacement)) {
        const cur = geomFor(prevSide, prevVAlign);
        if (cur.fits || opts.keepPlacement) {
          placement = cur.placement;
          vAlign = cur.vAlign;
          left = cur.left;
          top = cur.top;
          resolved = true;
        } else {
          const oppSide = prevSide === 'right' ? 'left' : (prevSide === 'left' ? 'right' : (prevSide === 'top' ? 'bottom' : 'top'));
          const opp = geomFor(oppSide, 'auto');
          if (opp.fits) {
            placement = opp.placement;
            vAlign = opp.vAlign;
            left = opp.left;
            top = opp.top;
            resolved = true;
          } else {
            const others = ['right', 'left', 'top', 'bottom']
              .filter(s => s !== prevSide && s !== oppSide)
              .map(s => geomFor(s, 'auto'))
              .filter(g => g.fits);
            if (others.length) {
              let best = others[0];
              if (others.length > 1) {
                const metric = g => (scoreTrajectoryOcclusion
                  ? [scoreTrajectoryOcclusion(g.left, g.top, popW, popH), (g.placement === 'top' || g.placement === 'bottom') ? 1 : 0]
                  : [(g.placement === 'top' || g.placement === 'bottom') ? 1 : 0, -Math.min(g.left - minLeft, maxRight - (g.left + popW), g.top - minTop, maxBottom - (g.top + popH))]);
                let bestM = metric(best);
                for (let i = 1; i < others.length; i++) {
                  const m = metric(others[i]);
                  if (m[0] < bestM[0] || (m[0] === bestM[0] && m[1] < bestM[1])) {
                    best = others[i];
                    bestM = m;
                  }
                }
              }
              placement = best.placement;
              vAlign = best.vAlign;
              left = best.left;
              top = best.top;
              resolved = true;
            } else {
              placement = cur.placement;
              vAlign = cur.vAlign;
              left = cur.left;
              top = cur.top;
              resolved = true;
            }
          }
        }
      }

      if (!resolved && trajPoints && scoreTrajectoryOcclusion) {
        const candidates = [];
        if (rightFits) {
          candidates.push({ placement: 'right', vAlign: 'auto', left: rightX, top: horizTop, pref: 0 });
          if (maxTop > minTop + 8) {
            candidates.push({ placement: 'right', vAlign: 'top', left: rightX, top: minTop, pref: 1 });
            candidates.push({ placement: 'right', vAlign: 'bottom', left: rightX, top: maxTop, pref: 1 });
          }
        }
        if (leftFits) {
          candidates.push({ placement: 'left', vAlign: 'auto', left: leftX, top: horizTop, pref: 0 });
          if (maxTop > minTop + 8) {
            candidates.push({ placement: 'left', vAlign: 'top', left: leftX, top: minTop, pref: 1 });
            candidates.push({ placement: 'left', vAlign: 'bottom', left: leftX, top: maxTop, pref: 1 });
          }
        }
        if (topFits) candidates.push({ placement: 'top', vAlign: 'auto', left: centerX, top: topY, pref: 0.5 });
        if (botFits) candidates.push({ placement: 'bottom', vAlign: 'auto', left: centerX, top: botY, pref: 0.5 });

        if (candidates.length) {
          const cur = prevSide ? geomFor(prevSide, prevVAlign) : null;
          const curScore = cur?.fits ? scoreTrajectoryOcclusion(cur.left, cur.top, popW, popH) : Infinity;
          let bestCand = null;
          let bestKey = null;
          for (const c of candidates) {
            const key = [
              scoreTrajectoryOcclusion(c.left, c.top, popW, popH),
              (prevSide === c.placement && prevVAlign === c.vAlign) ? 0 : (prevSide === c.placement ? 0.5 : 1),
              c.pref,
              countOccluded(c.left, c.top, popW, popH),
              Math.hypot((c.left + popW * 0.5) - anchor.x, (c.top + popH * 0.5) - anchor.y),
            ];
            let isBetter = !bestKey;
            if (!isBetter) {
              for (let idx = 0; idx < key.length; idx++) {
                if (key[idx] < bestKey[idx]) { isBetter = true; break; }
                if (key[idx] > bestKey[idx]) break;
              }
            }
            if (isBetter) {
              bestCand = c;
              bestKey = key;
            }
          }
          if (cur?.fits && (curScore === 0 || (bestKey && bestKey[0] + 6 > curScore))) {
            placement = cur.placement;
            vAlign = cur.vAlign;
            left = cur.left;
            top = cur.top;
            resolved = true;
          } else if (bestCand) {
            placement = bestCand.placement;
            vAlign = bestCand.vAlign;
            left = bestCand.left;
            top = bestCand.top;
            resolved = true;
          }
        } else if (prevSide) {
          const cur = geomFor(prevSide, prevVAlign);
          placement = cur.placement;
          vAlign = cur.vAlign;
          left = cur.left;
          top = cur.top;
          resolved = true;
        }
      }

      if (!resolved) {
        if (rightFits && !leftFits) {
          placement = 'right';
          left = rightX;
        } else if (leftFits && !rightFits) {
          placement = 'left';
          left = leftX;
        } else if (rightFits && leftFits) {
          if (prevSide === 'left' || prevSide === 'right') {
            placement = prevSide;
          } else {
            const occRight = countOccluded(rightX, horizTop, popW, popH);
            const occLeft = countOccluded(leftX, horizTop, popW, popH);
            if (occRight !== occLeft) {
              placement = occLeft < occRight ? 'left' : 'right';
            } else {
              const roomRight = maxRight - (rightX + popW);
              const roomLeft = leftX - minLeft;
              placement = roomLeft > roomRight ? 'left' : 'right';
            }
          }
          left = placement === 'left' ? leftX : rightX;
        } else {
          if (topFits && !botFits) {
            placement = 'top';
          } else if (botFits && !topFits) {
            placement = 'bottom';
          } else if (topFits && botFits) {
            if (prevSide === 'top' || prevSide === 'bottom') {
              placement = prevSide;
            } else {
              const occTop = countOccluded(centerX, topY, popW, popH);
              const occBot = countOccluded(centerX, botY, popW, popH);
              if (occTop !== occBot) {
                placement = occTop < occBot ? 'top' : 'bottom';
              } else {
                const roomTop = topY - minTop;
                const roomBot = maxBottom - (botY + popH);
                placement = roomTop > roomBot ? 'top' : 'bottom';
              }
            }
          } else if (prevSide) {
            placement = prevSide;
            vAlign = prevVAlign;
          } else {
            const roomTop = anchor.y - minTop;
            const roomBot = maxBottom - anchor.y;
            placement = roomTop > roomBot ? 'top' : 'bottom';
          }
          left = (placement === 'left') ? leftX : (placement === 'right' ? rightX : centerX);
          const rawTop = placement === 'top' ? topY : (placement === 'bottom' ? botY : resolveVertical(vAlign));
          top = Math.max(minTop, Math.min(maxTop, rawTop));
        }
      }

      left = Math.max(minLeft, Math.min(maxLeft, left));
      top = Math.max(minTop, Math.min(maxTop, top));
      const shouldGlide = !opts.immediate && !opts.wasHidden && prevSide !== null && prevSide === placement && prevVAlign === vAlign;
      pop.classList?.toggle?.('is-moving', shouldGlide);
      pop._ddPopPlacement = placement;
      pop._ddPopVAlign = vAlign;
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
    },

    _ddSyncScatterFocusVisuals(wrap, svg, dot, cxOverride = null, cyOverride = null, refs = null) {
      if (!svg || !dot) return;
      const live = wrap?._ddLiveDotCoords?.get?.(dot.image_id);
      const cx = cxOverride != null ? cxOverride : (live ? live.cx : dot.cx);
      const cy = cyOverride != null ? cyOverride : (live ? live.cy : dot.cy);
      const focusRing = refs?.focusRing ?? svg.querySelector?.('[data-dd-dot-focus]');
      const ch = refs?.ch ?? svg.querySelector?.('[data-dd-crosshair]');
      const st = wrap?._ddChartState;
      const inBounds = !st || (
        cx >= st.padL - 2 && cx <= st.padL + st.plotW + 2
        && cy >= st.padT - 2 && cy <= st.padT + st.plotH + 2
      );
      if (!inBounds) {
        ch?.setAttribute?.('display', 'none');
        focusRing?.setAttribute?.('display', 'none');
        return;
      }
      if (ch) {
        const vx = refs?.chVx ?? ch.querySelector?.('[data-dd-ch-x]');
        const hy = refs?.chHy ?? ch.querySelector?.('[data-dd-ch-y]');
        if (vx) { vx.setAttribute('x1', cx.toFixed(1)); vx.setAttribute('x2', cx.toFixed(1)); }
        if (hy) {
          if (Number.isFinite(dot.slope)) {
            hy.setAttribute('y1', cy.toFixed(1));
            hy.setAttribute('y2', cy.toFixed(1));
            hy.removeAttribute('display');
          } else {
            hy.setAttribute('display', 'none');
          }
        }
        ch.removeAttribute('display');
      }
      if (focusRing) {
        focusRing.setAttribute('cx', cx.toFixed(1));
        focusRing.setAttribute('cy', cy.toFixed(1));
        focusRing.setAttribute('r', (dot.r + 3.5).toFixed(1));
        if (focusRing.style) focusRing.style.stroke = dot.fill;
        focusRing.removeAttribute('display');
      }
    },

    _ddPopulatePreviewPop(pop, dot, t) {
      if (!pop || !dot) return;
      const img = pop.querySelector?.('img');
      const titleEl = pop.querySelector?.('[data-dd-pop-title]');
      const resEl = pop.querySelector?.('[data-dd-pop-res]');
      const slopeEl = pop.querySelector?.('[data-dd-pop-slope]');
      const resoEl = pop.querySelector?.('[data-dd-pop-reso]');
      const statusEl = pop.querySelector?.('[data-dd-pop-status]');
      const regEl = pop.querySelector?.('[data-dd-pop-reg]');
      if (titleEl) {
        titleEl.textContent = dot.name || dot.image || '';
        titleEl.setAttribute('title', dot.image || dot.name || '');
      }
      if (resEl) {
        const resStr = this._ddFormatResidual(dot.mean_residual);
        const resColor = this._ddResidualColor(dot.mean_residual);
        resEl.innerHTML = '<small class="m-dd-card-kv">' + this.esc(t('ddCardResidual')) + '</small>'
          + '<b style="color:' + resColor + '">' + this.esc(resStr) + '</b>';
      }
      if (slopeEl) {
        const slopeText = dot.slope != null ? (this._ddFormatSlope(dot.slope) + t('ddSlopeUnit')) : '—';
        const slopeColor = this._ddSlopeColor(dot.slope);
        slopeEl.innerHTML = '<small class="m-dd-card-kv">' + this.esc(t('ddCardSlope')) + '</small>'
          + '<b style="color:' + slopeColor + '">' + this.esc(slopeText) + '</b>';
      }
      if (resoEl) {
        const resoText = this._ddFormatResolution(dot.resolution);
        const countReso = t('ddCardCountReso').replace('{n}', dot.count).replace('{reso}', resoText);
        resoEl.textContent = countReso;
        resoEl.setAttribute('title', countReso);
      }
      if (statusEl) {
        const sm = this._ddStatusMeta(t, dot.status, dot.slope);
        statusEl.className = 'm-dd-card-flag is-' + sm.tone;
        statusEl.textContent = sm.label;
      }
      if (regEl) {
        regEl.hidden = !dot.is_reg;
        regEl.textContent = dot.is_reg ? t('ddRegTag') : '';
      }
      if (img) {
        if (dot.thumb_url) {
          const srcChanged = img.getAttribute('src') !== dot.thumb_url;
          if (srcChanged) {
            img.classList?.remove?.('is-loaded');
            img.setAttribute('src', dot.thumb_url);
          }
          if (img.parentElement) img.parentElement.hidden = false;
          img.classList?.toggle?.('is-loaded', Boolean(img.complete && img.naturalWidth));
          pop.classList?.remove?.('is-no-media');
        } else {
          img.classList?.remove?.('is-loaded');
          img.removeAttribute('src');
          if (img.parentElement) img.parentElement.hidden = true;
          pop.classList?.add?.('is-no-media');
        }
      }
    },

    _ddUpdatePinnedPopPosition(wrap, opts = {}) {
      const svg = wrap?.querySelector?.('[data-dd-hero-svg]');
      const pop = wrap?.querySelector?.('[data-dd-preview-pop]');
      const st = wrap?._ddChartState;
      const dot = wrap?._ddPinnedDot;
      if (!svg || !pop || !st || !dot) return;
      const live = wrap._ddLiveDotCoords?.get?.(dot.image_id);
      const rawCx = opts.cx != null ? opts.cx : (live ? live.cx : dot.cx);
      const rawCy = opts.cy != null ? opts.cy : (live ? live.cy : dot.cy);
      const cx = Math.max(st.padL, Math.min(st.padL + st.plotW, rawCx));
      const cy = Math.max(st.padT, Math.min(st.padT + st.plotH, rawCy));
      const cachedSvg = wrap._ddAnimGeom?.svgRect;
      const svgRect = cachedSvg || svg.getBoundingClientRect?.() || { left: 0, right: st.width || 700, top: 0, bottom: st.height || 440 };
      wrap._ddPopAnchor = {
        x: svgRect.left + cx,
        y: svgRect.top + cy,
        svgLeft: svgRect.left,
        svgRight: svgRect.right,
        svgTop: svgRect.top,
        svgBottom: svgRect.bottom,
        coords: st.coords || null,
        trajPoints: Array.isArray(wrap._ddActiveTrajPixels) ? wrap._ddActiveTrajPixels : null,
        activeId: dot.image_id,
      };
      this._ddPositionDatasetDiagPopover(pop, wrap._ddPopAnchor, {
        ...opts,
        popSize: opts.popSize || wrap._ddAnimGeom?.popSize || null,
      });
    },

    _ddPinnedPopRectLocal(wrap, svg, pop) {
      const animGeom = wrap?._ddAnimGeom;
      if (animGeom?.svgRect) {
        const styleLeft = parseFloat(pop?.style?.left);
        const styleTop = parseFloat(pop?.style?.top);
        if (Number.isFinite(styleLeft) && Number.isFinite(styleTop)) {
          const w = animGeom.popSize?.width || 244;
          const h = animGeom.popSize?.height || 256;
          const localLeft = styleLeft - (animGeom.svgRect.left || 0);
          const localTop = styleTop - (animGeom.svgRect.top || 0);
          return { left: localLeft, top: localTop, right: localLeft + w, bottom: localTop + h };
        }
      }
      const svgRect = svg?.getBoundingClientRect?.() || { left: 0, top: 0 };
      const popRect = pop?.getBoundingClientRect?.();
      if (popRect && popRect.width > 0 && popRect.height > 0) {
        return {
          left: popRect.left - svgRect.left,
          top: popRect.top - svgRect.top,
          right: popRect.right - svgRect.left,
          bottom: popRect.bottom - svgRect.top,
        };
      }
      const styleLeft = parseFloat(pop?.style?.left);
      const styleTop = parseFloat(pop?.style?.top);
      if (!Number.isFinite(styleLeft) || !Number.isFinite(styleTop)) return null;
      const w = pop.offsetWidth || 244;
      const h = pop.offsetHeight || 256;
      const localLeft = styleLeft - (svgRect.left || 0);
      const localTop = styleTop - (svgRect.top || 0);
      return { left: localLeft, top: localTop, right: localLeft + w, bottom: localTop + h };
    },

    _ddPinnedPopCoversDot(wrap, dot, cxOverride = null, cyOverride = null) {
      if (!wrap || !dot) return false;
      const svg = wrap.querySelector?.('[data-dd-hero-svg]');
      const pop = wrap.querySelector?.('[data-dd-preview-pop]');
      const st = wrap._ddChartState;
      if (!svg || !pop || pop.hidden || !st) return false;
      const live = wrap._ddLiveDotCoords?.get?.(dot.image_id);
      const dx = cxOverride != null ? cxOverride : (live ? live.cx : dot.cx);
      const dy = cyOverride != null ? cyOverride : (live ? live.cy : dot.cy);
      const inBounds = dx >= st.padL - 2 && dx <= st.padL + st.plotW + 2
        && dy >= st.padT - 2 && dy <= st.padT + st.plotH + 2;
      if (!inBounds) return false;
      const rect = this._ddPinnedPopRectLocal(wrap, svg, pop);
      if (!rect) return false;
      const margin = 18;
      return dx >= rect.left - margin && dx <= rect.right + margin
        && dy >= rect.top - margin && dy <= rect.bottom + margin;
    },

    _ddSettlePinnedPopAfterViewportChange(wrap) {
      const dot = wrap?._ddPinnedDot;
      if (!dot) return;
      if (wrap._ddPopHovered) {
        if (this._ddPinnedPopCoversDot(wrap, dot)) {
          wrap._ddPopRepositionPending = true;
        }
        this._updateDatasetDiagPinTether(wrap);
        return;
      }
      if (this._ddPinnedPopCoversDot(wrap, dot)) {
        wrap._ddPopDetached = false;
        wrap._ddPopRepositionPending = false;
        this._ddUpdatePinnedPopPosition(wrap, { wasHidden: false });
      }
      this._updateDatasetDiagPinTether(wrap);
    },

    _updateDatasetDiagPinTether(wrap, cxOverride = null, cyOverride = null, tetherRef = null) {
      const svg = wrap?.querySelector?.('[data-dd-hero-svg]');
      const tether = tetherRef || svg?.querySelector?.('[data-dd-pin-tether]');
      if (!tether) return;
      if (!wrap?._ddPinnedDot || (!wrap?._ddPopDetached && !(wrap?._ddPopHovered && wrap?._ddPopRepositionPending))) {
        tether.setAttribute('display', 'none');
        return;
      }
      const st = wrap._ddChartState;
      const pop = wrap.querySelector?.('[data-dd-preview-pop]');
      const live = wrap._ddLiveDotCoords?.get?.(wrap._ddPinnedDot.image_id);
      const dx = cxOverride != null ? cxOverride : (live ? live.cx : wrap._ddPinnedDot.cx);
      const dy = cyOverride != null ? cyOverride : (live ? live.cy : wrap._ddPinnedDot.cy);
      const inBounds = !st || (
        dx >= st.padL - 2 && dx <= st.padL + st.plotW + 2
        && dy >= st.padT - 2 && dy <= st.padT + st.plotH + 2
      );
      if (!inBounds) {
        tether.setAttribute('display', 'none');
        return;
      }
      const rect = this._ddPinnedPopRectLocal(wrap, svg, pop);
      if (!rect) {
        tether.setAttribute('display', 'none');
        return;
      }
      const anchorX = Math.max(rect.left, Math.min(rect.right, dx));
      const anchorY = Math.max(rect.top, Math.min(rect.bottom, dy));
      if (Math.hypot(dx - anchorX, dy - anchorY) <= 4) {
        tether.setAttribute('display', 'none');
        return;
      }
      tether.setAttribute('x1', anchorX.toFixed(1));
      tether.setAttribute('y1', anchorY.toFixed(1));
      tether.setAttribute('x2', dx.toFixed(1));
      tether.setAttribute('y2', dy.toFixed(1));
      tether.removeAttribute('display');
    },

    _ddUpdateScatterTrajectoryInPlace(wrap, mapX, mapY) {
      const cache = wrap?._ddTrajRenderCache;
      const targetId = wrap?._ddPinnedDot?.image_id || '';
      if (!cache || !targetId || cache.targetId !== targetId || typeof mapX !== 'function' || typeof mapY !== 'function') {
        return false;
      }
      const { pts, segEls, nodeEls, labelInfos, padL, plotW, padT } = cache;
      if (!pts?.length || segEls.length !== pts.length - 1 || nodeEls.length !== pts.length - 1) return false;
      const pxArr = new Array(pts.length);
      const pyArr = new Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        pxArr[i] = mapX(pts[i].mean_residual);
        pyArr[i] = mapY(pts[i].slope);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const sEl = segEls[i];
        sEl.setAttribute('x1', pxArr[i].toFixed(1));
        sEl.setAttribute('y1', pyArr[i].toFixed(1));
        sEl.setAttribute('x2', pxArr[i + 1].toFixed(1));
        sEl.setAttribute('y2', pyArr[i + 1].toFixed(1));
        const nEl = nodeEls[i];
        nEl.setAttribute('cx', pxArr[i].toFixed(1));
        nEl.setAttribute('cy', pyArr[i].toFixed(1));
      }
      const minX = padL + 24;
      const maxX = Math.max(minX, padL + plotW - 24);
      for (let i = 0; i < labelInfos.length; i++) {
        const info = labelInfos[i];
        const idx = info.idx;
        const lx = Math.max(minX, Math.min(maxX, pxArr[idx]));
        const ly = Math.max(padT + 10, pyArr[idx] - (pts[idx].r + 4.5));
        info.el.setAttribute('x', lx.toFixed(1));
        info.el.setAttribute('y', ly.toFixed(1));
      }
      if (!Array.isArray(wrap._ddActiveTrajPixels) || wrap._ddActiveTrajPixels.length !== pts.length) {
        wrap._ddActiveTrajPixels = pts.map((_, idx) => ({ cx: pxArr[idx], cy: pyArr[idx] }));
      } else {
        for (let i = 0; i < pts.length; i++) {
          wrap._ddActiveTrajPixels[i].cx = pxArr[i];
          wrap._ddActiveTrajPixels[i].cy = pyArr[i];
        }
      }
      return true;
    },

    _syncDatasetDiagScatterTrajectory(wrapArg, opts = null) {
      const wrap = wrapArg
        || globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"] [data-dd-hero-wrap][data-mode="quadrant"]');
      const svg = wrap?.querySelector?.('[data-dd-hero-svg]');
      const st = wrap?._ddChartState;
      const historyGroup = svg?.querySelector?.('[data-dd-history]');
      if (!svg || !st || st.kind !== 'scatter' || !historyGroup) return;

      const isQuadrant = svg.getAttribute?.('data-dd-svg-kind') === 'quadrant';
      const targetId = isQuadrant
        ? (wrap._ddPinnedDot?.image_id
          || wrap._ddHoverDot?.image_id
          || (this._datasetDiagHoverPreview?.kind === 'image' ? this._datasetDiagHoverPreview.imageId : ''))
        : '';

      if (!targetId) {
        wrap._ddActiveTrajPixels = null;
        wrap._ddTrajRenderCache = null;
        historyGroup.innerHTML = '';
        svg.classList?.remove?.('has-traj-focus');
        svg.querySelectorAll?.('.is-traj-active')?.forEach?.(el => el.classList?.remove?.('is-traj-active'));
        return;
      }

      if (!opts?.skipDomScan) {
        svg.classList?.add?.('has-traj-focus');
        svg.querySelectorAll?.('.m-dd-dot, .m-dd-dot-nan-ring')?.forEach?.(el => {
          el.classList?.toggle?.('is-traj-active', el.dataset?.ddImageId === targetId);
        });
      }

      const mapX = opts?.toX || st.toX;
      const mapY = opts?.toY || st.toY;
      if (typeof mapX !== 'function' || typeof mapY !== 'function') {
        wrap._ddActiveTrajPixels = null;
        wrap._ddTrajRenderCache = null;
        historyGroup.innerHTML = '';
        return;
      }

      const source = this._datasetDiagSource?.();
      const cacheKey = source ? this._datasetDiagDetailCacheKey?.(source, targetId) : '';
      const detail = cacheKey ? this._datasetDiagDetailCache?.get?.(cacheKey) : null;
      const traj = Array.isArray(detail?.trajectory) ? detail.trajectory : [];
      if (traj.length < 2) {
        wrap._ddActiveTrajPixels = null;
        wrap._ddTrajRenderCache = null;
        historyGroup.innerHTML = '';
        return;
      }

      const pts = traj
        .filter(p => Number.isFinite(p?.mean_residual) && Number.isFinite(p?.slope))
        .map(p => {
          const spec = this._ddScatterDotSpec ? this._ddScatterDotSpec(p.status) : { r: 4.0 };
          return {
            ...p,
            px: mapX(p.mean_residual),
            py: mapY(p.slope),
            r: spec.r,
            color: this._ddStatusDotColor(p.status),
          };
        });
      const n = pts.length;
      if (n < 2) {
        wrap._ddActiveTrajPixels = null;
        wrap._ddTrajRenderCache = null;
        historyGroup.innerHTML = '';
        return;
      }

      wrap._ddActiveTrajPixels = pts.map(p => ({ cx: p.px, cy: p.py }));

      const parts = [];
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const op = (0.26 + 0.44 * ((i + 1) / (n - 1))).toFixed(2);
        parts.push(
          `<line class="m-dd-hist-seg" x1="${a.px.toFixed(1)}" y1="${a.py.toFixed(1)}" x2="${b.px.toFixed(1)}" y2="${b.py.toFixed(1)}" style="stroke:${b.color};opacity:${op}"/>`
        );
      }
      for (let i = 0; i < n - 1; i++) {
        const p = pts[i];
        const op = (0.24 + 0.26 * (i / Math.max(1, n - 2))).toFixed(2);
        parts.push(
          `<circle class="m-dd-hist-node" cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="${p.r.toFixed(1)}" style="fill:${p.color};opacity:${op}"/>`
        );
      }

      const epWord = this.tMonitor('ddEpochLabel');
      const placed = [];
      const chosenLabelIndices = [];
      const tryLabel = (idx, minDx, minDy = 14) => {
        const p = pts[idx];
        const minX = st.padL + 24;
        const maxX = Math.max(minX, st.padL + st.plotW - 24);
        const lx = Math.max(minX, Math.min(maxX, p.px));
        const ly = Math.max(st.padT + 10, p.py - (p.r + 4.5));
        if (placed.some(q => Math.abs(q.x - lx) < minDx && Math.abs(q.y - ly) < minDy)) return;
        placed.push({ x: lx, y: ly });
        chosenLabelIndices.push(idx);
        const op = (0.58 + 0.32 * (idx / (n - 1))).toFixed(2);
        parts.push(
          `<text class="m-dd-hist-label m-dd-text-halo" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" style="opacity:${op}">${this.esc(epWord)} ${p.epoch}</text>`
        );
      };

      tryLabel(0, 0, 0);
      tryLabel(n - 1, 44, 14);
      for (let i = 1; i < n - 1; i++) {
        if (pts[i].status !== pts[i - 1].status) tryLabel(i, 52, 15);
      }
      for (let i = 1; i < n - 1; i++) {
        tryLabel(i, 52, 15);
      }

      historyGroup.innerHTML = parts.join('');
      if (typeof historyGroup.querySelectorAll === 'function') {
        const segEls = Array.from(historyGroup.querySelectorAll('.m-dd-hist-seg'));
        const nodeEls = Array.from(historyGroup.querySelectorAll('.m-dd-hist-node'));
        const textEls = Array.from(historyGroup.querySelectorAll('.m-dd-hist-label'));
        const labelInfos = chosenLabelIndices.map((idx, i) => (textEls[i] ? { idx, el: textEls[i] } : null)).filter(Boolean);
        wrap._ddTrajRenderCache = {
          targetId,
          pts,
          segEls,
          nodeEls,
          labelInfos,
          padL: st.padL,
          plotW: st.plotW,
          padT: st.padT,
        };
      }
      if (!opts?.toX && !opts?.skipPopReposition && wrap._ddPinnedDot && !wrap._ddPopHovered && !wrap._ddPan?.active && !wrap._ddPopDetached && !wrap._ddZoomAnimRaf) {
        this._ddUpdatePinnedPopPosition?.(wrap, { wasHidden: false });
      }
    },

    _pinDatasetDiagScatterCard(wrap, dot) {
      if (!wrap || !dot) return;
      const svg = wrap.querySelector?.('[data-dd-hero-svg]');
      if (!svg) return;
      const t = k => this.tMonitor(k);
      const stage = wrap.querySelector?.('[data-dd-hero-stage]');
      const pop = wrap.querySelector?.('[data-dd-preview-pop]');
      const prevId = wrap._ddPinnedDot?.image_id || '';
      const dotChanged = prevId !== dot.image_id;

      wrap._ddHoverZone = null;
      wrap._ddPinnedDot = dot;
      wrap._ddHoverDot = dot;
      wrap._ddActiveDot = dot;
      this._ddSyncActiveDotState(wrap);
      wrap._ddPopDetached = false;
      wrap._ddPopRepositionPending = false;
      wrap.classList?.add?.('is-hovering');
      stage?.classList?.add?.('has-preview-snap');
      this._ddSyncScatterFocusVisuals(wrap, svg, dot);

      if (dotChanged) {
        this._prefetchDatasetDiagPreviewDetail?.(dot.image_id);
        this._syncDatasetDiagNoiseOverlay?.();
      }
      this._syncDatasetDiagScatterTrajectory(wrap, { skipPopReposition: true });
      if (pop) {
        const wasPopHidden = !!pop.hidden;
        this._ddPopulatePreviewPop(pop, dot, t);
        pop.classList?.add?.('is-pinned');
        pop.hidden = false;
        this._ddUpdatePinnedPopPosition(wrap, { wasHidden: wasPopHidden });
      }
      this._updateDatasetDiagPinTether(wrap);
      this._syncDatasetDiagStatusHighlight?.(wrap.closest?.('.m-tab-panel[data-tab="dataset"]'));
    },

    _unpinDatasetDiagScatterCard(wrapArg) {
      const wrap = wrapArg
        || globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"] [data-dd-hero-wrap][data-mode="quadrant"]');
      if (!wrap) return;
      wrap._ddPinnedDot = null;
      wrap._ddPopHovered = false;
      wrap._ddPopDetached = false;
      wrap._ddPopRepositionPending = false;
      wrap._ddActiveTrajPixels = null;
      wrap._ddTrajRenderCache = null;
      this._ddSyncActiveDotState(wrap);
      const pop = wrap.querySelector?.('[data-dd-preview-pop]');
      if (pop) {
        pop.classList?.remove?.('is-pinned', 'is-no-media', 'is-moving');
        pop._ddPopPlacement = null;
        pop._ddPopVAlign = null;
        pop.hidden = true;
      }
      const tether = wrap.querySelector?.('[data-dd-pin-tether]');
      tether?.setAttribute?.('display', 'none');
      this._clearDatasetDiagHeroHover(wrap);
    },

    _applyDatasetDiagScatterHover(wrap, best, forceRefresh = false) {
      if (!best) return;
      if (wrap._ddPinnedDot && !forceRefresh) {
        wrap._ddHoverDot = best;
        wrap._ddActiveDot = wrap._ddPinnedDot;
        this._ddSyncActiveDotState(wrap);
        return;
      }
      if (!forceRefresh && wrap._ddHoverDot === best && !wrap._ddPinnedDot) return;
      const prevId = wrap._ddActiveDot?.image_id || '';
      const dotChanged = prevId !== best.image_id;
      const svg = wrap.querySelector('[data-dd-hero-svg]');
      if (!svg) return;
      const stage = wrap.querySelector('[data-dd-hero-stage]');
      const pop = wrap.querySelector('[data-dd-preview-pop]');
      wrap._ddHoverZone = null;
      wrap.classList.add('is-hovering');
      wrap._ddHoverDot = best;
      wrap._ddActiveDot = wrap._ddPinnedDot || best;
      this._ddSyncActiveDotState(wrap);
      stage?.classList.add('has-preview-snap');
      this._ddSyncScatterFocusVisuals(wrap, svg, wrap._ddActiveDot);
      if (pop && !wrap._ddPinnedDot) {
        pop.classList?.remove?.('is-pinned', 'is-moving');
        pop.hidden = true;
      }
      if (dotChanged) {
        this._prefetchDatasetDiagPreviewDetail?.(best.image_id);
        this._syncDatasetDiagNoiseOverlay?.();
      }
      this._syncDatasetDiagScatterTrajectory(wrap);
      if (dotChanged || forceRefresh) {
        this._syncDatasetDiagStatusHighlight?.(wrap.closest?.('.m-tab-panel[data-tab="dataset"]'));
      }
    },

    _refreshDatasetDiagActiveHover(wrap, opts = {}) {
      const st = wrap?._ddChartState;
      if (!st) return;
      if (st.kind === 'timestep' && wrap._ddActiveBar?.bin != null) {
        const nextBar = st.coords.find(c => c.bin === wrap._ddActiveBar.bin || (c.tFrom <= wrap._ddActiveBar.tFrom + 1e-6 && c.tTo >= wrap._ddActiveBar.tTo - 1e-6));
        if (!nextBar) this._clearDatasetDiagHeroHover(wrap);
        else this._ddApplyTimestepBinHover(wrap, nextBar, wrap._ddHoverMeta || null);
        return;
      }
      if (st.kind === 'scatter' && wrap._ddPinnedDot?.image_id) {
        const nextDot = st.coords.find(pt => pt.image_id === wrap._ddPinnedDot.image_id);
        if (!nextDot) {
          this._unpinDatasetDiagScatterCard(wrap);
          return;
        }
        wrap._ddPinnedDot = nextDot;
        wrap._ddHoverDot = nextDot;
        wrap._ddActiveDot = nextDot;
        this._ddSyncActiveDotState(wrap);
        const svg = wrap.querySelector?.('[data-dd-hero-svg]');
        const pop = wrap.querySelector?.('[data-dd-preview-pop]');
        this._ddSyncScatterFocusVisuals(wrap, svg, nextDot);
        this._syncDatasetDiagScatterTrajectory(wrap, { skipPopReposition: true });
        if (pop) {
          this._ddPopulatePreviewPop(pop, nextDot, k => this.tMonitor(k));
          if (wrap._ddPan?.active) {
            wrap._ddPopDetached = true;
            pop.classList?.remove?.('is-moving');
          } else if (opts.settleAfterViewport) {
            wrap._ddPopDetached = true;
            this._ddSettlePinnedPopAfterViewportChange(wrap);
          } else if (wrap._ddPopHovered) {
            wrap._ddPopRepositionPending = true;
          } else if (wrap._ddPopDetached) {
            if (this._ddPinnedPopCoversDot(wrap, nextDot)) {
              wrap._ddPopDetached = false;
              wrap._ddPopRepositionPending = false;
              this._ddUpdatePinnedPopPosition(wrap, { wasHidden: !!pop.hidden, immediate: Boolean(opts.immediate) });
            }
          } else {
            wrap._ddPopRepositionPending = false;
            this._ddUpdatePinnedPopPosition(wrap, {
              wasHidden: !!pop.hidden,
              immediate: Boolean(opts.immediate),
            });
          }
        }
        this._updateDatasetDiagPinTether(wrap);
        this._syncDatasetDiagStatusHighlight?.(wrap.closest?.('.m-tab-panel[data-tab="dataset"]'));
        return;
      }
      if (st.kind === 'scatter' && (wrap._ddHoverDot?.image_id || wrap._ddActiveDot?.image_id)) {
        const hoverId = wrap._ddHoverDot?.image_id || wrap._ddActiveDot?.image_id;
        const nextDot = st.coords.find(pt => pt.image_id === hoverId);
        if (!nextDot) this._clearDatasetDiagHeroHover(wrap);
        else this._applyDatasetDiagScatterHover(wrap, nextDot, true);
      }
    },

    _updateDatasetDiagHeroHover(wrap, x, y) {
      const st = wrap._ddChartState;
      if (!st) return;

      if (st.kind === 'timestep') {
        if (!st.coords.length || x < st.padL - 4 || x > st.padL + st.plotW + 4) {
          this._clearDatasetDiagHeroHover(wrap);
          return;
        }
        const clampedX = Math.max(st.padL, Math.min(st.padL + st.plotW, x));
        const ratio = Math.max(0, Math.min(0.999999, (clampedX - st.padL) / Math.max(1, st.plotW)));
        const idx = Math.max(0, Math.min(st.coords.length - 1, Math.floor(ratio * st.coords.length)));
        const exact = st.coords[idx];
        if (!exact) {
          this._clearDatasetDiagHeroHover(wrap);
          return;
        }
        let targetBar = exact;
        let excludedHover = Boolean(exact.excluded);
        let focusX = clampedX;
        if (!excludedHover) {
          if (!(exact.count > 0 || exact.non_finite_count > 0)) {
            let bestDist = Infinity;
            for (const c of st.coords) {
              if (c.excluded || !(c.count > 0 || c.non_finite_count > 0)) continue;
              const d = Math.abs(c.xCenter - clampedX);
              if (d < bestDist) {
                bestDist = d;
                targetBar = c;
              }
            }
          }
          focusX = targetBar.xCenter;
        }
        if (wrap._ddActiveBar === targetBar && !excludedHover && wrap._ddHoverMeta?.excludedHover === false) return;
        this._ddApplyTimestepBinHover(wrap, targetBar, { excludedHover, focusX });
        return;
      }

      const stage = wrap.querySelector('[data-dd-hero-stage]');
      const best = this._ddHitTestScatterDot(st, x, y, wrap._ddLiveDotCoords);
      if (!best) {
        const zone = this._ddHitTestScatterZone(st, x, y);
        const nextZone = zone?.preset || null;
        const prevZone = wrap._ddHoverZone || null;
        wrap._ddHoverZone = nextZone;
        stage?.classList.toggle('has-zone-hover', !!nextZone);
        if (!wrap._ddPinnedDot) this._clearDatasetDiagHeroHover(wrap);
        if (prevZone !== nextZone) {
          this._syncDatasetDiagStatusHighlight?.(wrap.closest?.('.m-tab-panel[data-tab="dataset"]'));
        }
        return;
      }
      wrap._ddHoverZone = null;
      stage?.classList.remove('has-zone-hover');
      this._applyDatasetDiagScatterHover(wrap, best, false);
    },

    _clearDatasetDiagHeroHover(wrap) {
      if (!wrap._ddActiveDot && !wrap._ddHoverDot && !wrap._ddPinnedDot && !wrap._ddActiveBar) return;
      const hadDot = !!(wrap._ddActiveDot || wrap._ddHoverDot || wrap._ddPinnedDot);
      const stKind = wrap._ddChartState?.kind;
      wrap.classList.remove('is-hovering');
      wrap._ddActiveDot = null;
      wrap._ddHoverDot = null;
      wrap._ddPinnedDot = null;
      this._ddSyncActiveDotState(wrap);
      wrap._ddPopHovered = false;
      wrap._ddPopDetached = false;
      wrap._ddPopRepositionPending = false;
      wrap._ddActiveTrajPixels = null;
      wrap._ddTrajRenderCache = null;
      wrap._ddActiveBar = null;
      wrap._ddHoverMeta = null;
      wrap._ddPopAnchor = null;
      wrap.querySelector('[data-dd-hero-stage]')?.classList.remove('has-preview-snap');
      const svg = wrap.querySelector('[data-dd-hero-svg]');
      svg?.querySelector('[data-dd-crosshair]')?.setAttribute('display', 'none');
      svg?.querySelector('[data-dd-dot-focus]')?.setAttribute('display', 'none');
      svg?.querySelector('[data-dd-pin-tether]')?.setAttribute('display', 'none');
      const tsCh = svg?.querySelector('[data-dd-ts-crosshair]');
      if (tsCh) {
        tsCh.setAttribute('display', 'none');
        tsCh.classList?.remove?.('is-moving');
      }
      svg?.querySelector('[data-dd-ts-focus-base]')?.setAttribute('display', 'none');
      svg?.querySelector('[data-dd-ts-focus-comp]')?.setAttribute('display', 'none');
      svg?.querySelectorAll('.m-dd-ts-density-bar.is-hovered').forEach(el => el.classList.remove('is-hovered'));
      if (stKind === 'timestep') {
        wrap.querySelectorAll('[data-dd-zone-col]').forEach(el => el.classList.remove('is-zone-hover'));
      }
      const tipEl = wrap.querySelector('[data-dd-ts-tooltip]');
      if (tipEl) {
        tipEl.classList?.remove?.('is-moving');
        tipEl.hidden = true;
      }
      const pop = wrap.querySelector('[data-dd-preview-pop]');
      if (pop) {
        pop.classList?.remove?.('is-pinned', 'is-no-media', 'is-moving');
        pop._ddPopPlacement = null;
        pop._ddPopVAlign = null;
        pop.hidden = true;
      }
      if (hadDot && stKind === 'scatter') {
        this._syncDatasetDiagScatterTrajectory?.(wrap);
        this._cancelDatasetDiagPreviewFetch?.();
        this._syncDatasetDiagNoiseOverlay?.();
        this._syncDatasetDiagStatusHighlight?.(wrap.closest?.('.m-tab-panel[data-tab="dataset"]'));
      }
    },
  };
})();
