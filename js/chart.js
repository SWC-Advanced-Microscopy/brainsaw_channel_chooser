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
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS PUT TOGETHER
 *
 * One canvas per chart, redrawn in full on every change. There is no scene
 * graph, no dirty-region tracking and no animation: a redraw is a few thousand
 * line segments and takes well under a frame, so the simplest thing that works
 * is also fast enough. Everything you see is therefore a pure function of
 * (series, zones, markers, hoverX, view) - if the picture is wrong, one of
 * those five is wrong, and nothing is cached in between.
 *
 * The one piece of DOM besides the canvas is the tooltip, which is an absolutely
 * positioned div rather than drawn text: it needs text selection, wrapping and
 * the page's own fonts and colours.
 *
 * Everything a Curve must provide (see js/curves.js): at(x), peak(lo, hi),
 * isEmpty(), x0, x1, and .pts for the sparse case. Any object with those works;
 * the chart never looks inside.
 *
 * DRAW ORDER, back to front, because it is what makes the layering read:
 *   zones -> grid -> [clip] band fills -> area fills -> lines [/clip] ->
 *   markers -> axes -> spectral rail -> peak labels -> hover -> zoom selection
 * Fills and lines are drawn inside a clip so a curve running off the top of a
 * zoomed view is cut off cleanly rather than scribbling over the axis labels.
 *
 * COORDINATES. plotRect() is the drawing area inside the padding; sx()/sy() map
 * data to pixels and ix() maps back. The x mapping uses `view`, which zooming
 * changes, and the y mapping uses `opts`, which it does not - this chart zooms
 * in x only, because a spectrum's y axis is already 0..1 or 0..peak.
 *
 * HIGH DPI. The canvas backing store is sized in device pixels and the context
 * scaled once in resize(), so every coordinate in this file is CSS pixels.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API
 *
 *   new SV.Chart(container, opts)   opts described on the constructor
 *   setSeries / setZones / setMarkers   replace a whole layer and redraw
 *   setYRange(min, max) / setXRange(min, max)
 *   resetZoom() / isZoomed()
 *   render()                        force a redraw (theme changes, say)
 *   resize()                        called automatically by a ResizeObserver
 *   toPNG(scale)                    data: URL, on an opaque background
 *   destroy()                       drop the ResizeObserver
 *
 * A SERIES is a plain object. Only `curve` and `color` are required:
 *   curve      an SV.Curve
 *   color      any CSS colour string
 *   label      shown in the tooltip and the page's legend
 *   kind       'line' (default) | 'area' | 'band'. A band is a filter's
 *              transmission: filled and outlined, drawn behind everything else.
 *   width      line width in px, default 2
 *   dash       setLineDash pattern, e.g. [5, 4]
 *   fill       fill under a line as well as stroking it
 *   fillAlpha  opacity of that fill
 *   gradient   fill with the colours of the light itself (emission curves)
 *   points     [[x, y], ...] to mark with dots, for sparse measured data
 *   peakLabel  text to write at the curve's maximum
 *   hidden     skip it entirely; dimmed: draw it at 28% and skip its label
 *   noTip      leave it out of the hover readout
 *   id         the page's handle for it, e.g. for legend toggling
 * Anything else you hang on a series is passed back to tipFormat untouched.
 *
 * A ZONE is { x0, x1, color, label } - a background band naming a region of the
 * x axis ("outside laser range"). A MARKER is a vertical line:
 * { x, color, width, dash, label, labelColor, draggable, id }.
 */
(function (SV) {
  'use strict';

  /* Capped at 2: beyond that the extra pixels cost real time on a 3x phone and
   * buy nothing on a chart made of thin lines. */
  var DPR = function () { return Math.min(window.devicePixelRatio || 1, 2); };

  /* Build a chart inside `container`, which it fills and whose size it follows.
   *
   * opts, all optional:
   *   xMin, xMax, yMin, yMax   data ranges; x also becomes the zoom-out extent
   *   xLabel, yLabel           axis captions
   *   padding                  {top, right, bottom, left} in px around the plot
   *   spectralRail             draw a visible-spectrum strip under the x axis
   *   yTickFormat(v)           -> string for a y tick
   *   tipFormat(v, series)     -> string for one tooltip row
   *   onMarkerDrag(marker, x)  a draggable marker was moved to x (already
   *                            rounded to 1 nm and clamped to the view)
   *   onZoom(chart)            the x view changed, by drag or double-click
   */
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

  /* The page's colours, read off the container's computed style so the chart
   * follows the stylesheet and the light/dark toggle without being told. Read
   * fresh on every render because a theme change is just new CSS variables. */
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

  /* Match the backing store to the container's size in device pixels, then set
   * the transform so all drawing code can work in CSS pixels. Called by the
   * ResizeObserver, so nothing else needs to know when the layout moves. */
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

  /* The drawing area: {x, y, w, h} inside the padding, plus `rail`, the height
   * reserved under it for the spectral strip (0 when there is none). Cheap
   * enough to call per draw call rather than cache and have to invalidate. */
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

  /* Data to pixels and back. sx uses the zoomable x view; sy uses the fixed y
   * range; ix(px) is sx inverted, for turning a pointer position into nm. */
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

  /* Each of the three layers is replaced wholesale rather than added to: the
   * page rebuilds its list from state every time, so there is nothing to
   * diff and no way for a stale series to survive a change. */
  Chart.prototype.setSeries = function (series) { this.series = series || []; this.render(); };
  Chart.prototype.setZones = function (zones) { this.zones = zones || []; this.render(); };
  Chart.prototype.setMarkers = function (markers) { this.markers = markers || []; this.render(); };
  /* New y range, e.g. when the excitation panel switches from % to GM. */
  Chart.prototype.setYRange = function (min, max) {
    this.opts.yMin = min; this.opts.yMax = max; this.render();
  };
  /* New x range. Also resets the zoom, since the extent it zooms out to is
   * exactly this. */
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

  /* About `target` ticks between min and max, on a step from the 1/2/2.5/5/10
   * series so the labels are numbers a person would have chosen. Returns the
   * tick values; exported as SV.niceTicks because the summary plot wants the
   * same ones. */
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

  /* Redraw everything, in the layer order set out at the top of the file. Safe
   * to call as often as you like; it is what every setter does. */
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

  /* Background bands naming a stretch of the x axis. First thing drawn, so
   * everything else sits on top of them. The label is dropped when the band is
   * too narrow to hold it rather than clipped or shrunk. */
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

  /* Grid lines, and the only place the tick positions are worked out: they are
   * stashed on the instance for _drawAxes to label, so the two can never
   * disagree. The half-pixel offsets keep 1 px lines from landing across two
   * device pixels and going grey. x tick density follows the plot width. */
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

  /* Lay a curve into the current path, clipped to the visible x range and
   * sampled at one point per horizontal pixel - so the cost of drawing depends
   * on the width of the chart, not on how densely the curve was measured. A
   * 1 nm FPbase spectrum and a five-point measurement cost the same.
   *
   * `clampBaseline` stops the path dipping below y=yMin, which matters when the
   * same path is being closed into a fill. Returns false if the curve does not
   * appear in the current view at all. */
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

  /* Draw the series belonging to one `phase`: 'band', then 'area', then 'line'.
   *
   * Three passes over the whole list rather than one pass drawing each series
   * completely, because the layering has to be global - every filter band
   * belongs behind every fluorophore fill, which belongs behind every line. One
   * pass would put each series' own fill over its neighbour's line.
   *
   * Dimmed series are drawn at 28% here rather than by fading their colour, so
   * the fill and the stroke fade together and by the same amount. */
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

  /* Fill under an emission curve with the colours of the light it emits: a
   * horizontal gradient sampled at 12 stops across the curve's visible span,
   * each stop the sRGB of that wavelength at `alpha`. Twelve is enough because
   * the hue changes slowly and the browser interpolates between stops. */
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

  /* Vertical lines with a pill label above the plot, kept inside the plot's
   * width so a marker near either edge does not hang off the canvas. A
   * draggable one gets a grab handle on the baseline; that dot is also what the
   * hit test in _bind() is aiming at. */
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

  /* The baseline, the tick labels at the positions _drawGrid worked out, and
   * the two axis captions. There is no y axis line - the grid already carries
   * the eye, and a spine as well is one mark too many. */
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

  /* The visible-spectrum strip under the emission chart's x axis, a column of
   * 1 px fills so it follows any zoom for free. Slightly overdrawn (1.5 px
   * wide) to avoid seams between columns on fractional device pixels. */
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
   * palette slots, and it means identity is never carried by colour alone.
   *
   * Collisions are resolved by the crudest thing that works: place labels top
   * down, and nudge each one 13 px lower until it clears everything already
   * placed, giving up after 24 tries. With a handful of curves this is
   * imperceptible, and it degrades into a neat column rather than a pile. */
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

  /* The crosshair, a dot on every curve it crosses, and the tooltip listing
   * them biggest first (nine at most - past that it is a wall of text and the
   * small values are not what anyone is reading). Curves are skipped where the
   * hover sits outside their measured range, so "no row" means "not measured
   * here" rather than "zero". The tooltip flips to the left of the cursor when
   * it would otherwise run off the right edge. */
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

  /* The rubber band during a drag-to-zoom. In pixels, not data units, because
   * it only exists between pointerdown and pointerup. */
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

  /* All the pointer handling, bound once in the constructor.
   *
   * A press within 9 px of a draggable marker grabs it; anything else starts a
   * zoom selection, which is discarded if it ends up under 12 px wide so a
   * stray click does not zoom to nothing. Pointer capture means a drag that
   * leaves the canvas still tracks and still ends. Double-click zooms out.
   *
   * Dragging a marker rounds to whole nm and calls back on every change, which
   * is what makes the page's numbers move with the marker rather than after it.
   * Everything here works for touch and pen as well, because these are pointer
   * events and not mouse events. */
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

  /* The chart as a PNG data: URL at `scale`x (default 2), drawn onto an opaque
   * background first - the live canvas is transparent so the page shows
   * through, and a transparent PNG dropped into a document or a talk is a
   * chart nobody can read. Whatever is on screen is what you get, zoom and
   * hidden series included. */
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

  /* Stop following the container. The listeners go with the canvas when the
   * container is emptied; the observer would not. */
  Chart.prototype.destroy = function () { this._ro.disconnect(); };

  /* ------------------------------------------------------------ helpers */

  /* Rounded rectangle path, using the native roundRect where it exists and
   * four arcs where it does not. Leaves the path for the caller to fill. */
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

  /* The tooltip is built as HTML, so anything from the data - a fluorophore or
   * filter name - goes through here first. Exported, because the rest of the
   * page writes innerHTML for the same reasons and needs the same guard. */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  SV.Chart = Chart;
  SV.escapeHtml = escapeHtml;
  SV.niceTicks = niceTicks;
})(window.SV || (window.SV = {}));
