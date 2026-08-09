/* BrainSaw two-photon spectra viewer - UI, state and wiring. */
(function (SV) {
  'use strict';

  /* The vendored data is split across files named after what is in them; this
   * stitches them back into one object for the rest of the app to read. */
  var CORE = (function () {
    var fl = window.SV_FLUOROPHORES, la = window.SV_LASERS,
        bf = window.SV_BUNDLED_FILTERS, ms = window.SV_MICROSCOPES;
    if (!fl || !la || !bf || !ms) return null;
    return {
      generated: fl.generated,
      normWindow: fl.normWindow,
      minWavelength: fl.minWavelength,
      sources: fl.sources,
      fluorophores: fl.fluorophores,
      filters: bf.filters,
      lasers: la.lasers,
      scopes: ms.microscopes,
    };
  })();
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
    { id: 'tracer', label: 'Tracers', wl: 565 },
  ];

  var state = {
    scopeId: CORE.scopes[0].id,
    scopeName: CORE.scopes[0].name,
    blockerNm: CORE.scopes[0].blockerNm || 700,
    laserIds: [],            // every laser fitted to this rig
    laserOff: {},            // fitted but switched off, by id: hardware stays
    laserMode: 'simultaneous',   // 'simultaneous' | 'sequential', among those on
    activeLaserId: null,     // the one the marker drags and the hero reports
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
      l._curve = new SV.Curve({ xy: l.curve });          // shape, for the chart
      if (l.powerMw) l._power = new SV.Curve({ xy: l.powerMw });  // mW, for the model
    });
  }

  function laserById(id) {
    return CORE.lasers.filter(function (l) { return l.id === id; })[0] || null;
  }

  /* Every laser fitted to the rig, in the order they were added. */
  function rigLasers() {
    var out = state.laserIds.map(laserById).filter(Boolean);
    return out.length ? out : [CORE.lasers[0]];
  }

  /* The lasers actually switched on. A second laser is a hardware fact, so it
   * is never removed to try life without it - it is switched off, the way you
   * would on the rig. Something always has to be on. */
  function activeLasers() {
    var all = rigLasers();
    var on = all.filter(function (l) { return !state.laserOff[l.id]; });
    return on.length ? on : [all[0]];
  }

  function laserIsOn(l) {
    return activeLasers().indexOf(l) >= 0;
  }

  /* The laser the headline number and the draggable marker belong to. Always one
   * that is switched on, and a tunable one where there is a choice. */
  function laser() {
    var on = activeLasers();
    var hit = on.filter(function (l) { return l.id === state.activeLaserId; })[0];
    if (hit) return hit;
    var tunable = on.filter(function (l) { return l.tunable !== false; })[0];
    return tunable || on[0];
  }
  /* ---------------------------------------------------------- microscopes
   *
   * A microscope is a small JSON object: name, channels and their filters, the
   * laser blocking filter, and the lasers fitted. The two BrainSaws ship as
   * files in configs/ and are vendored into data/microscopes.js; anything a user
   * imports or saves is the same shape, so there is one code path for all of
   * them. Hardware only - how you choose to work is not part of the rig.
   */
  var SCHEMA = 'swc-channel-chooser/microscope';
  var LS_SAVED = 'sv.microscopes';
  var LS_LAST = 'sv.last-microscope';

  function lsGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  function savedScopes() {
    var v = lsGet(LS_SAVED, []);
    return Array.isArray(v) ? v : [];
  }
  function scopeLibrary() {
    return CORE.scopes.concat(savedScopes());
  }
  function scopeById(id) {
    return scopeLibrary().filter(function (s) { return s.id === id; })[0] || CORE.scopes[0];
  }
  function scope() { return scopeById(state.scopeId); }

  /* The rig as it stands, in config form. */
  function currentConfig(name) {
    var fl = allFilters();
    return {
      schema: SCHEMA,
      version: 1,
      id: state.scopeId,
      name: name || state.scopeName,
      blockerNm: state.blockerNm,
      lasers: state.laserIds.slice(),
      channels: state.channels.map(function (c) {
        var f = fl[c.spectrum];
        return { name: c.name, filter: f ? f.name : c.filter, spectrum: c.spectrum };
      }),
    };
  }

  /* Filters are stored by name as well as by id, because a name survives a
   * rebuild of the library and is what a person reading the file understands. */
  function resolveChannelFilter(ch) {
    if (ch.spectrum && (filters[ch.spectrum] || extraFilters[ch.spectrum])) return ch.spectrum;
    if (ch.filter && INDEX) {
      var hit = INDEX.filters.filter(function (f) { return f.n === ch.filter; })[0];
      if (hit) return hit.id;
    }
    return ch.spectrum || null;
  }

  function applyConfig(cfg) {
    loadScope({
      id: cfg.id || 'imported-' + Date.now().toString(36),
      name: cfg.name || 'Imported microscope',
      blockerNm: cfg.blockerNm,
      lasers: cfg.lasers,
      channels: (cfg.channels || []).map(function (c) {
        return { name: c.name, filter: c.filter, spectrum: resolveChannelFilter(c) };
      }),
    });
  }

  /* Imported and saved rigs live in the microscope dropdown next to the two
   * BrainSaws, so a facility machine can carry a few and switch between them. */
  function rememberScope(cfg) {
    var list = savedScopes().filter(function (s) { return s.id !== cfg.id; });
    list.push(cfg);
    lsSet(LS_SAVED, list);
  }
  function forgetScope(id) {
    lsSet(LS_SAVED, savedScopes().filter(function (s) { return s.id !== id; }));
  }
  function isSaved(id) {
    return savedScopes().some(function (s) { return s.id === id; });
  }
  function isDark() {
    return document.documentElement.dataset.resolvedTheme === 'dark';
  }
  function allFilters() {
    return Object.assign({}, filters, extraFilters);
  }

  /* What a channel actually passes: its own filter, cut off at the laser
   * blocking filter in front of the detectors. Matters most for a long-pass
   * emission filter like ET570lp, whose upper edge is set by the blocker and
   * not by the filter at all. */
  var effCache = {};
  function channelCurve(ch) {
    var f = allFilters()[ch.spectrum];
    if (!f || !f._curve) return null;
    var blocker = state.blockerNm || 700;
    var key = ch.spectrum + '@' + blocker;
    if (!effCache[key]) effCache[key] = SV.clipCurve(f._curve, blocker);
    return effCache[key];
  }

  function loadScope(sc) {
    state.scopeId = sc.id;
    state.scopeName = sc.name;
    state.blockerNm = sc.blockerNm == null ? 700 : sc.blockerNm;
    state.channels = (sc.channels || []).map(function (c) {
      return { name: c.name, label: c.label, spectrum: c.spectrum, filter: c.filter };
    });
    sortChannels();
    state.laserIds = (sc.lasers || [sc.laser]).filter(Boolean);
    if (!state.laserIds.length) state.laserIds = [CORE.lasers[0].id];
    state.activeLaserId = null;
    // a rig with two lasers fitted is presumed to be using them until the user
    // switches one off. How you work is not hardware, so neither the on/off
    // state nor the mode belongs in the config file.
    state.laserOff = {};
    if (state.laserMode !== 'sequential') state.laserMode = 'simultaneous';
    state.chosenWl = null;
  }

  /* Channels are always held in ascending centre-wavelength order, so every list
   * and table on the page reads blue-to-red like the emission chart above them. */
  function sortChannels() {
    // Unknown centres sort last rather than to zero: a channel whose curve has
    // not loaded yet must not push itself to the front of the list.
    var centre = function (c) {
      var v = filterCentre(c.spectrum);
      return v == null ? Infinity : v;
    };
    state.channels.sort(function (a, b) { return centre(a) - centre(b); });
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

  /* Some curves are a handful of measured points rather than a spectrum. Say so
   * under the chart, with the range they cover: outside it the curve reads zero,
   * so the recommender will never send you somewhere the dye was not tested. */
  function sparseNote(sel) {
    var sp = sel.filter(function (s) { return s.sparse && s.twopCurve; });
    if (!sp.length) return '';
    var lo = Math.min.apply(null, sp.map(function (s) { return s.twopCurve.x0; }));
    var hi = Math.max.apply(null, sp.map(function (s) { return s.twopCurve.x1; }));
    var names = sp.map(function (s) { return SV.escapeHtml(s.fluor.name); }).join(', ');
    return ' ' + names + ': measured on BrainSaw at a few wavelengths between ' +
      Math.round(lo) + ' and ' + Math.round(hi) + ' nm, in arbitrary units. Dots are ' +
      'the measurements, the lines between them are interpolation.';
  }

  /* Which 2p source to use for a selection entry, honouring the override. */
  function sourceFor(entry) {
    var f = byId[entry.id];
    if (!f) return null;
    if (entry.source && f.twop[entry.source]) return entry.source;
    if (f.twop[state.sourcePref]) return state.sourcePref;
    return ['D', 'Z', 'M', 'E', 'F'].filter(function (k) { return f.twop[k]; })[0] || null;
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
        sparse: !!(t && t.sparse),
        sat: (t && t.sufficient) || null,   // "bright enough" level, tracers only
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
    renderLasers();
    renderScopeControls();
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
      // Whatever is selected stays on the list, common or not: otherwise the
      // only way to unpick an uncommon dye is to go back out to the full list
      // and find it again. Unpicking it here is what makes it disappear.
      var picked = state.selected.some(function (s) { return s.id === f.id; });
      // an explicit search always reaches the uncommon ones
      if (state.commonOnly && !f.common && !q && !picked) return false;
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
        '<span class="src-tags">' + ['D', 'Z', 'M', 'E', 'F'].map(function (k) {
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
      var srcs = ['D', 'Z', 'M', 'E', 'F'].filter(function (k) { return s.fluor.twop[k]; });
      li.innerHTML =
        '<div class="sel-top">' +
          '<span class="sel-dot" style="background:' + s.color + '"></span>' +
          '<span class="sel-name">' + SV.escapeHtml(s.fluor.name) + '</span>' +
          '<button class="sel-remove" aria-label="Remove ' + SV.escapeHtml(s.fluor.name) + '">✕</button>' +
        '</div>' +
        '<div class="sel-bottom">' +
          '<div class="seg small" role="radiogroup" aria-label="Data source for ' + SV.escapeHtml(s.fluor.name) + '">' +
            ['D', 'Z', 'M', 'E', 'F'].map(function (k) {
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

  /* -- rail: lasers ------------------------------------------------------ */

  /* Only how the switched-on lasers combine. Running one laser is not a mode -
   * it is the other one switched off, which is what the rig actually does. */
  var LASER_MODES = [
    { id: 'simultaneous', label: 'All on together',
      note: 'Every beam on at once, so each fluorophore collects excitation from all of them.' },
    { id: 'sequential', label: 'One pass per laser',
      note: 'Image once with each laser and merge, so every fluorophore gets the beam that suits it.' },
  ];

  function renderLasers() {
    var list = $('laser-list');
    var all = rigLasers();
    var activeId = laser().id;
    var spare = (laserPlan(buildSelection()) || {}).spare || [];
    list.innerHTML = '';

    all.forEach(function (l, idx) {
      var li = document.createElement('li');
      li.className = 'chan-item' + (l.id === activeId && all.length > 1 ? ' is-active' : '');

      var sel = document.createElement('select');
      sel.className = 'laser-pick';
      CORE.lasers.forEach(function (opt) {
        var o = new Option(opt.name, opt.id);
        o.selected = opt.id === l.id;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        if (state.activeLaserId === state.laserIds[idx]) state.activeLaserId = sel.value;
        state.laserIds[idx] = sel.value;
        state.chosenWl = null;
        renderAll();
      });

      var text = document.createElement('span');
      text.className = 'chan-text';
      var range = document.createElement('span');
      range.className = 'chan-filter';
      range.textContent = l.tunable === false
        ? 'fixed line, ' + l.range[0] + ' nm'
        : l.range[0] + '–' + l.range[1] + ' nm';
      text.appendChild(sel);
      text.appendChild(range);

      var actions = document.createElement('span');
      actions.className = 'chan-actions';
      if (all.length > 1) {
        /* One switch per laser, showing what is on right now. A line the model
         * says you could do without is marked here rather than only in the
         * advice, so the suggestion is where the switch is. */
        var on = !state.laserOff[l.id];
        var sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'laser-sw ' + (on ? 'is-on' : 'is-off') +
          (on && spare.indexOf(l.id) >= 0 ? ' is-spare' : '');
        sw.textContent = on ? 'ON' : 'OFF';
        sw.title = on
          ? (spare.indexOf(l.id) >= 0
            ? 'On. This selection barely uses it — click to switch it off.'
            : 'On. Click to switch it off.')
          : 'Off. Click to switch it back on.';
        sw.addEventListener('click', function () {
          if (on && activeLasers().length < 2) {
            toast('Something has to be on. Switch the other laser on first.');
            return;
          }
          if (on) state.laserOff[l.id] = true; else delete state.laserOff[l.id];
          if (state.activeLaserId === l.id && on) state.activeLaserId = null;
          state.chosenWl = null;
          renderAll();
        });
        actions.appendChild(sw);

        // The Tune button only points the marker somewhere, so it is offered for
        // lasers that are on, tunable, and not already the one under the marker.
        if (l.id !== activeId && l.tunable !== false && !state.laserOff[l.id]) {
          var use = document.createElement('button');
          use.className = 'btn small ghost';
          use.type = 'button';
          use.textContent = 'Tune';
          use.title = 'Point the draggable marker at this laser';
          use.addEventListener('click', function () {
            state.activeLaserId = l.id;
            state.chosenWl = null;
            renderAll();
          });
          actions.appendChild(use);
        }
        var rm = document.createElement('button');
        rm.className = 'btn small ghost icon';
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove laser');
        rm.textContent = '✕';
        rm.addEventListener('click', function () {
          state.laserIds.splice(idx, 1);
          if (state.activeLaserId === l.id) state.activeLaserId = null;
          delete state.laserOff[l.id];
          state.chosenWl = null;
          renderAll();
        });
        actions.appendChild(rm);
      }

      li.appendChild(text);
      li.appendChild(actions);
      list.appendChild(li);
    });

    // mode only means anything once more than one laser is actually switched on
    var nOn = activeLasers().length;
    var modeWrap = $('laser-mode-wrap');
    modeWrap.hidden = nOn < 2;
    $('laser-mode').value = state.laserMode;
    var mode = LASER_MODES.filter(function (m) { return m.id === state.laserMode; })[0];
    $('laser-mode-note').textContent = mode ? mode.note : '';

    // the two-pass option is honest about not being buildable yet
    var warn = $('laser-mode-warning');
    warn.hidden = !(nOn > 1 && state.laserMode === 'sequential');
  }

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
        points: s.sparse ? curve.pts : null,
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
    // shade what no laser on the rig can reach, which with two of them is the
    // gap outside the union of their ranges rather than outside either one
    var covered = activeLasers().map(function (l) {
      return [Math.max(EXC_LO, l.range[0]), Math.min(EXC_HI, l.range[1])];
    }).filter(function (r) { return r[1] >= r[0]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    var cursor = EXC_LO;
    covered.forEach(function (r) {
      if (r[0] > cursor) {
        zones.push({ x0: cursor, x1: r[0], color: tint, label: 'outside laser range' });
      }
      cursor = Math.max(cursor, r[1]);
    });
    if (cursor < EXC_HI) {
      zones.push({ x0: cursor, x1: EXC_HI, color: tint, label: 'outside laser range' });
    }
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
    var markers = [];
    if (wl != null) {
      markers.push({
        id: 'wl', x: wl, color: cssVar('--accent'),
        draggable: L.tunable !== false,     // a fixed line has one wavelength
        label: wl + ' nm', width: 2,
      });
      // the other beams are shown too, but you cannot drag them - they belong to
      // a different laser, and only one is under the marker at a time
      var beams = (evaluateAt(sel, wl, rec) || {}).beams || [];
      beams.forEach(function (b, i) {
        if (i === rec.active || b.wl == null) return;
        markers.push({
          id: 'beam-' + b.laser.id, x: b.wl, color: cssVar('--text-muted'),
          label: b.wl + ' nm', width: 1.5, dash: [4, 4],
        });
      });
    }
    charts.exc.setMarkers(markers);

    $('exc-sub').textContent = gm
      ? 'Absolute action cross-section — only Drobizhev and Zipfel curves have absolute units'
      : 'Each curve normalised to its own peak between ' + CORE.normWindow[0] + ' and ' + CORE.normWindow[1] + ' nm';

    var missingGm = gm ? sel.filter(function (s) { return !s.gmCurve; }) : [];
    $('exc-foot').innerHTML = gm
      ? (missingGm.length
        ? 'Not shown in GM: ' + missingGm.map(function (s) { return SV.escapeHtml(s.fluor.name); }).join(', ') +
          ' — those curves are relative, not absolute cross sections. Switch to Relative to see them.'
        : 'Absolute cross-sections in Göppert-Mayer units.')
      : 'Drag the marker to test a wavelength. Drag across the plot to zoom, double-click to reset.' +
        (state.overlays.score ? ' “Suitability” is this tool’s score, not measured data.' : '') +
        sparseNote(sel);

    /* --- emission ------------------------------------------------------- */
    var emSeries = [];
    var fl = allFilters();

    if (state.overlays.filters) {
      state.channels.forEach(function (ch) {
        var f = fl[ch.spectrum];
        var curve = channelCurve(ch);
        if (!f || !curve) return;
        emSeries.push({
          id: 'ch-' + ch.spectrum, label: ch.name + ' · ' + shortName(f.name),
          color: filterColor(ch.spectrum), curve: curve, kind: 'band',
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
      combine: state.laserMode,
      activeId: laser().id,
      contextStrength: state.ctxStrength,
      minWl: state.minWl,
    };
  }
  var _recCache = null, _recKey = '';
  function currentRec(sel) {
    var key = JSON.stringify([state.selected.map(sourceFor), state.selected.map(function (s) { return s.id; }),
      state.laserIds, state.laserOff, state.laserMode, laser().id,
      state.objective, state.ctxStrength, state.minWl]);
    if (key === _recKey) return _recCache;
    _recKey = key;
    _recCache = sel.length ? SV.optics.recommend(sel, activeLasers(), recOpts()) : null;
    return _recCache;
  }
  /* Which of the switched-on lasers you actually need.
   *
   * A rig having two lines does not mean a session has to use both, and the tool
   * cannot tell which way to go: how much signal a fluorophore gives depends on
   * how well it is expressed in that brain, which only the person at the
   * microscope knows. So this works out the best answer with everything on and
   * the best answer with each line on its own, and hands both back as choices.
   *
   * The one thing it can say outright is when a beam contributes essentially
   * nothing to anything selected - eGFP gets 0.1 GM out of an Axon 1064 - and
   * then it says switch it off.
   */
  var SPARE_FRACTION = 0.05;    // below this share of a fluorophore, a beam is doing nothing
  var ANATOMY_CUTOFF = 950;     // above this a beam gives no background to register against
  var SOLO_FLOOR = 0.15;        // a one-line answer worth less than this is not an option
  var _planCache = null, _planKey = '';
  function laserPlan(sel) {
    var rec = currentRec(sel);              // sets _recKey, which keys this too
    var key = _recKey;
    if (key === _planKey && _planCache) return _planCache;
    var on = activeLasers();
    var plan = { rec: rec, on: on, spare: [], solo: null, all: null };
    /* Switching a line off has to be reversible from the same place it was
     * offered, or the suggestion is a one-way door. */
    if (rec && rec.best && rigLasers().length > on.length) {
      var all = SV.optics.recommend(sel, rigLasers(), recOpts());
      if (all && all.best && all.best.obj > rec.best.obj * 1.1) plan.all = all;
    }
    if (rec && rec.best && on.length > 1) {
      on.forEach(function (l, i) {
        // what this beam gives each fluorophore, as a share of what it gets
        var idle = rec.best.contrib.every(function (parts, fi) {
          var tot = rec.best.raw[fi];
          return !tot || parts[i] / tot < SPARE_FRACTION;
        });
        if (idle) plan.spare.push(l.id);
      });
      /* One alternative, not one per line. Dropping to a single beam is a real
       * choice only for the best of them, and only if that answer is worth
       * having - "1064 nm alone" scores zero for eGFP + mCherry and is not an
       * option, it is a mistake. And when a line is doing nothing there is no
       * trade-off to weigh: the advice just says switch it off. */
      if (!plan.spare.length) {
        on.forEach(function (l) {
          /* A line that cannot get below the anatomy cut-off is not something to
           * run on its own: an Axon 1064 by itself excites tdTomato beautifully
           * and leaves every other channel dark, so there is nothing to register
           * the sections against. It is a beam to add, not a beam to use alone. */
          if (l.range[0] >= ANATOMY_CUTOFF) return;
          var solo = SV.optics.recommend(sel, [l], Object.assign(recOpts(), { activeId: l.id }));
          if (!solo || !solo.best) return;
          if (solo.best.obj < SOLO_FLOOR * rec.best.obj) return;
          if (!plan.solo || solo.best.obj > plan.solo.rec.best.obj) {
            plan.solo = { laser: l, rec: solo };
          }
        });
      }
    }
    _planKey = key;
    _planCache = plan;
    return plan;
  }

  function chosenWavelength(rec) {
    if (state.chosenWl != null) return state.chosenWl;
    return rec && rec.best ? rec.best.wl : null;
  }

  function breakdown(sel) {
    state.channels.forEach(function (ch) { ch._curve = channelCurve(ch); });
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
      // say which yardstick, since comparing in GM and comparing in "% of own
      // peak" can land on different wavelengths
      var basis = n > 1 ? (rec && rec.absolute ? ', compared in GM' : ', compared as % of each own peak') : '';
      // Tracers are scored on clearing a signal floor, not on how bright they
      // get, so neither yardstick above describes what happened.
      var allSat = rec && rec.usable && rec.usable.length &&
        rec.usable.every(function (s) { return s.sat; });
      if (allSat) {
        subParts.push('Longest wavelength where ' +
          (n === 1 ? 'the dye is' : n === 2 ? 'both dyes are' : 'all ' + n + ' dyes are') +
          ' still bright enough.');
      } else {
        // The objective picker in the rail already says whether it is balancing
        // the weakest fluorophore or the average, so repeating it here just adds
        // jargon to the first line the user reads.
        subParts.push(n + ' fluorophore' + (n > 1 ? 's' : '') +
          (state.objective === 'balanced' ? '' : ', averaged') + basis + '.');
      }
    }
    // with more than one laser on the rig, the answer is a wavelength each -
    // the hero number is the one you are tuning, the rest are listed beneath
    var beams = $('hero-beams');
    beams.innerHTML = '';
    var focusBeams = focus && focus.beams ? focus.beams : (rec && rec.best ? rec.best.beams : null);
    if (focusBeams && focusBeams.length > 1) {
      subParts.push(state.laserMode === 'sequential'
        ? 'One pass per laser.'
        : 'Both beams on together.');
      focusBeams.forEach(function (b, i) {
        var span = document.createElement('span');
        span.className = 'beam' + (i === (rec ? rec.active : 0) ? ' is-active' : '');
        var who = (state.laserMode === 'sequential' && rec && focus)
          ? rec.usable.filter(function (u, k) { return focus.from[k] === i; })
              .map(function (u) { return u.fluor.name; })
          : [];
        span.innerHTML = '<b>' + b.wl + ' nm</b>' +
          '<i>' + SV.escapeHtml(b.laser.name) + (who.length ? ' · ' + SV.escapeHtml(who.join(', ')) : '') + '</i>';
        beams.appendChild(span);
      });
    }

    $('hero-sub').textContent = subParts.join(' ');

    // alternatives
    var alts = $('hero-alts');
    alts.innerHTML = '';
    if (rec) {
      var plan = laserPlan(sel);
      var on = plan.on;
      /* A chip is a whole configuration, not a wavelength: which lines are on
       * and what each is tuned to. With two beams "940 nm" and "920 nm &
       * 1064 nm" are different answers to the same question, and the user is
       * the one who knows whether the extra line is worth it. */
      var label = function (wls, lasers) {
        return lasers.map(function (l, i) { return wls[i] + ' nm'; }).join(' & ');
      };
      var chips = [];
      var picks = rec.candidates.slice(0, on.length > 1 ? 2 : 4);
      if (rec.best && wl !== rec.best.wl) {
        picks = [rec.best].concat(picks.filter(function (c) { return c.wl !== rec.best.wl; }));
      }
      picks.forEach(function (c) {
        if (c.wl === wl) return;
        chips.push({ text: label(c.wls, on), rel: c.obj / rec.best.obj, wl: c.wl, off: null,
          tip: 'Switch the marker to ' + c.wl + ' nm' });
      });
      // the way back: what the lines you have switched off would buy you. It is
      // better than where you are, by construction, so it leads.
      if (plan.all) {
        chips.unshift({
          text: label(plan.all.best.wls, rigLasers()),
          rel: plan.all.best.obj / rec.best.obj, wl: plan.all.best.wl, on: true,
          tip: 'Switch every fitted laser on and use them together',
        });
      }
      // and the same question asked of the best line on its own
      if (plan.solo) {
        chips.push({
          text: plan.solo.rec.best.wl + ' nm alone',
          rel: plan.solo.rec.best.obj / rec.best.obj,
          wl: plan.solo.rec.best.wl, off: plan.solo.laser.id,
          tip: 'Switch the other line off and use the ' + plan.solo.laser.name + ' by itself',
        });
      }
      chips.slice(0, 4).forEach(function (c) {
        var b = document.createElement('button');
        b.className = 'alt-btn';
        b.type = 'button';
        /* A share of the current answer, floored so a close second never reads
         * as 100% of the thing it lost to — and as a multiplier when the option
         * is the better one, because "99%" would be nonsense there. */
        b.textContent = c.text + (c.rel == null ? ''
          : c.rel > 1.02 ? ' · ' + c.rel.toFixed(1) + '×'
          : ' · ' + Math.min(99, Math.floor(c.rel * 100)) + '%');
        b.title = c.tip;
        b.addEventListener('click', function () {
          if (c.off) {
            on.forEach(function (l) { if (l.id !== c.off) state.laserOff[l.id] = true; });
            state.activeLaserId = c.off;
          }
          if (c.on) { state.laserOff = {}; state.activeLaserId = null; }
          state.chosenWl = c.wl;
          renderAll();
        });
        alts.appendChild(b);
      });
    }
    $('hero-alts-row').hidden = !alts.children.length;

    // per-fluorophore bars at the chosen wavelength
    var bars = $('hero-bars');
    bars.innerHTML = '';
    if (focus) {
      /* With two beams on the sample a fluorophore is excited by both, so the
       * bar has to combine them the same way the model does - otherwise
       * tdTomato reads 23% while an Axon sits on its peak. */
      var beamsFor = focus.beams || [];
      var excitation = function (s) {
        if (beamsFor.length < 2) return s.twopCurve.at(wl);
        var v = 0;
        beamsFor.forEach(function (b) {
          if (!b.pw) return;
          var t = s.twopCurve.at(b.wl);
          v = state.laserMode === 'sequential' ? Math.max(v, t) : v + t;
        });
        return v;
      };
      sel.forEach(function (s, i) {
        if (!s.twopCurve) return;
        var raw = excitation(s);
        /* A tracer's bar is a share of its own peak like everyone else's, but
         * for these dyes that is not the question - 5% of DiD's peak is still
         * plenty of signal. Flag which side of "enough" it falls on. */
        var flag = !s.sat ? '' :
          '<em class="bar-flag' + (raw >= s.sat ? '' : ' is-low') + '">' +
          (raw >= s.sat ? 'bright enough' : 'may be dim') + '</em>';
        var row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML =
          '<div><div class="bar-label"><i style="background:' + s.color + '"></i>' +
            '<span>' + SV.escapeHtml(s.fluor.name) + '</span>' + flag + '</div>' +
            '<div class="bar-track"><span class="bar-fill" style="width:' +
              (clamp(raw, 0, 1) * 100).toFixed(1) + '%;background:' + s.color + '"></span></div></div>' +
          '<div class="bar-val">' + pct(raw) + '</div>';
        row.title = s.fluor.name + ': ' + pct(raw) + ' of its own two-photon peak (' +
          (s.twopPeak ? Math.round(s.twopPeak) + ' nm' : 'unknown') + ')';
        bars.appendChild(row);
      });
      var hdr = document.createElement('p');
      hdr.className = 'rail-note';
      var where = beamsFor.length > 1
        ? (state.laserMode === 'sequential'
            ? 'in whichever pass suits it'
            : 'with both beams on')
        : 'at ' + wl + ' nm';
      hdr.textContent = 'Share of each fluorophore\u2019s own two-photon peak ' + where +
        ', before laser power and detection are applied.';
      bars.appendChild(hdr);
    }

    // channels to acquire. Background autofluorescence comes from the bluest
    // beam on the sample, so with two lasers running it is that one that decides
    // how much anatomical context there is - not the one you happen to be tuning.
    var bgWl = wl;
    var fb = focus && focus.beams ? focus.beams : null;
    if (fb && fb.length > 1) {
      bgWl = fb.reduce(function (m, b) { return b.pw > 0 ? Math.min(m, b.wl) : m; }, Infinity);
      if (!isFinite(bgWl)) bgWl = wl;
    }
    var bd = breakdown(sel);
    var plan = wl != null ? SV.optics.planChannels(
      bd.rows, state.channels,
      state.channels.map(function (c) { return filterCentre(c.spectrum) || 0; }),
      bgWl) : null;
    renderAcquire(plan, bgWl, bd, sel);

    // advice
    var items = SV.explain({
      rec: rec, focus: focus, selection: sel, laser: laser(),
      channels: state.channels, laserMode: state.laserMode, plan: laserPlan(sel),
      rig: rigLasers(),
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

  /* Candidate-shaped stats for an arbitrary wavelength of the active laser,
   * with any other lasers left where the recommendation put them. Uses the
   * recommender's own scorer so the two can never drift apart. */
  function evaluateAt(sel, wl, rec) {
    if (!rec || !rec.evalVec) return null;
    var base = (rec.best || rec.rawBest || {}).wls;
    var wls = base ? base.slice() : [wl];
    wls[rec.active] = wl;
    var r = rec.evalVec(wls);
    r.rel = rec.best && rec.best.obj ? r.obj / rec.best.obj : 1;
    return r;
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
          // named, because on a row headed by a fluorophore's channel a bare
          // "strong" reads as a verdict on the dye rather than on the tissue
          '<span class="acq-bg-label"><em>background</em>' +
            SV.escapeHtml(SV.optics.bgLabel(entry.bg)) + '</span>' +
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
      'Background indicates how much autofluorescence a channel ' +
      'sees at ' + wl + ' nm. Background fluorescence gradually falls off ' +
      'as the laser is tuned to longer wavelengths; the blue channel is lost first.';
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
      '<th>Capture</th></tr></thead>';
    var body = bd.rows.map(function (row, i) {
      var s = sel[i];
      if (!s.fluor._em) {
        return '<tr><td><span class="cell-name"><i style="background:' + s.color + '"></i>' +
          SV.escapeHtml(s.fluor.name) + '</span></td>' +
          '<td class="dim" colspan="' + (state.channels.length + 1) + '">no emission spectrum on file</td></tr>';
      }
      var cells = row.frac.map(function (v) {
        return '<td class="heat" style="--v:' + v.toFixed(3) + '"><span>' +
          (v < 0.005 ? '–' : pct(v)) + '</span></td>';
      }).join('');
      var cls = row.total < 0.05 ? 'warn' : row.total > 0.2 ? 'good' : '';
      return '<tr><td><span class="cell-name"><i style="background:' + s.color + '"></i>' +
        SV.escapeHtml(s.fluor.name) + '</span></td>' + cells +
        '<td><span class="badge ' + cls + '">' + pct(row.total) + '</span></td></tr>';
    }).join('');
    tbl.innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  /* -- provenance ------------------------------------------- */
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
    rigLasers().forEach(function (L) {
      out.push({ label: 'Laser', tag: 'nominal', text: L.name + ' — ' + L.note, modelled: true });
    });
    out.push({ label: 'Power model', tag: 'assumption', modelled: true,
      text: 'Wavelengths are judged on whether the laser\u2019s own output is enough, assuming ' +
        'typical losses between the laser and the sample. The tool does not know your rig\u2019s ' +
        'throughput, so it never states a power at the sample.' });

    $('provenance').innerHTML = '<ul class="prov-list">' + out.map(function (o) {
      return '<li class="prov-item"><b>' + SV.escapeHtml(o.label) + '</b>' +
        '<span class="tag' + (o.modelled ? ' modelled' : '') + '">' + SV.escapeHtml(o.tag) + '</span>' +
        '<span>' + SV.escapeHtml(o.text || '') + '</span></li>';
    }).join('') + '</ul>';
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

  /* `n` is the shard's file name, carried by every index entry. */
  function loadShard(n) {
    var key = String(n);
    if (shardCache[key]) return Promise.resolve(shardCache[key]);
    return fetch('data/filter-library/' + key + '.json').then(function (r) {
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

  /* -- the summary plot ---------------------------------------------------
   *
   * Opened in a window of its own rather than a panel or a dialog: it is a
   * reference you look things up in while working on the page behind it, and it
   * is longer than the page is tall.
   */
  function summaryGroups(commonOnly) {
    var groups = [{ rows: [] }, { rows: [] }, { rows: [] }];   // protein, Alexa, tracer
    CORE.fluorophores.forEach(function (f) {
      if (commonOnly && !f.common) return;
      // dTomato is tdTomato's curve halved, so with every row scaled to its own
      // peak the two are the same row twice
      if (f.id === 'dtomato') return;
      var src = sourceFor({ id: f.id });
      var t = src ? f.twop[src] : null;
      if (!t || !t._curve) return;                             // nothing to draw
      var g = /^alexa/.test(f.id) ? 1 : f.family === 'tracer' ? 2 : 0;
      groups[g].rows.push({
        name: f.name, curve: t._curve, sparse: !!t.sparse,
        color: SV.wavelengthLine(clamp(f.emMax || 520, 400, 700), false, 0.34),
      });
    });
    return groups.filter(function (g) { return g.rows.length; });
  }

  function openSummary(commonOnly) {
    var groups = summaryGroups(commonOnly);
    if (!groups.length) { toast('No two-photon data to plot'); return; }
    var cv = SV.summaryPlot.draw(groups, { scale: 2 });
    var title = (commonOnly ? 'Common' : 'All') + ' fluorophores — two-photon excitation';
    var w = window.open('', 'sv-summary-' + (commonOnly ? 'common' : 'all'),
      'width=' + Math.min(980, cv.width / 2 + 60) + ',height=820,scrollbars=yes');
    if (!w) { toast('Allow pop-ups to see the summary plot'); return; }
    var swatches = [0.05, 0.25, 0.5, 0.75, 1].map(function (v) {
      return '<i style="background:' + SV.summaryPlot.shade(v) + '"></i>';
    }).join('');
    w.document.open();
    w.document.write(
      '<!doctype html><meta charset="utf-8"><title>' + SV.escapeHtml(title) + '</title>' +
      '<style>' +
      'body{margin:0;padding:18px;background:#fff;color:#1b2430;' +
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}' +
      'h1{font-size:14px;margin:0 0 2px}' +
      'p{margin:0 0 12px;color:#4a5260}' +
      '.key{display:flex;align-items:center;gap:6px;margin:12px 0 0;font-size:11px;color:#4a5260}' +
      '.key i{width:20px;height:11px;display:block}' +
      'img{display:block;max-width:100%}' +
      'a{color:#2a78d6}' +
      '</style>' +
      '<h1>' + SV.escapeHtml(title) + '</h1>' +
      '<p>Each row is scaled to its own peak, so colours compare wavelengths within ' +
      'a fluorophore and not one fluorophore against another. Hatched cells are ' +
      'wavelengths nobody measured.</p>' +
      '<img src="' + cv.toDataURL('image/png') + '" width="' + (cv.width / 2) +
      '" alt="' + SV.escapeHtml(title) + '">' +
      '<div class="key"><span>low</span>' + swatches + '<span>own peak</span></div>' +
      '<p style="margin-top:12px"><a download="' +
      (commonOnly ? 'common' : 'all') + '-fluorophores-summary.png" href="' +
      cv.toDataURL('image/png') + '">Save this image</a></p>');
    w.document.close();
  }

  /* -- downloading a panel ------------------------------------------------
   *
   * The picture and the numbers behind it, zipped together. Read straight off
   * the chart's own series, so whatever is plotted is what is written: the
   * fluorophore curves, and on the excitation panel the laser power and
   * suitability traces too, on the emission panel the filters.
   *
   * Sampled at 1 nm over the panel's full range, not the zoomed view - a zoom is
   * a way of looking at the chart, not a statement about which data you wanted.
   */
  function panelCSV(key) {
    var c = charts[key];
    var series = (c.series || []).filter(function (s) { return s.curve; });
    if (!series.length) return null;
    var lo = Math.round(c.opts.xMin), hi = Math.round(c.opts.xMax);
    var head = ['wavelength_nm'].concat(series.map(function (s) {
      return String(s.label).replace(/[,"\n]/g, ' ');
    }));
    var rows = [head.join(',')];
    for (var wl = lo; wl <= hi; wl++) {
      var row = [wl];
      series.forEach(function (s) {
        // blank rather than zero outside a curve's measured range: the
        // difference between "no signal" and "nobody measured" matters
        row.push(wl < s.curve.x0 || wl > s.curve.x1 ? '' : round4(s.curve.at(wl)));
      });
      rows.push(row.join(','));
    }
    return rows.join('\n') + '\n';
  }

  function round4(v) { return Math.round(v * 1e4) / 1e4; }

  function panelName(key) {
    return key === 'exc' ? 'two-photon-excitation' : 'emission-and-filters';
  }

  /* What the CSV's numbers mean, since the columns alone do not say. */
  function panelReadme(key) {
    var when = new Date().toISOString().slice(0, 10);
    var lines = [
      'BrainSaw excitation and emission tool — ' + panelName(key),
      'Exported ' + when,
      '',
      'chart.png   the panel as displayed',
      'data.csv    one row per nm, one column per curve on the panel',
      '',
    ];
    if (key === 'exc') {
      lines.push(
        'Fluorophore columns are ' + (state.excUnits === 'gm'
          ? 'action cross-sections in GM.'
          : 'relative to each fluorophore’s own peak.'),
        'The two-photon data source is named in each column heading; see',
        '"Data & provenance" on the page for what each source is.',
        'Laser power is relative to that laser’s peak output.',
        'Suitability is this tool’s own score, not a measurement.');
    } else {
      lines.push(
        'Fluorophore columns are emission spectra relative to their own peak.',
        'Filter columns are transmission, 0 to 1.');
    }
    lines.push('', 'Empty cells are wavelengths where that curve has no data.');
    return lines.join('\n') + '\n';
  }

  function downloadPanel(key) {
    var c = charts[key];
    if (!c) return;
    var csv = panelCSV(key);
    if (!csv) { toast('Nothing plotted yet'); return; }
    var name = panelName(key);
    var blob = SV.zip([
      { name: name + '/chart.png', data: SV.zipFromDataURL(c.toPNG(2)) },
      { name: name + '/data.csv', data: SV.zipText(csv) },
      { name: name + '/README.txt', data: SV.zipText(panelReadme(key)) },
    ]);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.zip';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Saved ' + a.download);
  }

  /* ------------------------------------------------------------ url state */

  function compactState() {
    return {
      s: state.scopeId, sn: state.scopeName, bl: state.blockerNm,
      l: state.laserIds, lo: Object.keys(state.laserOff), lm: state.laserMode, la: laser().id,
      f: state.selected.map(function (x) { return x.id + (x.source ? ':' + x.source : ''); }),
      p: state.sourcePref, o: state.objective, c: state.ctxStrength, m: state.minWl,
      k: state.commonOnly ? 1 : 0, u: state.unitsLocked ? state.excUnits : null,
      w: state.chosenWl,
      ch: state.channels.map(function (c) {
        var f = allFilters()[c.spectrum];
        return { n: c.name, s: c.spectrum, f: f ? f.name : c.filter };
      }),
    };
  }

  /* A rig handed over in the URL, as BakingTray does: #cfg=<base64url JSON>.
   * Same object as a config file, so it goes down the same path. */
  function readConfigHash() {
    var m = /[#&]cfg=([^&]+)/.exec(location.hash);
    if (!m) return null;
    try {
      var json = decodeURIComponent(escape(atob(
        m[1].replace(/-/g, '+').replace(/_/g, '/'))));
      var cfg = JSON.parse(json);
      return cfg && cfg.channels ? cfg : null;
    } catch (e) { return null; }
  }

  var hashLock = false;
  function writeHash() {
    if (hashLock) return;
    try {
      var enc = btoa(unescape(encodeURIComponent(JSON.stringify(compactState()))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      history.replaceState(null, '', '#v1=' + enc);
      lsSet(LS_LAST, currentConfig());     // reopen on this rig next visit
    } catch (e) { /* URL state is a convenience; never break the page over it */ }
  }

  function readHash() {
    var m = /#v1=(.+)$/.exec(location.hash);
    if (!m) return false;
    try {
      var json = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))));
      var o = JSON.parse(json);
      // Start from the microscope the link names, so anything the link does not
      // carry (lasers, blocker, channels) comes from that rig rather than from
      // whatever happened to be loaded.
      loadScope(scopeById(o.s || state.scopeId));
      if (o.s) state.scopeId = o.s;
      if (o.sn) state.scopeName = o.sn;
      if (o.bl != null) state.blockerNm = o.bl;
      if (o.l) state.laserIds = Array.isArray(o.l) ? o.l : [o.l];
      state.laserOff = {};
      (o.lo || []).forEach(function (id) { state.laserOff[id] = true; });
      if (o.lm) state.laserMode = o.lm === 'single' ? 'simultaneous' : o.lm;
      if (o.la) state.activeLaserId = o.la;
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
        state.channels = o.ch.map(function (c) {
          return { name: c.n, spectrum: resolveChannelFilter({ spectrum: c.s, filter: c.f }), filter: c.f };
        });
      }
      return true;
    } catch (e) { return false; }
  }

  /* Shared-link channels may reference library filters that are not bundled in
   * bundled-filters.js, so pull their curves before the first render. */
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

  /* ------------------------------------------------- import / export UI */

  function renderScopeControls() {
    var ss = $('scope-select');
    if (ss.value !== state.scopeId ||
        !Array.prototype.some.call(ss.options, function (o) { return o.value === state.scopeId; })) {
      renderScopeOptions();
    }
    $('btn-forget-scope').hidden = !isSaved(state.scopeId);
  }

  function renderScopeOptions() {
    var ss = $('scope-select');
    ss.innerHTML = '';
    var built = document.createElement('optgroup');
    built.label = 'Built in';
    CORE.scopes.forEach(function (sc) { built.appendChild(new Option(sc.name, sc.id)); });
    ss.appendChild(built);
    var mine = savedScopes();
    if (mine.length) {
      var grp = document.createElement('optgroup');
      grp.label = 'Saved on this computer';
      mine.forEach(function (sc) { grp.appendChild(new Option(sc.name, sc.id)); });
      ss.appendChild(grp);
    }
    if (!scopeLibrary().some(function (sc) { return sc.id === state.scopeId; })) {
      var cur = document.createElement('optgroup');
      cur.label = 'Unsaved';
      cur.appendChild(new Option(state.scopeName, state.scopeId));
      ss.appendChild(cur);
    }
    ss.value = state.scopeId;
  }

  function slug(name) {
    return (name || 'microscope').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'microscope';
  }

  function saveConfig() {
    var name = window.prompt('Name for this microscope', state.scopeName || 'My microscope');
    if (name == null) return;
    name = name.trim();
    if (!name) return;

    state.scopeName = name;
    state.scopeId = slug(name);
    var cfg = currentConfig(name);

    // keep it on this machine as well as handing over the file, so it is in the
    // dropdown next time without having to load it again
    rememberScope(cfg);
    renderScopeOptions();

    var blob = new Blob([JSON.stringify(cfg, null, 2) + '\n'], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = slug(name) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Saved ' + a.download + ' and added it to the microscope list.');
    renderAll();
  }

  function loadConfigFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var cfg;
      try { cfg = JSON.parse(String(reader.result)); } catch (e) { cfg = null; }
      if (!cfg || !cfg.channels) { toast('That does not look like a microscope config.'); return; }
      adoptConfig(cfg, 'Loaded ' + (cfg.name || 'microscope') + '.');
    };
    reader.readAsText(file);
  }

  /* Shared by the file picker and the #cfg= handoff from BakingTray. */
  function adoptConfig(cfg, message) {
    if (!cfg.id) cfg.id = slug(cfg.name);
    applyConfig(cfg);
    rememberScope(currentConfig());
    renderScopeOptions();
    hydrateExternalFilters().then(function () {
      effCache = {};
      centreCache = {};
      sortChannels();
      renderAll();
      if (message) toast(message);
    });
  }

  /* ---------------------------------------------------------------- init */

  function bindUI() {
    // scope + laser
    var ss = $('scope-select');
    renderScopeOptions();
    ss.value = state.scopeId;
    ss.addEventListener('change', function () {
      loadScope(scopeById(ss.value));
      renderAll();
    });

    $('btn-save-config').addEventListener('click', saveConfig);
    $('btn-forget-scope').addEventListener('click', function () {
      if (!isSaved(state.scopeId)) return;
      if (!window.confirm('Remove "' + state.scopeName + '" from this computer? ' +
          'The config file you downloaded is not affected.')) return;
      forgetScope(state.scopeId);
      loadScope(CORE.scopes[0]);
      renderScopeOptions();
      renderAll();
    });
    $('btn-load-config').addEventListener('click', function () { $('config-file').click(); });
    $('config-file').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) loadConfigFile(e.target.files[0]);
      e.target.value = '';
    });

    $('btn-add-laser').addEventListener('click', function () {
      var taken = state.laserIds;
      var next = CORE.lasers.filter(function (l) { return taken.indexOf(l.id) < 0; })[0];
      if (!next) { toast('Every laser in the list is already fitted.'); return; }
      state.laserIds.push(next.id);
      if (state.laserIds.length === 2 && state.laserMode === 'single') {
        // the point of adding a second laser is usually to use both
        state.laserMode = 'simultaneous';
      }
      renderAll();
    });

    $('laser-mode').addEventListener('change', function (e) {
      state.laserMode = e.target.value;
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
      var sc = scope();
      loadScope(sc);
      effCache = {};
      renderAll();
      toast('Reset to ' + sc.name);
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
    $('btn-summary-common').addEventListener('click', function () { openSummary(true); });
    $('btn-summary-all').addEventListener('click', function () { openSummary(false); });
    document.querySelectorAll('[data-download-panel]').forEach(function (b) {
      b.addEventListener('click', function () { downloadPanel(b.dataset.downloadPanel); });
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
        'Could not load the data files in <code>data/</code>.</p>';
      return;
    }
    prepare();

    /* Dark unless this machine has said otherwise: the charts are luminous
     * traces on a dark ground, which is how they look on the rig. */
    var stored = 'dark';
    try { stored = localStorage.getItem('sv-theme') || 'dark'; } catch (e) { /* private mode */ }
    applyTheme(stored);

    /* Where the rig comes from, in order of authority:
     *   1. a #cfg= handoff (BakingTray opening the page with a rig on disk)
     *   2. a #v1= share link
     *   3. whatever was last in use on this machine
     *   4. the first built-in
     */
    var handed = readConfigHash();
    hashLock = true;
    var restored = handed ? false : readHash();
    hashLock = false;

    if (handed) {
      if (!handed.id) handed.id = slug(handed.name);
      applyConfig(handed);
      rememberScope(currentConfig());
    } else if (restored) {
      // readHash() has already loaded the microscope the link names
    } else {
      var last = lsGet(LS_LAST, null);
      loadScope(last && last.channels ? last : CORE.scopes[0]);
    }

    bindUI();
    makeCharts();

    hydrateExternalFilters().then(function () {
      // only now are all the curves present, so centres are known and the
      // blue-to-red ordering can be settled - including for shared links,
      // which carry whatever order they were saved in
      centreCache = {};
      effCache = {};
      sortChannels();
      renderAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})(window.SV || (window.SV = {}));
