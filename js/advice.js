/* Turns the recommender's numbers into the sentences a microscopist wants.
 *
 * Every statement here is derived from the loaded data - the phrasing is
 * canned, the numbers and the conditions are not.
 */
(function (SV) {
  'use strict';

  var pct = function (v) { return Math.round(v * 100) + '%'; };

  /* Wavelengths labs actually dial in, where that is well established and can
   * differ from the peak of the measured cross-section. Kept deliberately short:
   * this is convention, not data, and it is always labelled as such. */
  var CONVENTIONAL = {
    egfp: { wl: 920, note: 'the usual GFP wavelength' },
    mcherry: { wl: 780, note: 'a common mCherry default' },
    tdtomato: { wl: 1040, note: 'the usual tdTomato wavelength where the laser reaches it' },
  };

  function explain(ctx) {
    var rec = ctx.rec, laser = ctx.laser;
    var items = [];
    if (!rec || !rec.best) {
      items.push({ kind: 'warn', text:
        'No usable excitation wavelength between ' + (rec ? rec.minWl : 760) + ' nm and the top of ' +
        'the ' + laser.name + ' range (' + laser.range[1] + ' nm) for this selection.' });
      return items;
    }

    // Explain the wavelength the user is actually looking at, which is the
    // suggestion until they drag the marker somewhere else.
    var best = ctx.focus || rec.best;
    var usable = rec.usable;

    /* Per-fluorophore percentages are deliberately NOT repeated here - they are
     * already in the bar chart above and in the chart's hover readout. */

    /* --- laser power -------------------------------------------------------
     *
     * Judged in absolute terms, not as a fraction of peak: what matters is
     * whether ~100 mW still reaches the sample. A laser well down its tuning
     * curve but still putting out a watt is not worth mentioning. */
    var mw = best.mw;
    if (mw != null) {
      /* Deliberately says nothing about milliwatts at the sample. What reaches
       * the sample depends on the rig's throughput, which this tool has no way
       * of knowing - it assumes a typical figure internally to decide whether a
       * wavelength is power-limited, and that assumption is not a measurement to
       * quote back at anyone. */
      if (mw < 60) {
        items.push({ kind: 'warn', text:
          'Your ' + laser.name + ' is near the end of its range at ' + best.wl + ' nm, and ' +
          'output there is low enough that you are likely to be power-limited — expect to ' +
          'run wide open and still be short of signal on deeper sections.' });
      } else if (mw < 100) {
        items.push({ kind: 'info', text:
          'Laser output is getting thin at ' + best.wl + ' nm. Fine for bright labels, ' +
          'marginal for dim ones — worth checking you have the headroom before a long run.' });
      }
    } else if (best.power < 0.35) {
      items.push({ kind: 'warn', text:
        'Your ' + laser.name + ' delivers roughly ' + pct(best.power) + ' of its peak output ' +
        'at ' + best.wl + ' nm, so this is a power-limited choice.' });
    }

    /* --- the >950 nm problem ---------------------------------------------- */
    if (best.wl > 950) {
      /* The scarcity of background autofluorescence up here is a property of the
       * sample and applies to every laser. Whether the laser is also running out
       * of power is a separate question, and only true of a Ti:Sapphire. */
      var txt = 'Above ~950 nm there is very little background autofluorescence, so the ' +
        'other channels give you almost no anatomical context to register sections against.';
      if (laser.kind === 'Ti:Sapphire' && best.mw != null && best.mw < 100) {
        txt += ' Ti:Sapphire output is falling away fast here too.';
      }
      items.push({ kind: 'info', text: txt });
      var lower = rec.allCandidates.filter(function (c) { return c.wl <= 950; })
        .sort(function (a, b) { return b.obj - a.obj; })[0];
      // skip if it is already going to be listed as an alternative below
      var listed = rec.candidates.some(function (c) { return lower && c.wl === lower.wl; });
      if (lower && lower.obj > 0 && !listed && laser.tunable !== false) {
        // the user can drag the marker anywhere, so "the alternative" is not
        // necessarily worse than where they are standing
        items.push({ kind: 'info', text: lower.obj > best.obj * 1.02
          ? 'If that matters more than raw signal, ' + lower.wl + ' nm is the best choice at ' +
            'or below 950 nm — and it scores better than ' + best.wl + ' nm anyway.'
          : 'If that matters more than raw signal, ' + lower.wl + ' nm is the best choice at or ' +
            'below 950 nm, at ' + pct(lower.obj / best.obj) + ' of the signal you would get at ' +
            best.wl + ' nm.' });
      }
    }

    /* --- fixed-line lasers -------------------------------------------------
     * Nothing to choose, so say what you have got rather than pretending. */
    if (laser.tunable === false) {
      items.push({ kind: 'info', text:
        'The ' + laser.name + ' is a single-line source, so ' + best.wl + ' nm is not a ' +
        'recommendation — it is the only wavelength you have. The chart shows how well ' +
        'your selection is excited there.' });
    }

    /* --- alternatives ------------------------------------------------------ */
    (laser.tunable === false ? [] : rec.candidates).filter(function (c) {
      return c.wl !== best.wl;
    }).slice(0, 2).forEach(function (c, altIndex) {
      var better = [], worse = [];
      usable.forEach(function (s, i) {
        // relative, not absolute: scored in GM the numbers are scaled by the
        // brightest fluorophore, so a fixed 0.08 step called almost everything
        // "worse" and nothing "better"
        if (!best.per[i]) return;
        var d = c.per[i] / best.per[i] - 1;
        if (d > 0.05) better.push(s.fluor.name);
        else if (d < -0.05) worse.push(s.fluor.name);
      });
      var ratio = best.obj ? c.obj / best.obj : 1;
      var txt = ratio > 1.02
        ? c.wl + ' nm scores better than ' + best.wl + ' nm (' +
          (ratio >= 1.5 ? ratio.toFixed(1) + '\u00d7' : pct(ratio) + ' of it') + ')'
        : c.wl + ' nm is ' + (altIndex === 0 ? 'the next best option' : 'also worth a look') +
          ' (' + pct(ratio) + ' of the score at ' + best.wl + ' nm)';
      if (better.length) txt += ', better for ' + list(better);
      if (worse.length) txt += (better.length ? ' but' : ',') + ' worse for ' + list(worse);
      items.push({ kind: 'alt', text: txt + '.', wl: c.wl });
    });

    /* --- convention vs the measured optimum -------------------------------- */
    if (usable.length === 1 && laser.tunable !== false) {
      var conv = CONVENTIONAL[usable[0].fluor.id];
      if (conv && Math.abs(conv.wl - best.wl) > 20) {
        var inRange = conv.wl >= Math.max(laser.range[0], rec.minWl) && conv.wl <= laser.range[1];
        var atConv = inRange ? usable[0].twopCurve.at(conv.wl) : 0;
        var atBest = usable[0].twopCurve.at(best.wl) || 1;
        items.push({ kind: 'info', text:
          conv.wl + ' nm is ' + conv.note + '. ' + (inRange
            ? 'On the ' + sourceLabel(ctx) + ' data that is ' + pct(atConv / atBest) +
              ' of the cross-section you get at ' + best.wl + ' nm — often worth it anyway, ' +
              'since it sits closer to the laser’s power peak and is what everyone else uses.'
            : 'Your ' + laser.name + ' cannot reach it (' +
              Math.max(laser.range[0], rec.minWl) + '–' + laser.range[1] + ' nm).') });
      }
    }

    /* --- fluorophores with no 2p data -------------------------------------- */
    (ctx.selection || []).forEach(function (s) {
      if (!s.twopCurve) {
        items.push({ kind: 'info', text:
          'No published two-photon spectrum for ' + s.fluor.name + ', so it is drawn on the ' +
          'emission chart and counted in the channel maths, but left out of the wavelength ' +
          'recommendation.' });
      }
    });

    return items;
  }

  /* Everything about where emission lands belongs with the channels, not with
   * the wavelength advice at the top of the page. */
  function explainDetection(ctx) {
    var items = [];

    (ctx.breakdown ? ctx.breakdown.rows : []).forEach(function (row) {
      if (!row.fluor._em) {
        items.push({ kind: 'info', text:
          'No emission spectrum on file for ' + row.fluor.name + ', so it is left out of ' +
          'these calculations.' });
        return;
      }
      if (row.total < 0.05) {
        items.push({ kind: 'danger', text:
          'Only ' + pct(row.total) + ' of ' + row.fluor.name + '\u2019s emission reaches any ' +
          'channel with this filter set. It is effectively invisible on this scope.' });
      } else if (row.purity < 0.6 && row.best >= 0) {
        items.push({ kind: 'warn', text:
          row.fluor.name + ' spreads across channels \u2014 only ' + pct(row.purity) +
          ' of its detected signal lands in ' + ctx.channels[row.best].name + '.' });
      }
    });

    (ctx.overlaps || []).forEach(function (o) {
      items.push({ kind: 'danger', text:
        o.a.name + ' and ' + o.b.name + ' fill the channels in almost the same proportions (' +
        pct(o.similarity) + ' similar), so this filter set cannot separate them.' });
    });

    return items;
  }

  /* Emission centre at or above this is "far red", where there is essentially no
   * tissue autofluorescence at any excitation wavelength. Saying "very little
   * background at 950 nm" there is misleading - it implies some other wavelength
   * would help, and none would. */
  var FAR_RED_NM = 650;

  /* Per-channel reasoning for the acquisition plan. */
  function channelReason(entry, plan, wl) {
    var bg = SV.optics.bgLabel(entry.bg);
    var farRed = entry.centre >= FAR_RED_NM;
    if (entry.role === 'signal') {
      var names = entry.fluors.map(function (f) { return f.name; });
      return 'Signal for ' + list(names) + '.';
    }
    if (entry.role === 'background') {
      if (plan.plan.length && plan.signals.length === 0) {
        return 'Nothing to image yet — this is where the anatomy would go.';
      }
      var best = plan.plan.reduce(function (a, b) { return b.bg > a.bg ? b : a; });
      var forced = plan.plan.filter(function (p) { return p.role !== 'signal'; }).length === 1;
      if (farRed) {
        return 'The only channel left, so it falls to this by default — but there is ' +
          'almost no autofluorescence in the far red at any excitation wavelength, ' +
          'so expect very little anatomical context from it.';
      }
      var txt = 'Anatomical reference — ' + bg + ' background at ' + wl + ' nm';
      if (forced) {
        txt += ', and the only channel left, so there is no choice here';
      } else if (best !== entry && best.role === 'signal') {
        txt += '. ' + best.channel.name + ' would collect more but it is carrying signal';
      }
      return txt + '.';
    }
    if (farRed) {
      return 'Very little autofluorescence in the far red at any excitation ' +
        'wavelength — only worth recording if you are imaging a far-red label.';
    }
    return 'Not needed — ' + bg + ' background at ' + wl + ' nm.';
  }

  /* Headline sentence for the acquisition plan. */
  function planSummary(plan, wl) {
    if (!plan.signals.length) return null;
    var sig = plan.signals.map(function (p) { return p.channel.name; });
    if (plan.noSpareChannel) {
      return { kind: 'warn', text:
        'Every channel is carrying signal, so there is no spare one for anatomy. ' +
        'You will have to register against one of the signal channels, or drop a fluorophore.' };
    }
    var bgName = plan.background ? plan.background.channel.name : null;
    var bgVal = plan.background ? plan.background.bg : 0;
    var msg = 'Acquire ' + list(sig) + ' for signal, plus ' + bgName + ' for anatomy';
    if (bgVal < 0.15) {
      return { kind: 'warn', text: msg + '. Be warned: at ' + wl + ' nm even ' + bgName +
        ' picks up very little background, so your anatomical context will be thin.' };
    }
    return { kind: 'good', text: msg + '.' };
  }

  function sourceLabel(ctx) {
    var s = ctx.selection && ctx.selection[0];
    var src = s && s.source;
    var meta = src && window.SV_CORE && window.SV_CORE.sources[src];
    return meta ? meta.label : 'measured';
  }

  function list(names) {
    if (!names.length) return 'nothing';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  SV.explain = explain;
  SV.explainDetection = explainDetection;
  SV.channelReason = channelReason;
  SV.planSummary = planSummary;
})(window.SV || (window.SV = {}));
