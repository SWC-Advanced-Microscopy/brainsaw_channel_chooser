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
    /* With more than one beam, warn about whichever ones are actually short of
     * output - not about the one that happens to be under the marker. */
    if (best.beams && best.beams.length > 1) {
      best.beams.filter(function (b) { return b.pw > 0 && b.pw < 0.5; }).forEach(function (b) {
        items.push({ kind: 'warn', text:
          'The ' + b.laser.name + ' is short of output at ' + b.wl + ' nm, so that beam ' +
          'is the one that will limit you.' });
      });
    }

    var mw = best.beams && best.beams.length > 1 ? null : best.mw;
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

    // declared up here because the >950 nm advice below needs it too; when it
    // was declared further down that test silently read undefined and the
    // "best option at or below 950 nm" suggestion never appeared
    var anyTunable = (rec.lasers || [laser]).some(function (l) { return l.tunable !== false; });

    /* --- past the usual stopping point, for a peak -------------------------
     * A lone beam is normally held short of 940 nm so the other channels keep
     * some anatomy in them. It is let out only to reach a maximum sitting just
     * the far side of that, which is worth saying: the number looks like the
     * plateau-chasing the cap exists to prevent, and it is the opposite. */
    if (rec.cap && rec.capBase && rec.cap > rec.capBase && best.wl > rec.capBase &&
        rec.evalVec && best.raw) {
      var atBase = rec.evalVec([rec.capBase]);
      var jump = usable.map(function (s, i) {
        return { name: name(s), r: (atBase.raw[i] || 0) / (best.raw[i] || 1) };
      }).sort(function (a, b) { return a.r - b.r; })[0];
      if (jump && jump.r < 0.8) {
        items.push({ kind: 'info', text:
          best.wl + ' nm is redder than a single beam usually goes here, because ' +
          jump.name + ' peaks around it — ' + more(jump.r) + ' than at ' + rec.capBase +
          ' nm, and falling away again above. A peak that close is worth the ' +
          'background it costs; a curve that merely keeps climbing is not, which ' +
          'is why this does not run on further.' });
      }
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
      if (lower && lower.obj > 0 && !listed && anyTunable) {
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
    if (!anyTunable) {
      items.push({ kind: 'info', text:
        'The ' + laser.name + ' is a single-line source, so ' + best.wl + ' nm is not a ' +
        'recommendation — it is the only wavelength you have. The chart shows how well ' +
        'your selection is excited there.' });
    }

    /* --- the lone-beam cap --------------------------------------------------
     * Say what the cap cost, rather than quietly stopping. These curves change
     * slowly, so the exact number matters much less than knowing which way the
     * trade runs and that the user is allowed to move along it. */
    var capped = false;
    if (rec.cap && rec.beyond && best.wl >= rec.cap - 20) {
      var gains = usable.map(function (s, i) {
        return { name: name(s), r: rec.beyond.raw[i] / (best.raw[i] || 1) };
      }).filter(function (g) { return g.r > 1.2; })
        .sort(function (a, b) { return b.r - a.r; });
      if (gains.length) {
        /* Only offer a shorter wavelength if it is actually still a reasonable
         * place to sit. Past a steep flank it is not: eYFP at 920 nm is a third
         * of what it is at 960, and "works too" would be a lie. */
        var shorter = best.wl - 20;
        var back = rec.scoreCurve && shorter >= rec.minWl &&
          rec.scoreCurve.at(shorter) >= best.obj * 0.65
          ? Math.round(shorter / 10) * 10 : null;
        items.push({ kind: 'info', text:
          list(gains.map(function (g) { return g.name; })) +
          (gains.length > 1 ? ' keep' : ' keeps') + ' getting brighter above ' + rec.cap +
          ' nm — ' + gains[0].name + ' is ' + gains[0].r.toFixed(1) + '× at ' +
          Math.round(rec.beyond.wl / 10) * 10 + ' nm — and you can go there. What you give up is the ' +
          'background in the other channels, which is what you register sections ' +
          'against, so this stops at ' + rec.cap + ' nm rather than chasing the ' +
          'cross-section. ' + (back ? back + ' nm works too and leaves a little more of ' +
          'it. ' : '') + 'These spectra change slowly: ±10 nm is rarely the thing ' +
          'that matters.' });
        capped = true;
      }
    }

    /* --- do you need the second line? --------------------------------------
     *
     * A rig having two lines does not mean a session has to use both. Whether
     * the extra beam is worth it turns on how well the protein is expressed in
     * that particular brain, which this page cannot know and the person at the
     * microscope can. So it lays out the two configurations and lets them pick,
     * and only speaks plainly in the one case where a beam does nothing at all.
     */
    var plan = ctx.plan;
    if (plan && plan.on.length > 1) {
      plan.on.forEach(function (l, i) {
        if (plan.spare.indexOf(l.id) < 0) return;
        var rest = plan.on.filter(function (o) { return o.id !== l.id; });
        items.push({ kind: 'info', text:
          'The ' + l.name + ' is doing nothing for this selection — nothing here is ' +
          'excited at ' + best.beams[i].wl + ' nm. Switch it off and work with the ' +
          list(rest.map(function (o) { return o.name; })) + ' alone.' });
      });
      if (plan.solo) {
        var s = plan.solo;
        // whichever fluorophore has the most to lose by dropping the second line
        var weakest = usable.reduce(function (w, u, i) {
          var r = s.rec.best.per[i] / (best.per[i] || 1);
          return r < w.r ? { r: r, name: name(u) } : w;
        }, { r: Infinity, name: '' });
        items.push({ kind: 'info', text:
          'Two clear choices here. ' + s.rec.best.wl + ' nm on the ' + s.laser.name +
          ' alone is the best one-line answer, and one line is simpler. ' +
          best.beams.map(function (b) { return b.wl + ' nm'; }).join(' + ') + ' with both on ' +
          'gives ' + weakest.name + ' ' + more(weakest.r) + ', worth having if you ' +
          'suspect it is weakly expressed.' });
      }
    }

    /* --- the tracers -------------------------------------------------------
     *
     * Scored on sufficiency rather than brightness, so the headline number can
     * sit a long way off a dye's own peak and still be the right answer. Say so,
     * because the bar for DiD at 910 nm reads 5% and that looks like a mistake
     * until you know the bar is a share of its own peak, not of what you need.
     *
     * The escape hatch matters too: sufficiency assumes a decently coated
     * electrode. If the labelling is thin, the short end really is brighter. */
    var tracers = usable.filter(function (s) { return s.sat; });
    if (tracers.length) {
      var level = function (s) {
        var v = 0;
        (best.beams || []).forEach(function (b) {
          if (!b.pw) return;
          var t = s.twopCurve.at(b.wl) * b.pw;
          v = ctx.laserMode === 'sequential' ? Math.max(v, t) : v + t;
        });
        return v / s.sat;
      };
      var ample = tracers.filter(function (s) { return level(s) >= 1; });
      var thin = tracers.filter(function (s) { return level(s) < 1; });

      if (ample.length) {
        items.push({ kind: 'info', text:
          list(ample.map(name)) + ' ' + (ample.length > 1 ? 'are' : 'is') + ' judged on being ' +
          'bright enough rather than brightest: past a workable signal these dyes only bleed ' +
          'into neighbouring channels. ' + (ample.length > 1 ? 'They clear' : 'It clears') +
          ' that at ' + best.wl + ' nm, which is the better place to sit anyway — excitation ' +
          'is more even with depth and the green channel keeps enough background to register ' +
          'sections against.' });
      }
      if (thin.length) {
        items.push({ kind: 'warn', text:
          list(thin.map(name)) + ' ' + (thin.length > 1 ? 'are' : 'is') + ' below the signal ' +
          'these dyes usually give at ' + best.wl + ' nm. Fine if the labelling is heavy, ' +
          'thin if it is not.' });
      }
      // Where the short end is dramatically brighter, offer it as the answer to
      // weak labelling rather than as a recommendation.
      ample.forEach(function (s) {
        var pk = s.twopPeak;
        if (pk == null || Math.abs(pk - best.wl) < 30) return;
        var gain = s.twopCurve.at(pk) / (s.twopCurve.at(best.wl) || 1);
        if (gain < 1.5) return;
        items.push({ kind: 'info', text:
          'If your ' + name(s) + ' turns out faint — a thin coat on the electrode, say — ' +
          pk + ' nm is about ' + gain.toFixed(1) + '× brighter. Only worth moving there ' +
          'for that reason.' });
      });
    }

    /* --- alternatives ------------------------------------------------------ */
    (anyTunable ? rec.candidates : []).filter(function (c) {
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
    if (usable.length === 1 && anyTunable && !capped && (rec.lasers || []).length < 2) {
      var conv = CONVENTIONAL[usable[0].fluor.id];
      if (conv && Math.abs(conv.wl - best.wl) > 20) {
        var inRange = conv.wl >= Math.max(laser.range[0], rec.minWl) && conv.wl <= laser.range[1];
        var atConv = inRange ? usable[0].twopCurve.at(conv.wl) : 0;
        var atBest = usable[0].twopCurve.at(best.wl) || 1;
        items.push({ kind: 'info', text:
          conv.wl + ' nm is ' + conv.note + '. ' + (inRange
            ? 'On the ' + sourceLabel(ctx) + ' data that is ' + ratio(atConv / atBest) +
              ' of the cross-section you get at ' + best.wl + ' nm — often worth it anyway, ' +
              'since it sits closer to the laser’s power peak and is what everyone else uses.'
            : 'Your ' + laser.name + ' cannot reach it (' +
              Math.max(laser.range[0], rec.minWl) + '–' + laser.range[1] + ' nm).') });
      }
    }

    /* --- dTomato ------------------------------------------------------------
     * Almost nobody means to use it, and the name is one letter away from the
     * one they do mean, so say what it is before saying anything about it. */
    var dtom = (ctx.selection || []).filter(function (s) { return s.fluor.id === 'dtomato'; })[0];
    if (dtom) {
      // Only worth naming a laser if there is one fitted, switched off, and
      // markedly better for it than anything currently running.
      // Best signal each laser could actually deliver, power included: a Mai Tai
      // technically reaches 1040 nm but has little left there, which is exactly
      // the situation a fixed red line is bought to fix.
      var reach = function (l) {
        var c = dtom.gmCurve || dtom.twopCurve;
        if (!c) return 0;
        var v = 0;
        for (var w = Math.max(700, l.range[0]); w <= l.range[1]; w += 5) {
          v = Math.max(v, c.at(w) * SV.optics.powerWeight(l, w));
        }
        return v;
      };
      var onBest = (plan && plan.on ? plan.on : [laser]).reduce(function (m, l) {
        return Math.max(m, reach(l));
      }, 0);
      var longLine = (ctx.rig || []).filter(function (l) {
        return (plan ? plan.on : []).indexOf(l) < 0 && reach(l) > onBest * 1.25;
      })[0];
      items.push({ kind: 'info', text:
        'dTomato is the single unit that tdTomato is built from: tdTomato links two of ' +
        'them head to tail, so for the same number of molecules it absorbs about twice as ' +
        'much light. That is why tdTomato is the one people use. There is no published ' +
        'two-photon spectrum for dTomato, so what is plotted is tdTomato’s curve at half ' +
        'the cross-section — an estimate, not a measurement.' +
        (longLine ? ' With half the signal to work with, switch the ' + longLine.name +
          ' on — it reaches the 1052 nm peak that the rest of your rig does not.' : '') });
    }

    /* --- what experience says ----------------------------------------------
     * From notes/fluorophore_notes.md. These are things people here have found
     * at the microscope rather than anything the model can work out, so they
     * state the fact and stop: no suggested alternatives, no reasoning.
     */
    var picked = ctx.selection || [];
    var has = function (id) {
      return picked.some(function (s) { return s.fluor.id === id; });
    };
    var family = function (f) {
      return picked.filter(function (s) { return s.fluor.family === f; });
    };

    var farRed = family('farred');
    if (farRed.length) {
      var didToo = has('did');
      items.push({ kind: 'warn', text:
        list(farRed.map(name)) + (farRed.length > 1 ? ' are far red. Far-red' : ' is far red. Far-red') +
        ' fluorophores bleach quickly, which shows up as tiling artefacts in the ' +
        'overlap regions. They also tend to look worse under two-photon excitation ' +
        'than under one photon' + (didToo ? ', DiD being the exception.' : '.') });
    }

    if (has('irfp670')) {
      items.push({ kind: 'info', text:
        'iRFP670 looks good at 880 nm in a far-red channel, and should look better at ' +
        '850 nm, where its peak is. It bleaches quickly.' });
    }

    if (has('tdtomato')) {
      items.push({ kind: 'info', text:
        'tdTomato is more efficient at 1040 nm than at 920 nm, but the laser puts out ' +
        'much less power there. With good expression you get the same signal either way, ' +
        'because the fluorophore saturates. With weak expression — cFos-driven, say — ' +
        '920 nm can give you almost nothing while 1040 nm is fine.' });
    }

    if (has('egfp') && has('ebfp2') && has('mcherry')) {
      items.push({ kind: 'info', text:
        'A common three-colour combination, usually excited around 780 nm.' });
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

  function name(s) { return s.fluor.name; }

  /* Percentages stop reading as percentages past about half as much again. */
  function ratio(r) { return r > 1.5 ? r.toFixed(1) + '\u00d7' : pct(r); }

  /* "31% more" reads like a real number; "1× more" reads like a bug. */
  function more(r) {
    if (!(r > 0) || r >= 1) return 'more';
    var f = 1 / r;
    return f < 2 ? Math.round((f - 1) * 100) + '% more' : Math.round(f) + '× more';
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
