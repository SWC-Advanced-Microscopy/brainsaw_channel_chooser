/* BrainSaw two-photon spectra viewer - UI, state and wiring. */
(function (SV) {
  'use strict';

  var CORE = window.SV_CORE;
  var INDEX = window.SV_FILTER_INDEX;

  var EXC_LO = 740, EXC_HI = 1100;
  var EM_LO = SV.optics.EM_LO, EM_HI = SV.optics.EM_HI;

  var FAMILIES = [
    { id: 'blue', label: 'Blue', wl: 450 },
    { id: 'cyan', label: 'Cyan', wl: 485 },
    { id: 'green', label: 'Green', wl: 512 },
    { id: 'yellow', label: 'Yellow', wl: 530 },
    { id: 'orange', label: 'Orange', wl: 565 },
    { id: 'red', label: 'Red', wl: 605 },
    { id: 'farred', label: 'Far red', wl: 665 },
    { id: 'sensor', label: 'Sensors', wl: 590 },
  ];

  var state = {
    scopeId: CORE.scopes[0].id,
    laserId: CORE.scopes[0].laser,
    selected: [],            // [{id, source}]
    channels: [],
    dichroics: [],
    sourcePref: 'D',
    objective: 'balanced',
    ctxStrength: 1,
    minWl: CORE.minWavelength || SV.optics.DEFAULT_MIN_WL,
    excUnits: 'norm',
    unitsLocked: false,      // set once the user picks Relative/GM by hand
    chosenWl: null,
    overlays: { laser: true, score: true, filters: true },
    hidden: {},
    search: '',
    commonOnly: true,
    families: {},
  };

  var byId = {}, filters = CORE.filters;
  var charts = {};
  var extraFilters = {};      // filters pulled from the library at runtime
  var shardCache = {};

  /* ------------------------------------------------------------- setup */

  function prepare() {
    CORE.fluorophores.forEach(function (f) {
      byId[f.id] = f;
      if (f.em) f._em = new SV.Curve(f.em);
      if (f.ex) f._ex = new SV.Curve(f.ex);
      Object.keys(f.twop).forEach(function (k) {
        var t = f.twop[k];
        t._curve = new SV.Curve(t.curve);
        if (t.gm) t._gm = new SV.Curve(t.gm);
      });
    });
    Object.keys(filters).forEach(function (k) {
      if (filters[k].curve) filters[k]._curve = new SV.Curve(filters[k].curve);
    });
    CORE.lasers.forEach(function (l) {
      l._curve = new SV.Curve({ xy: l.curve });
    });
  }

  function laser() {
    return CORE.lasers.filter(function (l) { return l.id === state.laserId; })[0] || CORE.lasers[0];
  }
  function scope() {
    return CORE.scopes.filter(function (s) { return s.id === state.scopeId; })[0] || CORE.scopes[0];
  }
  function isDark() {
    return document.documentElement.dataset.resolvedTheme === 'dark';
  }
  function allFilters() {
    return Object.assign({}, filters, extraFilters);
  }

  function loadScope(sc) {
    state.channels = (sc.channels || []).map(function (c) {
      return { name: c.name, label: c.label, spectrum: c.spectrum, pmt: c.pmt };
    });
    sortChannels();
    state.laserId = sc.laser || state.laserId;
  }

  /* Channels are always held in ascending centre-wavelength order, so every list
   * and table on the page reads blue-to-red like the emission chart above them. */
  function sortChannels() {
    state.channels.sort(function (a, b) {
      return (filterCentre(a.spectrum) || 0) - (filterCentre(b.spectrum) || 0);
    });
  }

  /* Colour for a fluorophore: the hue of the light it actually emits. */
  function fluorColor(f) {
    var wl = f.emMax || (f.twop && firstPeak(f) ? firstPeak(f) / 2 : 520);
    return SV.wavelengthLine(clamp(wl, 400, 700), isDark());
  }
  function firstPeak(f) {
    var k = Object.keys(f.twop)[0];
    return k ? f.twop[k].peakWl : null;
  }
  /* Centre of a filter's passband, from its half-maximum points. */
  var centreCache = {};
  function filterCentre(fid) {
    if (centreCache[fid] != null) return centreCache[fid];
    var fl = allFilters()[fid];
    if (!fl || !fl._curve) return null;
    var pk = fl._curve.peak(EM_LO, EM_HI);
    var half = pk.y / 2;
    var lo = null, hi = null;
    fl._curve.forEach(function (x, y) {
      if (x < EM_LO || x > EM_HI) return;
      if (y >= half) { if (lo === null) lo = x; hi = x; }
    });
    centreCache[fid] = lo != null ? (lo + hi) / 2 : pk.x;
    return centreCache[fid];
  }

  function filterColor(fid) {
    var centre = filterCentre(fid);
    if (centre == null) return 'var(--text-muted)';
    return SV.wavelengthLine(clamp(centre, 400, 700), isDark());
  }

  function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
  function pct(v, dp) { return (v * 100).toFixed(dp == null ? 0 : dp) + '%'; }

  /* Which 2p source to use for a selection entry, honouring the override. */
  function sourceFor(entry) {
    var f = byId[entry.id];
    if (!f) return null;
    if (entry.source && f.twop[entry.source]) return entry.source;
    if (f.twop[state.sourcePref]) return state.sourcePref;
    return ['D', 'Z', 'F'].filter(function (k) { return f.twop[k]; })[0] || null;
  }

  /* GM is more informative than "% of own peak", so use it whenever every
   * selected fluorophore has absolute data - unless the user has chosen. */
  function autoUnits(sel) {
    if (state.unitsLocked) return state.excUnits;
    if (!sel.length) return 'norm';
    return sel.every(function (s) { return s.gmCurve; }) ? 'gm' : 'norm';
  }

  function buildSelection() {
    return state.selected.map(function (entry) {
      var f = byId[entry.id];
      if (!f) return null;
      var src = sourceFor(entry);
      var t = src ? f.twop[src] : null;
      return {
        fluor: f, entry: entry, source: src,
        twopCurve: t ? t._curve : null,
        gmCurve: t ? t._gm : null,
        twopPeak: t ? t.peakWl : null,
        peakGm: t ? t.peakGm : null,
        color: fluorColor(f),
        weight: 1,
      };
    }).filter(Boolean);
  }

  /* --------------------------------------------------------- rendering */

  var el = {};
  function $(id) { return el[id] || (el[id] = document.getElementById(id)); }

  function renderAll() {
    renderFluorList();
    renderSelected();
    renderChannels();
    renderCharts();
    renderRecommendation();
    renderMatrix();
    renderProvenance();
    writeHash();
  }

  /* -- fluorophore list -------------------------------------------------- */
  function renderFamilyChips() {
    var wrap = $('family-filters');
    wrap.innerHTML = '';
    FAMILIES.forEach(function (fam) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.setAttribute('aria-pressed', state.families[fam.id] ? 'true' : 'false');
      b.innerHTML = '<i style="background:' + SV.wavelengthLine(fam.wl, isDark()) + '"></i>' + fam.label;
      b.addEventListener('click', function () {
        state.families[fam.id] = !state.families[fam.id];
        b.setAttribute('aria-pressed', state.families[fam.id] ? 'true' : 'false');
        renderFluorList();
      });
      wrap.appendChild(b);
    });
  }

  function visibleFluorophores() {
    var q = state.search.trim().toLowerCase();
    var famOn = Object.keys(state.families).filter(function (k) { return state.families[k]; });
    return CORE.fluorophores.filter(function (f) {
      // an explicit search always reaches the uncommon ones
      if (state.commonOnly && !f.common && !q) return false;
      if (famOn.length && famOn.indexOf(f.family) < 0) return false;
      if (!q) return true;
      return f.name.toLowerCase().indexOf(q) >= 0 ||
        (f.fpbase || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderFluorList() {
    var list = $('fluor-list');
    var items = visibleFluorophores();
    list.innerHTML = '';
    items.forEach(function (f) {
      var picked = state.selected.some(function (s) { return s.id === f.id; });
      var li = document.createElement('li');
      li.className = 'fluor-row';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', picked ? 'true' : 'false');
      li.tabIndex = 0;
      var peak = firstPeak(f);
      li.innerHTML =
        '<span class="fluor-swatch" style="background:' + fluorColor(f) + '"></span>' +
        '<span class="fluor-name">' + SV.escapeHtml(f.name) + '</span>' +
        '<span class="fluor-meta">' + (peak ? Math.round(peak) + ' nm' : 'no 2p') + '</span>' +
        '<span class="src-tags">' + ['D', 'Z', 'F'].map(function (k) {
          return f.twop[k] ? '<span class="src-tag" title="' + CORE.sources[k].label + ' data">' + k + '</span>' : '';
        }).join('') + '</span>';
      var toggle = function () { toggleFluor(f.id); };
      li.addEventListener('click', toggle);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      list.appendChild(li);
    });
    var noTwoP = items.filter(function (f) { return !Object.keys(f.twop).length; }).length;
    $('fluor-count').textContent = items.length + ' of ' + CORE.fluorophores.length + ' shown' +
      (state.commonOnly ? ' · searching also finds uncommon ones' : '') +
      (noTwoP ? ' · ' + noTwoP + ' without 2p data' : '');
  }

  function toggleFluor(id) {
    var i = state.selected.findIndex(function (s) { return s.id === id; });
    if (i >= 0) state.selected.splice(i, 1);
    else state.selected.push({ id: id, source: null });
    state.chosenWl = null;
    renderAll();
  }

  /* -- selected list ----------------------------------------------------- */
  function renderSelected() {
    var list = $('selected-list');
    list.innerHTML = '';
    $('selected-count').textContent = state.selected.length;
    $('selected-empty').hidden = state.selected.length > 0;

    buildSelection().forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'sel-item';
      var srcs = ['D', 'Z', 'F'].filter(function (k) { return s.fluor.twop[k]; });
      li.innerHTML =
        '<div class="sel-top">' +
          '<span class="sel-dot" style="background:' + s.color + '"></span>' +
          '<span class="sel-name">' + SV.escapeHtml(s.fluor.name) + '</span>' +
          '<button class="sel-remove" aria-label="Remove ' + SV.escapeHtml(s.fluor.name) + '">✕</button>' +
        '</div>' +
        '<div class="sel-bottom">' +
          '<div class="seg small" role="radiogroup" aria-label="Data source for ' + SV.escapeHtml(s.fluor.name) + '">' +
            ['D', 'Z', 'F'].map(function (k) {
              var on = s.source === k;
              return '<button role="radio" data-src="' + k + '" aria-checked="' + on + '"' +
                (srcs.indexOf(k) < 0 ? ' disabled' : '') +
                ' title="' + SV.escapeHtml(CORE.sources[k].label) + '">' + k + '</button>';
            }).join('') +
          '</div>' +
          '<span class="sel-peak">' + (s.twopPeak ? 'peak ' + Math.round(s.twopPeak) + ' nm' : 'no 2p data') +
            (s.peakGm ? ' · ' + Math.round(s.peakGm) + ' GM' : '') + '</span>' +
        '</div>';

      li.querySelector('.sel-remove').addEventListener('click', function () { toggleFluor(s.fluor.id); });
      li.querySelectorAll('.seg button').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.disabled) return;
          s.entry.source = b.dataset.src;
          renderAll();
        });
      });
      list.appendChild(li);
    });
  }

  /* -- channels ---------------------------------------------------------- */
  function renderChannels() {
    var list = $('channel-list');
    var fl = allFilters();
    list.innerHTML = '';
    state.channels.forEach(function (ch, idx) {
      var f = fl[ch.spectrum];
      var li = document.createElement('li');
      li.className = 'chan-item';
      li.innerHTML =
        '<span class="chan-swatch" style="background:' + filterColor(ch.spectrum) + '"></span>' +
        '<span class="chan-text">' +
          '<span class="chan-name">' + SV.escapeHtml(ch.name) + '</span>' +
          '<span class="chan-filter">' + SV.escapeHtml(f ? f.name : 'no filter') + '</span>' +
        '</span>' +
        '<span class="chan-actions">' +
          '<button class="btn small ghost" data-act="filter">Filter</button>' +
          '<button class="btn small ghost icon" data-act="remove" aria-label="Remove channel">✕</button>' +
        '</span>';

      li.querySelector('[data-act="filter"]').addEventListener('click', function () {
        openPicker('Filter for ' + ch.name, function (rec, curve) {
          extraFilters[rec.id] = { id: rec.id, name: rec.n, type: rec.t, source: 'FPbase', _curve: curve };
          ch.spectrum = rec.id;
          sortChannels();
          renderAll();
        });
      });
      li.querySelector('[data-act="remove"]').addEventListener('click', function () {
        state.channels.splice(idx, 1);
        renderAll();
      });
      list.appendChild(li);
    });

  }

  function shortName(n) { return n.replace(/^(Semrock|Chroma|Alluxa|Omega|Thorlabs)\s+/, ''); }

  /* -- charts ------------------------------------------------------------ */
  function makeCharts() {
    charts.exc = new SV.Chart($('chart-exc'), {
      xMin: EXC_LO, xMax: EXC_HI, yMin: 0, yMax: 1,
      xLabel: 'Excitation wavelength (nm)',
      yLabel: 'Relative 2p excitation',
      yTickFormat: function (v) { return state.excUnits === 'gm' ? String(Math.round(v)) : Math.round(v * 100) + '%'; },
      tipFormat: function (v, s) {
        if (s && s.tipUnit === 'gm') {
          var frac = s.peakVal ? ' (' + Math.round(v / s.peakVal * 100) + '%)' : '';
          return v.toFixed(1) + ' GM' + frac;
        }
        return Math.round(v * 100) + '%';
      },
      onMarkerDrag: function (m, v) {
        state.chosenWl = v;
        m.label = v + ' nm';       // the chart redraws right after this returns
        renderRecommendation();
      },
      onZoom: function (c) { syncZoomBtn('exc', c); },
    });
    charts.em = new SV.Chart($('chart-em'), {
      xMin: 380, xMax: 800, yMin: 0, yMax: 1,
      xLabel: 'Emission wavelength (nm)',
      yLabel: 'Relative intensity / transmission',
      spectralRail: true,
      yTickFormat: function (v) { return Math.round(v * 100) + '%'; },
      onZoom: function (c) { syncZoomBtn('em', c); },
    });
  }

  function syncZoomBtn(key, c) {
    var b = document.querySelector('[data-reset-zoom="' + key + '"]');
    if (b) b.hidden = !c.isZoomed();
  }

  function renderCharts() {
    var sel = buildSelection();
    var dark = isDark();
    state.excUnits = autoUnits(sel);
    var gm = state.excUnits === 'gm';
    $('exc-units').querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.unit === state.excUnits));
    });
    var L = laser();

    /* --- excitation ---------------------------------------------------- */
    var excSeries = [];
    var maxGm = 0;
    sel.forEach(function (s) {
      var curve = gm ? s.gmCurve : s.twopCurve;
      if (!curve) return;
      if (gm) { var p = curve.peak(EXC_LO, EXC_HI); if (p.y > maxGm) maxGm = p.y; }
      excSeries.push({
        id: 'f-' + s.fluor.id,
        label: s.fluor.name + ' (' + s.source + ')',
        peakLabel: s.fluor.name,
        color: s.color, curve: curve, kind: 'line', width: 2,
        fill: true, fillAlpha: 0.1,
        hidden: !!state.hidden['f-' + s.fluor.id],
        tipUnit: gm ? 'gm' : 'norm',
        peakVal: gm ? s.peakGm : 1,
      });
    });

    var rec = currentRec(sel);
    if (!gm) {
      if (state.overlays.laser && L._curve) {
        excSeries.push({
          id: 'laser', label: L.name + ' power', color: cssVar('--text-muted'),
          curve: L._curve, kind: 'line', width: 1.5, dash: [5, 4],
          hidden: !!state.hidden.laser,
        });
      }
      if (state.overlays.score && rec && rec.scoreCurve) {
        excSeries.push({
          id: 'score', label: 'Suitability', color: cssVar('--accent'),
          curve: rec.scoreCurve, kind: 'line', width: 1.5, dash: [2, 3],
          fill: true, fillAlpha: 0.08,
          hidden: !!state.hidden.score,
        });
      }
    }
    // The relative overlays have no meaning against a GM axis, so make that
    // visible in the controls rather than silently dropping the curves.
    ['show-laser', 'show-score'].forEach(function (id) {
      var input = $(id);
      input.disabled = gm;
      input.closest('.check').title = gm
        ? 'Relative overlays are not shown on an absolute GM axis'
        : '';
    });

    charts.exc.opts.yLabel = gm ? 'Action cross-section (GM)' : 'Relative to own peak';
    charts.exc.setYRange(0, gm ? Math.max(10, maxGm * 1.08) : 1.05);

    var zones = [];
    var tint = dark ? 'rgba(255,255,255,.035)' : 'rgba(20,20,15,.04)';
    if (L.range[0] > EXC_LO) zones.push({ x0: EXC_LO, x1: L.range[0], color: tint, label: 'outside laser range' });
    if (L.range[1] < EXC_HI) zones.push({ x0: L.range[1], x1: EXC_HI, color: tint, label: 'outside laser range' });
    if (state.ctxStrength > 0) {
      zones.push({
        x0: 950, x1: EXC_HI,
        color: dark ? 'rgba(213,148,51,.07)' : 'rgba(163,90,0,.055)',
        label: 'little background for anatomy',
      });
    }
    if (state.minWl > EXC_LO) {
      zones.push({
        x0: EXC_LO, x1: state.minWl,
        color: tint,
        label: 'below your minimum',
      });
    }
    charts.exc.setZones(zones);
    charts.exc.setSeries(excSeries);

    var wl = chosenWavelength(rec);
    charts.exc.setMarkers(wl ? [{
      id: 'wl', x: wl, color: cssVar('--accent'), draggable: true,
      label: wl + ' nm', width: 2,
    }] : []);

    $('exc-sub').textContent = gm
      ? 'Absolute action cross-section — only Drobizhev and Zipfel curves have absolute units'
      : 'Each curve normalised to its own peak between ' + CORE.normWindow[0] + ' and ' + CORE.normWindow[1] + ' nm';

    var missingGm = gm ? sel.filter(function (s) { return !s.gmCurve; }) : [];
    $('exc-foot').innerHTML = gm
      ? (missingGm.length
        ? 'Not shown in GM: ' + missingGm.map(function (s) { return SV.escapeHtml(s.fluor.name); }).join(', ') +
          ' — FPbase two-photon curves are relative, not absolute. Switch to Relative to see them.'
        : 'Absolute cross-sections in Göppert-Mayer units.')
      : 'Drag the marker to test a wavelength. Drag across the plot to zoom, double-click to reset.' +
        (state.overlays.score ? ' “Suitability” is this tool’s score, not measured data.' : '');

    /* --- emission ------------------------------------------------------- */
    var emSeries = [];
    var fl = allFilters();

    if (state.overlays.filters) {
      state.channels.forEach(function (ch) {
        var f = fl[ch.spectrum];
        if (!f || !f._curve) return;
        emSeries.push({
          id: 'ch-' + ch.spectrum, label: ch.name + ' · ' + shortName(f.name),
          color: filterColor(ch.spectrum), curve: f._curve, kind: 'band',
          width: 1, fillAlpha: 0.16,
          hidden: !!state.hidden['ch-' + ch.spectrum],
        });
      });
    }
    sel.forEach(function (s) {
      if (!s.fluor._em) return;
      emSeries.push({
        id: 'em-' + s.fluor.id, label: s.fluor.name + ' emission',
        peakLabel: s.fluor.name,
        color: s.color, curve: s.fluor._em, kind: 'line', width: 2,
        fill: true, gradient: true, fillAlpha: 0.34,
        hidden: !!state.hidden['em-' + s.fluor.id],
      });
    });
    charts.em.setSeries(emSeries);
    renderLegend(emSeries);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  function renderLegend(series) {
    var wrap = $('legend');
    wrap.innerHTML = '';
    series.forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'legend-item';
      b.type = 'button';
      b.setAttribute('aria-pressed', s.hidden ? 'false' : 'true');
      b.innerHTML = '<i class="' + (s.dash ? 'dash' : '') + '" style="' +
        (s.dash ? 'color:' + s.color : 'background:' + s.color) + '"></i>' + SV.escapeHtml(s.label);
      b.addEventListener('click', function () {
        state.hidden[s.id] = !state.hidden[s.id];
        renderCharts();
      });
      wrap.appendChild(b);
    });
  }

  /* -- recommendation ---------------------------------------------------- */
  function recOpts() {
    return {
      mode: state.objective,
      contextStrength: state.ctxStrength,
      minWl: state.minWl,
    };
  }
  var _recCache = null, _recKey = '';
  function currentRec(sel) {
    var key = JSON.stringify([state.selected.map(sourceFor), state.selected.map(function (s) { return s.id; }),
      state.laserId, state.objective, state.ctxStrength, state.minWl]);
    if (key === _recKey) return _recCache;
    _recKey = key;
    _recCache = sel.length ? SV.optics.recommend(sel, laser(), recOpts()) : null;
    return _recCache;
  }
  function chosenWavelength(rec) {
    if (state.chosenWl != null) return state.chosenWl;
    return rec && rec.best ? rec.best.wl : null;
  }

  function breakdown(sel) {
    return SV.optics.channelBreakdown(
      sel.map(function (s) { return s.fluor; }),
      state.channels, allFilters());
  }

  function renderRecommendation() {
    var sel = buildSelection();
    var rec = currentRec(sel);
    $('hero-empty').hidden = sel.length > 0;
    $('hero-body').hidden = sel.length === 0;
    if (!sel.length) {
      $('advice').innerHTML = '';
      $('acquire-list').innerHTML = '';
      $('acquire-warnings').innerHTML = '';
      $('acquire-note').textContent = '';
      return;
    }

    var wl = chosenWavelength(rec);
    var focus = wl != null ? evaluateAt(sel, wl, rec) : null;

    $('hero-wl').textContent = wl != null ? wl : '—';

    var subParts = [];
    if (rec && rec.best && wl !== rec.best.wl) {
      subParts.push('You have moved off the suggestion of ' + rec.best.wl + ' nm.');
    } else {
      // count only the ones that actually drive the recommendation
      var n = rec && rec.usable ? rec.usable.length : sel.length;
      subParts.push((state.objective === 'balanced'
        ? 'Best worst-case across ' + n + ' fluorophore' + (n > 1 ? 's' : '')
        : 'Best average signal across ' + n + ' fluorophore' + (n > 1 ? 's' : '')) + '.');
    }
    if (focus) subParts.push(laser().name + ' at ' + pct(focus.power) + ' of peak power here.');
    $('hero-sub').textContent = subParts.join(' ');

    // alternatives
    var alts = $('hero-alts');
    alts.innerHTML = '';
    if (rec) {
      var picks = rec.candidates.slice(0, 4);
      if (rec.best && wl !== rec.best.wl) {
        picks = [rec.best].concat(picks.filter(function (c) { return c.wl !== rec.best.wl; })).slice(0, 4);
      }
      picks.forEach(function (c) {
        if (c.wl === wl) return;
        var b = document.createElement('button');
        b.className = 'alt-btn';
        b.type = 'button';
        b.textContent = c.wl + ' nm · ' + pct(c.obj / (rec.best ? rec.best.obj : c.obj));
        b.title = 'Switch the marker to ' + c.wl + ' nm';
        b.addEventListener('click', function () {
          state.chosenWl = c.wl;
          renderCharts(); renderRecommendation();
        });
        alts.appendChild(b);
      });
    }
    $('hero-alts-row').hidden = !alts.children.length;

    // per-fluorophore bars at the chosen wavelength
    var bars = $('hero-bars');
    bars.innerHTML = '';
    if (focus) {
      sel.forEach(function (s, i) {
        if (!s.twopCurve) return;
        var raw = s.twopCurve.at(wl);
        var row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML =
          '<div><div class="bar-label"><i style="background:' + s.color + '"></i>' +
            '<span>' + SV.escapeHtml(s.fluor.name) + '</span></div>' +
            '<div class="bar-track"><span class="bar-fill" style="width:' +
              (clamp(raw, 0, 1) * 100).toFixed(1) + '%;background:' + s.color + '"></span></div></div>' +
          '<div class="bar-val">' + pct(raw) + '</div>';
        row.title = s.fluor.name + ' at ' + wl + ' nm: ' + pct(raw) + ' of its own two-photon peak (' +
          (s.twopPeak ? Math.round(s.twopPeak) + ' nm' : 'unknown') + ')';
        bars.appendChild(row);
      });
      var hdr = document.createElement('p');
      hdr.className = 'rail-note';
      hdr.textContent = 'Share of each fluorophore’s own two-photon peak at ' + wl +
        ' nm, before laser power and detection are applied.';
      bars.appendChild(hdr);
    }

    // channels to acquire
    var bd = breakdown(sel);
    var plan = wl != null ? SV.optics.planChannels(
      bd.rows, state.channels,
      state.channels.map(function (c) { return filterCentre(c.spectrum) || 0; }),
      wl) : null;
    renderAcquire(plan, wl, bd, sel);

    // advice
    var items = SV.explain({
      rec: rec, focus: focus, selection: sel, laser: laser(),
      channels: state.channels,
    });
    // the acquisition plan is shown in the "Channels to acquire" panel, not here
    var ul = $('advice');
    ul.innerHTML = '';
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = it.kind;
      li.innerHTML = '<span>' + SV.escapeHtml(it.text) + '</span>';
      ul.appendChild(li);
    });

    writeHash();
  }

  /* Candidate-shaped stats for an arbitrary wavelength. */
  function evaluateAt(sel, wl, rec) {
    var L = laser();
    var pw = SV.optics.powerWeight(L._curve, wl, L.range);
    var cw = SV.optics.contextWeight(wl, state.ctxStrength);
    var usable = sel.filter(function (s) { return s.twopCurve; });
    var per = usable.map(function (s) { return Math.max(0, s.twopCurve.at(wl)) * pw * cw; });
    var obj = state.objective === 'total'
      ? per.reduce(function (a, b) { return a + b; }, 0) / (per.length || 1)
      : (per.length ? Math.min.apply(null, per) : 0);
    return {
      wl: wl, obj: obj, per: per, power: L._curve.at(wl), ctx: cw,
      rel: rec && rec.best && rec.best.obj ? obj / rec.best.obj : 1,
    };
  }

  /* -- channels to acquire ----------------------------------------------- */
  function renderAcquire(plan, wl, bd, sel) {
    var list = $('acquire-list');
    var warnBox = $('acquire-warnings');
    list.innerHTML = '';
    warnBox.innerHTML = '';

    // everything about where emission lands belongs here, not in the notes above
    if (bd) {
      SV.explainDetection({
        breakdown: bd, channels: state.channels,
        overlaps: SV.optics.separability(bd.rows),
      }).forEach(function (it) {
        var li = document.createElement('li');
        li.className = it.kind;
        li.innerHTML = '<span>' + SV.escapeHtml(it.text) + '</span>';
        warnBox.appendChild(li);
      });
    }

    if (!plan) {
      $('acquire-note').textContent = '';
      return;
    }
    plan.plan.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'acquire-item role-' + entry.role;
      var chip = entry.role === 'signal' ? 'Signal'
        : entry.role === 'background' ? 'Anatomy' : 'Skip';
      li.innerHTML =
        '<span class="acq-swatch" style="background:' + filterColor(entry.channel.spectrum) + '"></span>' +
        '<span class="acq-body">' +
          '<span class="acq-head">' +
            '<b>' + SV.escapeHtml(entry.channel.name) + '</b>' +
            '<span class="acq-chip">' + chip + '</span>' +
          '</span>' +
          '<span class="acq-reason">' +
            SV.escapeHtml(SV.channelReason(entry, plan, wl)) + '</span>' +
        '</span>' +
        '<span class="acq-bg" title="Estimated background signal in this channel at ' +
          wl + ' nm">' +
          '<span class="acq-bg-track"><span class="acq-bg-fill" style="width:' +
            (clamp(entry.bg, 0, 1) * 100).toFixed(0) + '%"></span></span>' +
          '<span class="acq-bg-label">' + SV.escapeHtml(SV.optics.bgLabel(entry.bg)) + '</span>' +
        '</span>';
      list.appendChild(li);
    });
    var summary = SV.planSummary(plan, wl);
    if (summary) {
      var head = document.createElement('li');
      head.className = 'acquire-summary ' + summary.kind;
      head.textContent = summary.text;
      list.insertBefore(head, list.firstChild);
    }
    $('acquire-note').textContent =
      'Background estimates are a heuristic for how much tissue and agar ' +
      'autofluorescence a channel sees at ' + wl + ' nm, not measured data. ' +
      'They fall off as the laser is tuned redder, soonest for the bluest channels.';
  }

  /* -- matrix ------------------------------------------------------------ */
  function renderMatrix() {
    var sel = buildSelection();
    var tbl = $('matrix');
    if (!sel.length || !state.channels.length) {
      tbl.innerHTML = '<tbody><tr><td class="dim">Select fluorophores to see how they split across your channels.</td></tr></tbody>';
      return;
    }
    var bd = breakdown(sel);
    var head = '<thead><tr><th>Fluorophore</th>' +
      state.channels.map(function (c) {
        return '<th>' + SV.escapeHtml(c.name) + '</th>';
      }).join('') +
      '<th>Capture</th><th>Assigned</th></tr></thead>';
    var body = bd.rows.map(function (row, i) {
      var s = sel[i];
      if (!s.fluor._em) {
        return '<tr><td><span class="cell-name"><i style="background:' + s.color + '"></i>' +
          SV.escapeHtml(s.fluor.name) + '</span></td>' +
          '<td class="dim" colspan="' + (state.channels.length + 2) + '">no emission spectrum on file</td></tr>';
      }
      var cells = row.frac.map(function (v) {
        return '<td class="heat" style="--v:' + v.toFixed(3) + '"><span>' +
          (v < 0.005 ? '–' : pct(v)) + '</span></td>';
      }).join('');
      var cls = row.total < 0.05 ? 'warn' : row.total > 0.2 ? 'good' : '';
      return '<tr><td><span class="cell-name"><i style="background:' + s.color + '"></i>' +
        SV.escapeHtml(s.fluor.name) + '</span></td>' + cells +
        '<td><span class="badge ' + cls + '">' + pct(row.total) + '</span></td>' +
        '<td>' + (row.best >= 0 ? SV.escapeHtml(state.channels[row.best].name) : '—') + '</td></tr>';
    }).join('');
    tbl.innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  /* -- provenance & data table ------------------------------------------- */
  function renderProvenance() {
    var sel = buildSelection();
    var fl = allFilters();
    var out = [];
    sel.forEach(function (s) {
      if (!s.source) return;
      var src = CORE.sources[s.source];
      out.push({ label: s.fluor.name + ' — 2p', tag: src.label, text: src.note, url: src.url });
      if (s.fluor._em) out.push({ label: s.fluor.name + ' — emission', tag: 'FPbase', text: 'One-photon emission spectrum.', url: 'https://www.fpbase.org' });
    });
    state.channels.forEach(function (ch) {
      var f = fl[ch.spectrum];
      if (f) out.push({ label: ch.name + ' filter', tag: f.source || 'FPbase', text: f.name, modelled: f.modelled });
    });
    state.dichroics.forEach(function (d) {
      var f = fl[d.spectrum];
      if (f) out.push({ label: d.label, tag: f.modelled ? 'modelled' : (f.source || 'FPbase'), text: f.source || f.name, modelled: f.modelled });
    });
    var L = laser();
    out.push({ label: 'Laser', tag: 'nominal', text: L.name + ' — ' + L.note, modelled: true });

    $('provenance').innerHTML = '<ul class="prov-list">' + out.map(function (o) {
      return '<li class="prov-item"><b>' + SV.escapeHtml(o.label) + '</b>' +
        '<span class="tag' + (o.modelled ? ' modelled' : '') + '">' + SV.escapeHtml(o.tag) + '</span>' +
        '<span>' + SV.escapeHtml(o.text || '') + '</span></li>';
    }).join('') + '</ul>';

    renderDataTable(sel);
  }

  /* The table view: the numbers behind the excitation chart, at 10 nm steps.
   * Present so the charts are never the only way to read the data. */
  function renderDataTable(sel) {
    var tbl = $('data-table');
    if (!sel.length) { tbl.innerHTML = ''; return; }
    var lo = EXC_LO, hi = EXC_HI, step = 10;
    var head = '<thead><tr><th>nm</th>' + sel.map(function (s) {
      return '<th>' + SV.escapeHtml(s.fluor.name) + '</th>';
    }).join('') + '<th>Laser</th></tr></thead>';
    var rows = [];
    for (var wl = lo; wl <= hi; wl += step) {
      rows.push('<tr><td>' + wl + '</td>' + sel.map(function (s) {
        return '<td>' + (s.twopCurve ? pct(s.twopCurve.at(wl)) : '–') + '</td>';
      }).join('') + '<td class="dim">' + pct(laser()._curve.at(wl)) + '</td></tr>');
    }
    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
  }

  /* ---------------------------------------------------------- filter UI */

  var pickerCb = null;
  function openPicker(title, cb) {
    pickerCb = cb;
    $('picker-title').textContent = title;
    $('picker-search').value = '';
    renderPickerList();
    $('filter-picker').showModal();
    $('picker-search').focus();
  }

  function renderPickerList() {
    var q = $('picker-search').value.trim().toLowerCase();
    var type = $('picker-type').value;
    var vendor = $('picker-vendor').value;
    var items = INDEX.filters.filter(function (f) {
      if (type && f.t !== type) return false;
      if (vendor && f.v !== vendor) return false;
      if (!q) return true;
      return f.n.toLowerCase().indexOf(q) >= 0;
    });
    var shown = items.slice(0, 120);
    var list = $('picker-list');
    list.innerHTML = '';
    shown.forEach(function (f) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.className = 'picker-row';
      b.type = 'button';
      b.innerHTML = '<span class="pname">' + SV.escapeHtml(f.n) + '</span>' +
        '<span class="pmeta">' + f.t + (f.c ? ' · ' + f.c + ' nm' : '') + '</span>';
      b.addEventListener('click', function () { choosePickerItem(f); });
      li.appendChild(b);
      list.appendChild(li);
    });
    $('picker-note').textContent = items.length > shown.length
      ? 'Showing ' + shown.length + ' of ' + items.length + ' matches — refine your search.'
      : items.length + ' match' + (items.length === 1 ? '' : 'es') + ' of ' + INDEX.filters.length + ' filters.';
  }

  function choosePickerItem(rec) {
    loadShard(rec.s).then(function (shard) {
      var packed = shard[rec.id];
      if (!packed) throw new Error('curve missing');
      var curve = new SV.Curve(packed);
      $('filter-picker').close();
      if (pickerCb) pickerCb(rec, curve);
      toast(rec.n + ' loaded');
    }).catch(function () {
      $('picker-note').textContent =
        'Could not load that curve. The filter library is fetched on demand, which ' +
        'needs the page to be served over http:// rather than opened from a file.';
    });
  }

  function loadShard(n) {
    var key = String(n);
    if (shardCache[key]) return Promise.resolve(shardCache[key]);
    var name = ('00' + n).slice(-3);
    return fetch('data/filters/' + name + '.json').then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (j) { shardCache[key] = j; return j; });
  }

  /* --------------------------------------------------------------- misc */

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }

  function downloadCSV() {
    var sel = buildSelection();
    if (!sel.length) { toast('Nothing selected'); return; }
    var bd = breakdown(sel);
    var lines = [['fluorophore', '2p_source', '2p_peak_nm']
      .concat(state.channels.map(function (c) { return c.name + '_frac'; }))
      .concat(['total_capture']).join(',')];
    bd.rows.forEach(function (row, i) {
      var s = sel[i];
      lines.push([s.fluor.name, s.source || '', s.twopPeak || '']
        .concat(row.frac.map(function (v) { return v.toFixed(4); }))
        .concat([row.total.toFixed(4)]).join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'channel-assignment.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function downloadPNG(key) {
    var c = charts[key];
    if (!c) return;
    var a = document.createElement('a');
    a.href = c.toPNG(2);
    a.download = (key === 'exc' ? 'two-photon-excitation' : 'emission-and-filters') + '.png';
    a.click();
  }

  /* ------------------------------------------------------------ url state */

  function compactState() {
    return {
      s: state.scopeId, l: state.laserId,
      f: state.selected.map(function (x) { return x.id + (x.source ? ':' + x.source : ''); }),
      p: state.sourcePref, o: state.objective, c: state.ctxStrength, m: state.minWl,
      k: state.commonOnly ? 1 : 0, u: state.unitsLocked ? state.excUnits : null,
      w: state.chosenWl,
      ch: state.channels.map(function (c) {
        return { n: c.name, s: c.spectrum, p: c.path };
      }),
    };
  }

  var hashLock = false;
  function writeHash() {
    if (hashLock) return;
    try {
      var enc = btoa(unescape(encodeURIComponent(JSON.stringify(compactState()))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      history.replaceState(null, '', '#v1=' + enc);
    } catch (e) { /* URL state is a convenience; never break the page over it */ }
  }

  function readHash() {
    var m = /#v1=(.+)$/.exec(location.hash);
    if (!m) return false;
    try {
      var json = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))));
      var o = JSON.parse(json);
      if (o.s) state.scopeId = o.s;
      if (o.l) state.laserId = o.l;
      state.selected = (o.f || []).map(function (t) {
        var parts = t.split(':');
        return { id: parts[0], source: parts[1] || null };
      }).filter(function (x) { return byId[x.id]; });
      if (o.p) state.sourcePref = o.p;
      if (o.o) state.objective = o.o;
      if (o.c != null) state.ctxStrength = o.c;
      if (o.m != null) state.minWl = o.m;
      if (o.k != null) state.commonOnly = o.k !== 0;
      if (o.u) { state.excUnits = o.u; state.unitsLocked = true; }
      state.chosenWl = o.w != null ? o.w : null;
      if (o.ch && o.ch.length) {
        state.channels = o.ch.map(function (c) { return { name: c.n, spectrum: c.s, path: c.p || [] }; });
      }
      return true;
    } catch (e) { return false; }
  }

  /* Shared-link channels may reference library filters that are not bundled in
   * core.js, so pull their curves before the first render. */
  function hydrateExternalFilters() {
    var need = [];
    var seen = {};
    var known = allFilters();
    var want = state.channels.map(function (c) { return c.spectrum; })
      .concat(state.channels.reduce(function (a, c) {
        return a.concat((c.path || []).map(function (p) { return p.spectrum; }));
      }, []));
    want.forEach(function (id) {
      if (!id || known[id] || seen[id]) return;
      seen[id] = 1;
      var rec = INDEX.filters.filter(function (f) { return f.id === id; })[0];
      if (rec) need.push(rec);
    });
    if (!need.length) return Promise.resolve();
    return Promise.all(need.map(function (rec) {
      return loadShard(rec.s).then(function (shard) {
        if (shard[rec.id]) {
          extraFilters[rec.id] = {
            id: rec.id, name: rec.n, type: rec.t, source: 'FPbase',
            _curve: new SV.Curve(shard[rec.id]),
          };
        }
      }).catch(function () { /* fall through - channel renders as "no filter" */ });
    }));
  }

  /* --------------------------------------------------------------- theme */

  function applyTheme(pref) {
    document.documentElement.dataset.theme = pref;
    var dark = pref === 'dark' ||
      (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.resolvedTheme = dark ? 'dark' : 'light';
    try { localStorage.setItem('sv-theme', pref); } catch (e) { /* private mode */ }
  }

  /* ---------------------------------------------------------------- init */

  function bindUI() {
    // scope + laser
    var ss = $('scope-select');
    CORE.scopes.forEach(function (sc) {
      ss.appendChild(new Option(sc.name, sc.id));
    });
    ss.value = state.scopeId;
    ss.addEventListener('change', function () {
      state.scopeId = ss.value;
      loadScope(scope());
      $('laser-select').value = state.laserId;
      state.chosenWl = null;
      renderAll();
    });

    var ls = $('laser-select');
    CORE.lasers.forEach(function (l) { ls.appendChild(new Option(l.name, l.id)); });
    ls.value = state.laserId;
    ls.addEventListener('change', function () {
      state.laserId = ls.value;
      state.chosenWl = null;
      renderAll();
    });

    // search / families
    $('fluor-search').addEventListener('input', function (e) {
      state.search = e.target.value;
      renderFluorList();
    });
    renderFamilyChips();

    // source preference
    $('source-pref').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.sourcePref = b.dataset.src;
        $('source-pref').querySelectorAll('button').forEach(function (o) {
          o.setAttribute('aria-checked', o === b ? 'true' : 'false');
        });
        renderAll();
      });
    });

    // excitation units
    $('exc-units').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.excUnits = b.dataset.unit;
        state.unitsLocked = true;
        renderCharts();
      });
    });

    // overlays
    var overlayMap = {
      'show-laser': 'laser', 'show-score': 'score', 'show-filters': 'filters',
    };
    Object.keys(overlayMap).forEach(function (id) {
      var input = $(id);
      input.checked = state.overlays[overlayMap[id]];
      input.addEventListener('change', function () {
        state.overlays[overlayMap[id]] = input.checked;
        renderCharts();
      });
    });

    $('objective-select').addEventListener('change', function (e) {
      state.objective = e.target.value;
      state.chosenWl = null;
      renderCharts(); renderRecommendation();
    });

    var ctx = $('ctx-strength');
    ctx.addEventListener('input', function () {
      state.ctxStrength = +ctx.value / 100;
      $('ctx-value').textContent = ctx.value + '%';
      state.chosenWl = null;
      renderCharts(); renderRecommendation();
    });

    var minWl = $('min-wl');
    minWl.addEventListener('change', function () {
      var v = parseInt(minWl.value, 10);
      state.minWl = isFinite(v) ? clamp(v, 680, 1000) : SV.optics.DEFAULT_MIN_WL;
      minWl.value = state.minWl;
      state.chosenWl = null;
      renderAll();
    });

    $('common-only').addEventListener('change', function (e) {
      state.commonOnly = e.target.checked;
      renderFluorList();
      writeHash();
    });

    // channels
    $('btn-add-channel').addEventListener('click', function () {
      openPicker('Filter for the new channel', function (rec, curve) {
        extraFilters[rec.id] = { id: rec.id, name: rec.n, type: rec.t, source: 'FPbase', _curve: curve };
        state.channels.push({ name: 'Channel ' + (state.channels.length + 1), spectrum: rec.id, path: [] });
        renderAll();
      });
    });
    $('btn-reset-scope').addEventListener('click', function () {
      loadScope(scope());
      renderAll();
      toast('Channels reset to ' + scope().name);
    });

    // picker
    ['picker-search', 'picker-type', 'picker-vendor'].forEach(function (id) {
      $(id).addEventListener('input', renderPickerList);
      $(id).addEventListener('change', renderPickerList);
    });
    var vendors = {};
    INDEX.filters.forEach(function (f) { vendors[f.v] = (vendors[f.v] || 0) + 1; });
    Object.keys(vendors).sort().forEach(function (v) {
      $('picker-vendor').appendChild(new Option(v + ' (' + vendors[v] + ')', v));
    });

    // buttons
    $('btn-csv').addEventListener('click', downloadCSV);
    document.querySelectorAll('[data-png]').forEach(function (b) {
      b.addEventListener('click', function () { downloadPNG(b.dataset.png); });
    });
    document.querySelectorAll('[data-reset-zoom]').forEach(function (b) {
      b.addEventListener('click', function () {
        charts[b.dataset.resetZoom].resetZoom();
        b.hidden = true;
      });
    });
    $('btn-share').addEventListener('click', function () {
      writeHash();
      var url = location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { toast('Link copied'); },
          function () { toast('Copy failed — the URL bar has it'); });
      } else { toast('The URL bar holds this setup'); }
    });
    $('btn-example').addEventListener('click', function () {
      state.selected = [{ id: 'egfp', source: null }, { id: 'tdtomato', source: null }];
      state.chosenWl = null;
      renderAll();
    });
    $('btn-toggle-prov').addEventListener('click', function () {
      var body = $('data-body');
      body.hidden = !body.hidden;
      $('btn-toggle-prov').setAttribute('aria-expanded', String(!body.hidden));
      $('btn-toggle-prov').textContent = body.hidden ? 'Show' : 'Hide';
    });

    // rail drawer
    $('btn-rail').addEventListener('click', function () {
      var open = $('rail').classList.toggle('open');
      $('btn-rail').setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) {
      if (window.innerWidth > 1080) return;
      if (!$('rail').classList.contains('open')) return;
      if ($('rail').contains(e.target) || $('btn-rail').contains(e.target)) return;
      $('rail').classList.remove('open');
      $('btn-rail').setAttribute('aria-expanded', 'false');
    });

    // theme
    $('btn-theme').addEventListener('click', function () {
      var cur = document.documentElement.dataset.theme;
      var next = cur === 'dark' ? 'light' : cur === 'light' ? 'auto' : 'dark';
      applyTheme(next);
      toast('Theme: ' + next);
      renderAll();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (document.documentElement.dataset.theme === 'auto') { applyTheme('auto'); renderAll(); }
    });

    // reflect restored state into controls
    $('objective-select').value = state.objective;
    ctx.value = Math.round(state.ctxStrength * 100);
    $('ctx-value').textContent = ctx.value + '%';
    minWl.value = state.minWl;
    $('common-only').checked = state.commonOnly;
    $('source-pref').querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.src === state.sourcePref));
    });
    $('exc-units').querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.unit === state.excUnits));
    });
  }

  function init() {
    if (!CORE) {
      document.body.innerHTML = '<p style="padding:40px;font:16px system-ui">' +
        'Could not load <code>data/core.js</code>.</p>';
      return;
    }
    prepare();

    var stored = 'auto';
    try { stored = localStorage.getItem('sv-theme') || 'auto'; } catch (e) { /* private mode */ }
    applyTheme(stored);

    loadScope(scope());
    hashLock = true;
    var restored = readHash();
    hashLock = false;
    if (restored && state.scopeId !== scope().id) loadScope(scope());

    bindUI();
    makeCharts();

    hydrateExternalFilters().then(function () {
      renderAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})(window.SV || (window.SV = {}));
