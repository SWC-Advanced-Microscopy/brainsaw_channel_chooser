/* Curve maths and wavelength colour for the BrainSaw spectra viewer.
 *
 * Curves arrive from the build script in one of two packed forms:
 *   {x0, dx, y:[...]}  uniformly sampled (all FPbase data, 1 nm)
 *   {xy: [[x,y], ...]} irregular (Drobizhev / Zipfel measurements)
 * Curve wraps both behind a single at(x) sampler that returns 0 outside the
 * measured range, so products and integrals never invent data.
 */
(function (SV) {
  'use strict';

  function Curve(packed) {
    this.uniform = !!(packed && packed.y);
    if (this.uniform) {
      this.x0 = packed.x0;
      this.dx = packed.dx || 1;
      this.ys = packed.y;
      this.x1 = this.x0 + (this.ys.length - 1) * this.dx;
    } else {
      this.pts = (packed && packed.xy) || [];
      this.x0 = this.pts.length ? this.pts[0][0] : 0;
      this.x1 = this.pts.length ? this.pts[this.pts.length - 1][0] : 0;
    }
  }

  /* Linear interpolation; 0 outside the measured range. */
  Curve.prototype.at = function (x) {
    if (x < this.x0 || x > this.x1) return 0;
    if (this.uniform) {
      var t = (x - this.x0) / this.dx;
      var i = Math.floor(t);
      if (i >= this.ys.length - 1) return this.ys[this.ys.length - 1];
      var f = t - i;
      return this.ys[i] * (1 - f) + this.ys[i + 1] * f;
    }
    var pts = this.pts;
    var lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid][0] <= x) lo = mid; else hi = mid;
    }
    var span = pts[hi][0] - pts[lo][0];
    if (span <= 0) return pts[lo][1];
    var g = (x - pts[lo][0]) / span;
    return pts[lo][1] * (1 - g) + pts[hi][1] * g;
  };

  /* Peak value and its wavelength, optionally restricted to [lo, hi]. */
  Curve.prototype.peak = function (lo, hi) {
    var best = -Infinity, bestX = null;
    this.forEach(function (x, y) {
      if (lo != null && x < lo) return;
      if (hi != null && x > hi) return;
      if (y > best) { best = y; bestX = x; }
    });
    return { y: best === -Infinity ? 0 : best, x: bestX };
  };

  Curve.prototype.forEach = function (fn) {
    if (this.uniform) {
      for (var i = 0; i < this.ys.length; i++) fn(this.x0 + i * this.dx, this.ys[i]);
    } else {
      for (var j = 0; j < this.pts.length; j++) fn(this.pts[j][0], this.pts[j][1]);
    }
  };

  /* Points clipped to a window, with the samples the renderer needs at the edges. */
  Curve.prototype.points = function (lo, hi) {
    var out = [];
    this.forEach(function (x, y) { if (x >= lo && x <= hi) out.push([x, y]); });
    return out;
  };

  Curve.prototype.isEmpty = function () {
    return this.uniform ? !this.ys || !this.ys.length : !this.pts.length;
  };

  /* Trapezoidal integral of the product of several curves over [lo, hi].
   * A missing curve is treated as absent, not as zero, so callers can pass
   * an optional detector or dichroic without special-casing it. */
  function integrate(curves, lo, hi, step) {
    step = step || 1;
    var list = curves.filter(Boolean);
    if (!list.length) return 0;
    var total = 0, prev = null;
    for (var x = lo; x <= hi + 1e-9; x += step) {
      var v = 1;
      for (var i = 0; i < list.length; i++) v *= list[i].at(x);
      if (prev !== null) total += (prev + v) / 2 * step;
      prev = v;
    }
    return total;
  }

  /* A copy of `curve` that stops dead at `hi` nm - the laser blocking filter in
   * front of the detectors. Resampled at 1 nm so the result is an ordinary
   * curve that charts and integration can use without knowing about any of it. */
  function clipCurve(curve, hi) {
    if (!curve) return null;
    var lo = Math.floor(curve.x0);
    var top = Math.min(Math.ceil(curve.x1), hi);
    if (top <= lo) return new Curve({ x0: lo, dx: 1, y: [0, 0] });
    var ys = [];
    for (var x = lo; x <= top; x++) ys.push(curve.at(x));
    ys.push(0);                       // close the edge rather than leaving a step
    return new Curve({ x0: lo, dx: 1, y: ys });
  }

  /* ------------------------------------------------------------ colour */

  /* Approximate sRGB for a visible wavelength (Bruton's piecewise fit).
   * Used for the spectral colour mode and the wavelength rail under the
   * emission chart, where a physically-suggestive hue is what people expect. */
  function wavelengthRGB(wl) {
    var r = 0, g = 0, b = 0;
    if (wl >= 380 && wl < 440) { r = -(wl - 440) / 60; b = 1; }
    else if (wl < 490) { g = (wl - 440) / 50; b = 1; }
    else if (wl < 510) { g = 1; b = -(wl - 510) / 20; }
    else if (wl < 580) { r = (wl - 510) / 70; g = 1; }
    else if (wl < 645) { r = 1; g = -(wl - 645) / 65; }
    else if (wl <= 780) { r = 1; }
    else if (wl > 780) { r = 1; }          // clamp IR to deep red
    else { r = 0.6; b = 1; }               // clamp UV to violet

    // Intensity falls off at the ends of the visible range; keep a floor so
    // deep blue and deep red curves stay legible against the chart surface.
    var f = 1;
    if (wl >= 380 && wl < 420) f = 0.3 + 0.7 * (wl - 380) / 40;
    else if (wl > 700) f = Math.max(0.55, 0.3 + 0.7 * (780 - wl) / 80);
    var gamma = 0.85;
    var ch = function (c) { return Math.round(255 * Math.pow(Math.max(0, c) * f, gamma)); };
    return [ch(r), ch(g), ch(b)];
  }

  /* Saturated, mid-lightness version of the spectral hue - raw wavelength RGB
   * is too dark at the ends and too pale in the middle to use as a line colour. */
  function wavelengthLine(wl, dark) {
    var rgb = wavelengthRGB(wl);
    var hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    var sat = Math.max(0.62, Math.min(0.9, hsl[1]));
    var light = dark ? 0.62 : 0.45;
    return hslToCss(hsl[0], sat, light);
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    var d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToCss(h, s, l) {
    return 'hsl(' + Math.round(h * 360) + ' ' + Math.round(s * 100) + '% ' +
      Math.round(l * 100) + '%)';
  }

  function withAlpha(css, alpha) {
    if (css.indexOf('hsl(') === 0) return css.replace('hsl(', 'hsla(').replace(')', ' / ' + alpha + ')');
    if (css[0] === '#') {
      var n = parseInt(css.slice(1), 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
    }
    return css;
  }

  SV.Curve = Curve;
  SV.integrate = integrate;
  SV.clipCurve = clipCurve;
  SV.wavelengthRGB = wavelengthRGB;
  SV.wavelengthLine = wavelengthLine;
  SV.withAlpha = withAlpha;
})(window.SV || (window.SV = {}));
