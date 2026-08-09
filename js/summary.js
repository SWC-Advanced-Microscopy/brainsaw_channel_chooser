/* The summary plot: every fluorophore's excitation at a glance.
 *
 * Rows are fluorophores, columns are 20 nm bins of excitation wavelength with
 * the LONG wavelengths on the left, and each row is scaled to its own peak. It
 * answers "what could I excite around here", which the line chart does not:
 * forty curves on one pair of axes is a ball of wool.
 *
 * The one rule that shapes the code: where the underlying data is coarser than
 * a bin, nothing is interpolated. A curve measured every 20 nm knows nothing
 * about what happens in between, and drawing a smooth ramp there would be this
 * page inventing numbers. Each bin instead takes the nearest measurement, so a
 * point every 60 nm paints three bins of the same colour and the coarseness is
 * visible rather than hidden.
 */
(function (SV) {
  'use strict';

  var BIN = 20;
  var LO = 760, HI = 1080;          // the range worth showing: no laser on a
                                    // BrainSaw is used outside it
  var CELL_H = 19, CELL_W = 27;
  var LABEL_W = 132, PAD = 14;
  var GAP = 5;                      // between the three blocks, as asked
  var AXIS_H = 30;
  var TOP_AXIS_H = 18;   // the same scale again above the first block

  /* The column edges: [[760, 780], [780, 800], …] across LO..HI. One place to
   * change the resolution of the whole plot. */
  function bins() {
    var out = [];
    for (var x = LO; x + BIN <= HI + 0.5; x += BIN) out.push([x, x + BIN]);
    return out;
  }

  /* One row of values, 0..1 against the fluorophore's own peak, or null where
   * there is no data. `sparse` curves are filled from the nearest measurement
   * rather than sampled, and never beyond half a step past the end ones. */
  function rowFor(curve, sparse, cols) {
    var raw = cols.map(function (c) {
      var mid = (c[0] + c[1]) / 2;
      if (sparse && curve.pts && curve.pts.length) {
        /* Each measurement speaks for the wavelengths nearer to it than to its
         * neighbours, and at the two ends for one bin's width and no further -
         * a dye measured at 920 nm says nothing about 960. With points every
         * 60 nm that paints three bins centred on each measurement, which is
         * the coarseness the measurement actually has. */
        var pts = curve.pts;
        for (var i = 0; i < pts.length; i++) {
          var back = i > 0 ? (pts[i][0] + pts[i - 1][0]) / 2 : pts[i][0] - BIN / 2;
          var fwd = i < pts.length - 1 ? (pts[i][0] + pts[i + 1][0]) / 2 : pts[i][0] + BIN / 2;
          if (mid >= back && mid <= fwd) return Math.max(0, pts[i][1]);
        }
        return null;
      }
      if (c[1] < curve.x0 || c[0] > curve.x1) return null;
      var sum = 0, n = 0;
      for (var w = c[0]; w <= c[1]; w += 2) {
        if (w < curve.x0 || w > curve.x1) continue;
        sum += Math.max(0, curve.at(w)); n++;
      }
      return n ? sum / n : null;
    });
    var peak = raw.reduce(function (m, v) { return v == null ? m : Math.max(m, v); }, 0);
    if (!peak) return raw.map(function () { return null; });
    return raw.map(function (v) { return v == null ? null : v / peak; });
  }

  /* Sequential single hue, pale to deep. One hue, because the number being
   * shown is a magnitude and nothing else. */
  function shade(v) {
    var t = Math.max(0, Math.min(1, v));
    // eased so the low end is still legible against the page
    var e = Math.pow(t, 0.75);
    var r = Math.round(247 - 200 * e);
    var g = Math.round(251 - 156 * e);
    var b = Math.round(255 - 90 * e);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* Ink that stays legible on shade(v) - white once the fill is dark enough. */
  function textFor(v) { return v > 0.62 ? '#ffffff' : '#1b2430'; }

  /* One wavelength scale. `dir` is +1 for the axis under the last block and -1
   * for the one over the first, which is the same scale mirrored. Labelled
   * every other bin so the numbers do not collide. */
  function axis(c, x0, y, cols, dir) {
    c.strokeStyle = '#c9c9c4';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x0, y + dir * 0.5);
    c.lineTo(x0 + cols.length * CELL_W - 1, y + dir * 0.5);
    c.stroke();
    c.fillStyle = '#4a5260';
    c.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    c.textAlign = 'center';
    cols.forEach(function (col, i) {
      if (i % 2) return;
      var cx = x0 + i * CELL_W + CELL_W / 2;
      c.beginPath();
      c.moveTo(cx, y); c.lineTo(cx, y + dir * 4);
      c.stroke();
      c.fillText(String(col[0]), cx, y + dir * 11);
    });
  }

  /* Draw the whole plot onto a new canvas and return it, ready to be turned
   * into a PNG. Nothing is added to the document, and nothing is interactive.
   *
   * groups: [{ rows: [{ name, curve, sparse, color }] }] - one block per group,
   * drawn in order with a gap between them. opts.scale is the pixel density,
   * 2 for a crisp image in a popup window or a saved file. */
  function draw(groups, opts) {
    var cols = bins();
    var scale = opts.scale || 2;
    var nRows = groups.reduce(function (n, g) { return n + g.rows.length; }, 0);
    var w = LABEL_W + cols.length * CELL_W + PAD * 2;
    var h = PAD + TOP_AXIS_H + nRows * CELL_H + (groups.length - 1) * GAP + AXIS_H + PAD;

    var cv = document.createElement('canvas');
    cv.width = w * scale; cv.height = h * scale;
    var c = cv.getContext('2d');
    c.scale(scale, scale);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    c.textBaseline = 'middle';

    var x0 = PAD + LABEL_W;
    var y = PAD + TOP_AXIS_H;

    /* The scale runs along the top as well as the bottom: with forty rows the
     * bottom one is off the screen by the time you are reading the middle. */
    axis(c, x0, y, cols, -1);

    groups.forEach(function (g, gi) {
      g.rows.forEach(function (row) {
        var vals = rowFor(row.curve, row.sparse, cols);
        c.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        // named in its own emission colour, the way the rest of the page
        // colours a fluorophore
        c.fillStyle = row.color || '#1b2430';
        c.textAlign = 'right';
        c.fillText(row.name, x0 - 8, y + CELL_H / 2, LABEL_W - 12);
        vals.forEach(function (v, i) {
          var cx = x0 + i * CELL_W;
          if (v == null) {
            c.fillStyle = '#f2f2f0';
            c.fillRect(cx, y, CELL_W - 1, CELL_H - 1);
            c.strokeStyle = '#e0e0dc';
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(cx + 1, y + CELL_H - 2);
            c.lineTo(cx + CELL_W - 2, y + 1);
            c.stroke();
          } else {
            c.fillStyle = shade(v);
            c.fillRect(cx, y, CELL_W - 1, CELL_H - 1);
          }
        });
        y += CELL_H;
      });
      if (gi < groups.length - 1) y += GAP;
    });

    axis(c, x0, y, cols, 1);
    c.textAlign = 'right';
    c.fillStyle = '#4a5260';
    c.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    c.fillText('excitation wavelength (nm)', x0 + cols.length * CELL_W - 1, y + 24);

    return cv;
  }

  SV.summaryPlot = { draw: draw, bins: bins, rowFor: rowFor, shade: shade, textFor: textFor, LO: LO, HI: HI, BIN: BIN };
}(window.SV = window.SV || {}));
