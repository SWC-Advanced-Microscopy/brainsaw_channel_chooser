/* Canvas spectra chart.
 *
 * Deliberately hand-rolled rather than pulled from a plotting library: the two
 * charts here need spectrally-coloured fills, filter transmission bands drawn
 * behind line series, a draggable laser marker and a wavelength rail, and every
 * general-purpose library makes at least one of those a fight.
 *
 * Both charts use a SINGLE y axis. Series that would otherwise need a second
 * scale (laser tuning curve, filter transmission) are expressed in the same
 * relative/percentage units as everything else, or moved to their own panel.
 */
(function (SV) {
  'use strict';

  var DPR = function () { return Math.min(window.devicePixelRatio || 1, 2); };

  function Chart(container, opts) {
    this.opts = Object.assign({
      xMin: 400, xMax: 800, yMin: 0, yMax: 1,
      xLabel: 'Wavelength (nm)', yLabel: '',
      padding: { top: 18, right: 26, bottom: 46, left: 58 },
      spectralRail: false,
      yTickFormat: function (v) { return String(Math.round(v * 100)); },
      onMarkerDrag: null,
      tipFormat: null,
    }, opts || {});

    this.container = container;
    this.series = [];
    this.zones = [];
    this.markers = [];
    this.hoverX = null;
    this.dragSel = null;
    this.dragMarker = null;
    this.view = { xMin: this.opts.xMin, xMax: this.opts.xMax };

    container.classList.add('sv-chart');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sv-canvas';
    container.appendChild(this.canvas);
    this.tip = document.createElement('div');
    this.tip.className = 'sv-tip';
    this.tip.setAttribute('role', 'status');
    container.appendChild(this.tip);
    this.ctx = this.canvas.getContext('2d');

    this._bind();
    var self = this;
    this._ro = new ResizeObserver(function () { self.resize(); });
    this._ro.observe(container);
    this.resize();
  }

  Chart.prototype.theme = function () {
    var cs = getComputedStyle(this.container);
    var pick = function (name, fallback) {
      var v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    return {
      text: pick('--text-primary', '#111'),
      sub: pick('--text-secondary', '#666'),
      muted: pick('--text-muted', '#999'),
      grid: pick('--grid', 'rgba(0,0,0,.08)'),
      axis: pick('--axis', 'rgba(0,0,0,.25)'),
      surface: pick('--surface-1', '#fff'),
      dark: document.documentElement.dataset.resolvedTheme === 'dark',
    };
  };

  Chart.prototype.resize = function () {
    var r = this.container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var d = DPR();
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * d);
    this.canvas.height = Math.round(r.height * d);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.render();
  };

  Chart.prototype.plotRect = function () {
    var p = this.opts.padding;
    var rail = this.opts.spectralRail ? 12 : 0;
    return {
      x: p.left, y: p.top,
      w: Math.max(10, this.w - p.left - p.right),
      h: Math.max(10, this.h - p.top - p.bottom - rail),
      rail: rail,
    };
  };

  Chart.prototype.sx = function (x) {
    var r = this.plotRect();
    return r.x + (x - this.view.xMin) / (this.view.xMax - this.view.xMin) * r.w;
  };
  Chart.prototype.sy = function (y) {
    var r = this.plotRect();
    var o = this.opts;
    return r.y + r.h - (y - o.yMin) / (o.yMax - o.yMin) * r.h;
  };
  Chart.prototype.ix = function (px) {
    var r = this.plotRect();
    return this.view.xMin + (px - r.x) / r.w * (this.view.xMax - this.view.xMin);
  };

  Chart.prototype.setSeries = function (series) { this.series = series || []; this.render(); };
  Chart.prototype.setZones = function (zones) { this.zones = zones || []; this.render(); };
  Chart.prototype.setMarkers = function (markers) { this.markers = markers || []; this.render(); };
  Chart.prototype.setYRange = function (min, max) {
    this.opts.yMin = min; this.opts.yMax = max; this.render();
  };
  Chart.prototype.setXRange = function (min, max) {
    this.opts.xMin = min; this.opts.xMax = max;
    this.view = { xMin: min, xMax: max };
    this.render();
  };
  Chart.prototype.resetZoom = function () {
    this.view = { xMin: this.opts.xMin, xMax: this.opts.xMax };
    this.render();
  };
  Chart.prototype.isZoomed = function () {
    return this.view.xMin !== this.opts.xMin || this.view.xMax !== this.opts.xMax;
  };

  /* ------------------------------------------------------------- ticks */

  function niceTicks(min, max, target) {
    var span = max - min;
    if (span <= 0) return [min];
    var raw = span / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
      out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    }
    return out;
  }

  /* ------------------------------------------------------------ render */

  Chart.prototype.render = function () {
    if (!this.ctx || !this.w) return;
    var ctx = this.ctx, r = this.plotRect(), t = this.theme();
    ctx.clearRect(0, 0, this.w, this.h);

    this._drawZones(ctx, r, t);
    this._drawGrid(ctx, r, t);

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y - 4, r.w, r.h + 4);
    ctx.clip();
    this._drawSeries(ctx, r, t, 'band');
    this._drawSeries(ctx, r, t, 'area');
    this._drawSeries(ctx, r, t, 'line');
    ctx.restore();

    this._drawMarkers(ctx, r, t);
    this._drawAxes(ctx, r, t);
    if (this.opts.spectralRail) this._drawRail(ctx, r);
    this._drawPeakLabels(ctx, r, t);
    this._drawHover(ctx, r, t);
    this._drawSelection(ctx, r, t);
  };

  Chart.prototype._drawZones = function (ctx, r, t) {
    for (var i = 0; i < this.zones.length; i++) {
      var z = this.zones[i];
      var x0 = Math.max(r.x, this.sx(z.x0));
      var x1 = Math.min(r.x + r.w, this.sx(z.x1));
      if (x1 <= x0) continue;
      ctx.fillStyle = z.color;
      ctx.fillRect(x0, r.y, x1 - x0, r.h);
      if (z.label) {
        // Along the bottom, where the peak labels never go.
        ctx.save();
        ctx.fillStyle = t.muted;
        ctx.font = '500 10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        if (x1 - x0 > 60) ctx.fillText(z.label, x0 + 6, r.y + r.h - 5);
        ctx.restore();
      }
    }
  };

  Chart.prototype._drawGrid = function (ctx, r, t) {
    var xs = niceTicks(this.view.xMin, this.view.xMax, Math.max(3, Math.round(r.w / 90)));
    var ys = niceTicks(this.opts.yMin, this.opts.yMax, 5);
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < xs.length; i++) {
      var px = Math.round(this.sx(xs[i])) + 0.5;
      if (px < r.x || px > r.x + r.w) continue;
      ctx.moveTo(px, r.y); ctx.lineTo(px, r.y + r.h);
    }
    for (var j = 0; j < ys.length; j++) {
      var py = Math.round(this.sy(ys[j])) + 0.5;
      ctx.moveTo(r.x, py); ctx.lineTo(r.x + r.w, py);
    }
    ctx.stroke();
    this._xticks = xs; this._yticks = ys;
  };

  Chart.prototype._pathCurve = function (ctx, curve, r, clampBaseline) {
    var lo = Math.max(curve.x0, this.view.xMin - 2);
    var hi = Math.min(curve.x1, this.view.xMax + 2);
    if (hi <= lo) return false;
    // One sample per device pixel keeps dense curves cheap without aliasing.
    var stepPx = (this.view.xMax - this.view.xMin) / Math.max(1, r.w);
    var step = Math.max(stepPx, 0.25);
    var started = false;
    for (var x = lo; x <= hi; x += step) {
      var px = this.sx(x), py = this.sy(curve.at(x));
      if (clampBaseline) py = Math.min(py, this.sy(this.opts.yMin));
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    var pxEnd = this.sx(hi), pyEnd = this.sy(curve.at(hi));
    if (started) ctx.lineTo(pxEnd, pyEnd);
    return started;
  };

  Chart.prototype._drawSeries = function (ctx, r, t, phase) {
    for (var i = 0; i < this.series.length; i++) {
      var s = this.series[i];
      if (s.hidden || !s.curve || s.curve.isEmpty()) continue;
      var kind = s.kind || 'line';
      var isBand = kind === 'band';
      if (phase === 'band' && !isBand) continue;
      if (phase === 'area' && !(kind === 'area' || (s.fill && !isBand))) continue;
      if (phase === 'line' && isBand) continue;

      var dim = s.dimmed ? 0.28 : 1;

      if (phase !== 'line') {
        ctx.save();
        ctx.beginPath();
        var ok = this._pathCurve(ctx, s.curve, r);
        if (ok) {
          ctx.lineTo(this.sx(Math.min(s.curve.x1, this.view.xMax + 2)), this.sy(this.opts.yMin));
          ctx.lineTo(this.sx(Math.max(s.curve.x0, this.view.xMin - 2)), this.sy(this.opts.yMin));
          ctx.closePath();
          if (s.gradient) {
            ctx.fillStyle = this._spectralGradient(ctx, r, s.curve, (s.fillAlpha || 0.16) * dim);
          } else {
            ctx.fillStyle = SV.withAlpha(s.color, (s.fillAlpha || 0.14) * dim);
          }
          ctx.fill();
        }
        ctx.restore();
      }

      if (phase === 'line' || isBand) {
        ctx.save();
        ctx.globalAlpha = dim;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width || 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (s.dash) ctx.setLineDash(s.dash);
        ctx.beginPath();
        this._pathCurve(ctx, s.curve, r);
        ctx.stroke();
        ctx.restore();
      }

      /* Where a curve is a few measured samples rather than a spectrum, show
       * the samples: the straight runs between them are drawn, not measured. */
      if (phase === 'line' && s.points) {
        ctx.save();
        ctx.globalAlpha = dim;
        ctx.fillStyle = s.color;
        for (var p = 0; p < s.points.length; p++) {
          var px = this.sx(s.points[p][0]), py = this.sy(s.points[p][1]);
          if (px < r.x || px > r.x + r.w) continue;
          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  };

  /* Fill under an emission curve with the colours of the light it emits. */
  Chart.prototype._spectralGradient = function (ctx, r, curve, alpha) {
    var x0 = Math.max(curve.x0, this.view.xMin);
    var x1 = Math.min(curve.x1, this.view.xMax);
    var g = ctx.createLinearGradient(this.sx(x0), 0, this.sx(x1), 0);
    var n = 12;
    for (var i = 0; i <= n; i++) {
      var wl = x0 + (x1 - x0) * i / n;
      var rgb = SV.wavelengthRGB(wl);
      g.addColorStop(i / n, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')');
    }
    return g;
  };

  Chart.prototype._drawMarkers = function (ctx, r, t) {
    for (var i = 0; i < this.markers.length; i++) {
      var m = this.markers[i];
      var px = this.sx(m.x);
      if (px < r.x - 1 || px > r.x + r.w + 1) continue;
      ctx.save();
      ctx.strokeStyle = m.color || t.text;
      ctx.lineWidth = m.width || 2;
      if (m.dash) ctx.setLineDash(m.dash);
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, r.y);
      ctx.lineTo(Math.round(px) + 0.5, r.y + r.h);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        var tw = ctx.measureText(m.label).width;
        var bx = Math.min(Math.max(px - tw / 2 - 6, r.x), r.x + r.w - tw - 12);
        ctx.fillStyle = m.color || t.text;
        roundRect(ctx, bx, r.y - 15, tw + 12, 17, 4);
        ctx.fill();
        ctx.fillStyle = m.labelColor || '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.label, bx + 6, r.y - 6);
      }
      if (m.draggable) {
        ctx.fillStyle = m.color || t.text;
        ctx.beginPath();
        ctx.arc(px, r.y + r.h, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  };

  Chart.prototype._drawAxes = function (ctx, r, t) {
    ctx.save();
    ctx.strokeStyle = t.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + r.h + 0.5);
    ctx.lineTo(r.x + r.w, r.y + r.h + 0.5);
    ctx.stroke();

    ctx.fillStyle = t.sub;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var railGap = r.rail ? r.rail + 4 : 0;
    for (var i = 0; i < this._xticks.length; i++) {
      var v = this._xticks[i], px = this.sx(v);
      if (px < r.x - 1 || px > r.x + r.w + 1) continue;
      ctx.fillText(String(Math.round(v)), px, r.y + r.h + 6 + railGap);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var j = 0; j < this._yticks.length; j++) {
      var yv = this._yticks[j];
      ctx.fillText(this.opts.yTickFormat(yv), r.x - 8, this.sy(yv));
    }

    ctx.fillStyle = t.muted;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(this.opts.xLabel, r.x + r.w / 2, this.h - 4);
    if (this.opts.yLabel) {
      ctx.save();
      ctx.translate(12, r.y + r.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(this.opts.yLabel, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  };

  Chart.prototype._drawRail = function (ctx, r) {
    var y = r.y + r.h + 4, h = r.rail - 2;
    for (var px = 0; px < r.w; px++) {
      var wl = this.ix(r.x + px);
      var rgb = SV.wavelengthRGB(wl);
      ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      ctx.fillRect(r.x + px, y, 1.5, h);
    }
  };

  /* Direct labels at each curve's peak. Required relief for the low-contrast
   * palette slots, and it means identity is never carried by colour alone. */
  Chart.prototype._drawPeakLabels = function (ctx, r, t) {
    var boxes = [];
    for (var i = 0; i < this.series.length; i++) {
      var s = this.series[i];
      if (!s.peakLabel || s.hidden || s.dimmed || !s.curve || s.curve.isEmpty()) continue;
      var pk = s.curve.peak(Math.max(this.view.xMin, s.curve.x0), Math.min(this.view.xMax, s.curve.x1));
      if (pk.x == null || pk.y <= this.opts.yMin) continue;
      boxes.push({ s: s, x: this.sx(pk.x), y: this.sy(pk.y) - 10, text: s.peakLabel });
    }
    boxes.sort(function (a, b) { return a.y - b.y; });
    ctx.save();
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    for (var k = 0; k < boxes.length; k++) {
      var b = boxes[k];
      var w = ctx.measureText(b.text).width + 4;
      // nudge down until it clears everything already placed
      for (var attempt = 0; attempt < 24; attempt++) {
        var clash = false;
        for (var m = 0; m < k; m++) {
          var o = boxes[m];
          if (Math.abs(o.y - b.y) < 13 && Math.abs(o.x - b.x) < (w + o.w) / 2 + 6) { clash = true; break; }
        }
        if (!clash) break;
        b.y += 13;
      }
      b.w = w;
      b.x = Math.min(Math.max(b.x, r.x + w / 2), r.x + r.w - w / 2);
      b.y = Math.min(Math.max(b.y, r.y + 8), r.y + r.h - 4);
      ctx.fillStyle = SV.withAlpha(this.theme().surface, 0.72);
      roundRect(ctx, b.x - w / 2, b.y - 8, w, 15, 3);
      ctx.fill();
      ctx.fillStyle = b.s.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.text, b.x, b.y);
    }
    ctx.restore();
  };

  Chart.prototype._drawHover = function (ctx, r, t) {
    if (this.hoverX == null || this.dragSel) { this.tip.classList.remove('on'); return; }
    var px = this.sx(this.hoverX);
    if (px < r.x || px > r.x + r.w) { this.tip.classList.remove('on'); return; }

    ctx.save();
    ctx.strokeStyle = t.axis;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, r.y);
    ctx.lineTo(Math.round(px) + 0.5, r.y + r.h);
    ctx.stroke();
    ctx.restore();

    var rows = [];
    for (var i = 0; i < this.series.length; i++) {
      var s = this.series[i];
      if (s.hidden || s.noTip || !s.curve || s.curve.isEmpty()) continue;
      if (this.hoverX < s.curve.x0 || this.hoverX > s.curve.x1) continue;
      var v = s.curve.at(this.hoverX);
      if (v <= this.opts.yMin + (this.opts.yMax - this.opts.yMin) * 0.004) continue;
      rows.push({ label: s.label, color: s.color, v: v, s: s });
    }
    rows.sort(function (a, b) { return b.v - a.v; });
    rows = rows.slice(0, 9);

    if (!rows.length) { this.tip.classList.remove('on'); return; }

    // dot on each hovered curve
    ctx.save();
    for (var j = 0; j < rows.length; j++) {
      var py = this.sy(rows[j].v);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = rows[j].color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = t.surface;
      ctx.stroke();
    }
    ctx.restore();

    var fmt = this.opts.tipFormat || function (v) { return Math.round(v * 100) + '%'; };
    var html = '<div class="sv-tip-h">' + Math.round(this.hoverX) + ' nm</div>';
    for (var k = 0; k < rows.length; k++) {
      html += '<div class="sv-tip-r"><i style="background:' + rows[k].color + '"></i>' +
        '<span>' + escapeHtml(rows[k].label) + '</span><b>' + fmt(rows[k].v, rows[k].s) + '</b></div>';
    }
    this.tip.innerHTML = html;
    this.tip.classList.add('on');
    var tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    var left = px + 14;
    if (left + tw > this.w - 4) left = px - tw - 14;
    this.tip.style.left = Math.max(4, left) + 'px';
    this.tip.style.top = Math.max(4, Math.min(this.h - th - 4, r.y + 4)) + 'px';
  };

  Chart.prototype._drawSelection = function (ctx, r, t) {
    if (!this.dragSel) return;
    var a = Math.min(this.dragSel.a, this.dragSel.b);
    var b = Math.max(this.dragSel.a, this.dragSel.b);
    ctx.save();
    ctx.fillStyle = SV.withAlpha(t.text, 0.08);
    ctx.fillRect(a, r.y, b - a, r.h);
    ctx.strokeStyle = SV.withAlpha(t.text, 0.35);
    ctx.lineWidth = 1;
    ctx.strokeRect(a + 0.5, r.y + 0.5, b - a - 1, r.h - 1);
    ctx.restore();
  };

  /* ----------------------------------------------------------- pointer */

  Chart.prototype._bind = function () {
    var self = this;
    var c = this.canvas;

    var markerHit = function (px) {
      for (var i = 0; i < self.markers.length; i++) {
        if (self.markers[i].draggable && Math.abs(self.sx(self.markers[i].x) - px) < 9) {
          return self.markers[i];
        }
      }
      return null;
    };

    c.addEventListener('pointerdown', function (e) {
      var r = self.plotRect();
      var px = e.offsetX;
      if (px < r.x || px > r.x + r.w) return;
      var m = markerHit(px);
      if (m) {
        self.dragMarker = m;
        c.setPointerCapture(e.pointerId);
        c.style.cursor = 'grabbing';
        return;
      }
      self.dragSel = { a: px, b: px };
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener('pointermove', function (e) {
      var r = self.plotRect();
      var px = e.offsetX, py = e.offsetY;

      if (self.dragMarker) {
        var v = Math.round(clamp(self.ix(px), self.view.xMin, self.view.xMax));
        if (v !== self.dragMarker.x) {
          self.dragMarker.x = v;
          if (self.opts.onMarkerDrag) self.opts.onMarkerDrag(self.dragMarker, v);
          self.render();
        }
        return;
      }
      if (self.dragSel) { self.dragSel.b = px; self.render(); return; }

      c.style.cursor = markerHit(px) ? 'grab' : 'crosshair';
      var inside = px >= r.x && px <= r.x + r.w && py >= r.y - 8 && py <= r.y + r.h + 8;
      var nx = inside ? Math.round(self.ix(px)) : null;
      if (nx !== self.hoverX) { self.hoverX = nx; self.render(); }
    });

    var end = function (e) {
      if (self.dragMarker) {
        self.dragMarker = null;
        c.style.cursor = 'crosshair';
        return;
      }
      if (self.dragSel) {
        var a = Math.min(self.dragSel.a, self.dragSel.b);
        var b = Math.max(self.dragSel.a, self.dragSel.b);
        self.dragSel = null;
        if (b - a > 12) {
          var x0 = self.ix(a), x1 = self.ix(b);
          self.view = { xMin: Math.round(x0), xMax: Math.round(x1) };
          if (self.opts.onZoom) self.opts.onZoom(self);
        }
        self.render();
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('pointerleave', function () {
      if (self.hoverX !== null) { self.hoverX = null; self.render(); }
    });
    c.addEventListener('dblclick', function () {
      self.resetZoom();
      if (self.opts.onZoom) self.opts.onZoom(self);
    });
  };

  Chart.prototype.toPNG = function (scale) {
    var out = document.createElement('canvas');
    var s = scale || 2;
    out.width = this.w * s; out.height = this.h * s;
    var o = out.getContext('2d');
    o.fillStyle = this.theme().surface;
    o.fillRect(0, 0, out.width, out.height);
    o.drawImage(this.canvas, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  };

  Chart.prototype.destroy = function () { this._ro.disconnect(); };

  /* ------------------------------------------------------------ helpers */

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  SV.Chart = Chart;
  SV.escapeHtml = escapeHtml;
  SV.niceTicks = niceTicks;
})(window.SV || (window.SV = {}));
