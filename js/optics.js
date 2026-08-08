/* Detection model, wavelength recommender and channel acquisition planner.
 *
 * The recommender answers: given these fluorophores and this laser, which
 * excitation wavelength should I tune to? It scores every 1 nm step and then
 * snaps to a round number, because nobody tunes to 927 nm.
 *
 * Score for one fluorophore at wavelength L:
 *
 *     s(L) = sigma2(L) * powerWeight(L) * contextWeight(L)
 *
 *   sigma2        the fluorophore's 2p curve, normalised to its own peak, so
 *                 s is "fraction of the best this fluorophore can do".
 *
 *   powerWeight   whether the laser can still put enough light on the sample at
 *                 L. This is an ABSOLUTE question, not a "how far down the
 *                 tuning curve am I" one: imaging wants around 100 mW at the
 *                 sample (70 mW for bright labels, 150-200 for dim ones), and
 *                 with ~80% loss through the optical path that means ~500 mW
 *                 out of the laser head as a floor and ~1 W as comfortable.
 *                 A laser sitting at 20% of its peak can still be entirely
 *                 fine. So the weight is 1 wherever there is enough power, and
 *                 falls off as the SQUARE of the shortfall below it, because
 *                 two-photon signal goes as the square of the power.
 *
 *                 Modelling this in relative terms was wrong twice over: it
 *                 pushed GFP towards 800 nm where a Ti:Sapph peaks, and it
 *                 penalised long wavelengths on lasers - an InSight, an Axon -
 *                 that have plenty of power there.
 *
 *   contextWeight a penalty above ~950 nm, for the one problem that is a
 *                 property of the sample rather than the laser: there is almost
 *                 no background autofluorescence that far out, so the other
 *                 channels give you nothing to register sections against. This
 *                 is why tdTomato alone is usually not imaged at 1050 nm even
 *                 though its S0->S1 peak sits at 1052 nm. Laser power at the red
 *                 end is powerWeight's business, not this one's.
 *
 * Short wavelengths are a hard floor rather than a penalty: below ~760 nm the
 * laser is less stable and the embedding agar autofluoresces heavily, so those
 * wavelengths are not used whatever the cross-section says. mCherry peaks at
 * 740 nm and is still imaged at 760+ for exactly that reason.
 *
 * Detection is modelled from the channel bandpass filters alone. The dichroics
 * that route light to them only trim edges the bandpass already defines, and PMT
 * quantum efficiency is common to every channel and not something anyone can
 * change, so neither would alter a decision.
 */
(function (SV) {
  'use strict';

  var SAMPLE_TARGET_MW = 100;   // power wanted at the sample for a typical scan
  var PATH_TRANSMISSION = 0.20; // fraction of head power that reaches the sample
  var POWER_EXP = 2;            // 2p signal goes as the square of the power
  var POWER_REF = 0.50;         // fallback for curves with no absolute data
  var CTX_FULL = 950;    // below this there is still usable background signal
  var CTX_SPAN = 110;    // nm above CTX_FULL over which the penalty ramps in
  var CTX_MAX = 0.4;
  /* Where a lone beam stops being sent. One beam has to do both jobs - excite
   * the label and leave the other channels enough autofluorescence to register
   * sections against - and past here the green channel's background is going.
   * A constraint rather than a cost, because a cost can always be outbid and
   * here it should not be: tdTomato is 60% brighter at 1010 nm than at 940, and
   * no penalty that is fair at 960 nm is heavy enough to refuse that. With a
   * second, bluer beam on the sample the anatomy is covered and the red one is
   * free to go wherever it likes, so this never applies to more than one. */
  var SOLO_CAP = 940;
  var DEFAULT_MIN_WL = 760;
  var EM_LO = 380, EM_HI = 800;   // integration window for emission / detection

  /* ------------------------------------------------------ optical path */

  /* A channel's throughput: its emission filter, already cut off at the laser
   * blocking filter by the page (channel._curve) if that has been worked out. */
  function channelThroughput(channel, filters) {
    if (channel._curve) return channel._curve;
    var bp = filters[channel.spectrum];
    return bp && bp._curve ? bp._curve : null;
  }

  /* Fraction of a fluorophore's emitted photons that this channel records. */
  function detectionEfficiency(fluor, throughput) {
    if (!fluor._em || !throughput) return 0;
    var captured = SV.integrate([fluor._em, throughput], EM_LO, EM_HI, 1);
    var total = SV.integrate([fluor._em], EM_LO, EM_HI, 1);
    return total > 0 ? captured / total : 0;
  }

  /* Per-fluorophore channel breakdown plus the normalised bleed-through row. */
  function channelBreakdown(fluorophores, channels, filters) {
    var throughputs = channels.map(function (c) {
      return channelThroughput(c, filters);
    });
    return {
      throughputs: throughputs,
      rows: fluorophores.map(function (f) {
        var eff = throughputs.map(function (tp) { return detectionEfficiency(f, tp); });
        var sum = eff.reduce(function (a, b) { return a + b; }, 0);
        var frac = eff.map(function (e) { return sum > 0 ? e / sum : 0; });
        var best = eff.indexOf(Math.max.apply(null, eff));
        return {
          fluor: f,
          eff: eff,
          frac: frac,
          total: sum,
          best: sum > 0 ? best : -1,
          purity: sum > 0 ? frac[best] : 0,
        };
      }),
    };
  }

  /* Pairs of fluorophores that land in the channels in near-identical
   * proportions, i.e. that cannot be told apart by this filter set. */
  function separability(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      for (var j = i + 1; j < rows.length; j++) {
        var a = rows[i].frac, b = rows[j].frac;
        var dot = 0, na = 0, nb = 0;
        for (var k = 0; k < a.length; k++) { dot += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
        var cos = (na && nb) ? dot / Math.sqrt(na * nb) : 0;
        if (cos > 0.9 && rows[i].total > 0.01 && rows[j].total > 0.01) {
          out.push({ a: rows[i].fluor, b: rows[j].fluor, similarity: cos });
        }
      }
    }
    return out.sort(function (x, y) { return y.similarity - x.similarity; });
  }

  /* --------------------------------------------- background / anatomy */

  /* How much useful background (autofluorescence) a channel picks up at a given
   * excitation wavelength - the anatomical context you register sections
   * against. A heuristic, not measured data.
   *
   * Two effects combine. Tissue and agar autofluorescence is intrinsically
   * brightest towards the blue end, which sets `base`. And it needs short
   * excitation: the bluer the emission, the sooner it dies off as the laser is
   * tuned redder, which sets `knee`. Blue's knee is low, which is why at 920 nm
   * the blue channel is a poor background choice and red is the better one,
   * while below ~800 nm blue is the obvious pick.
   */
  function backgroundYield(centre, wl) {
    var base, knee;
    if (centre < 500) { base = 1.00; knee = 820; }        // blue
    else if (centre < 560) { base = 0.85; knee = 940; }   // green
    else if (centre < 650) { base = 0.50; knee = 1000; }  // red
    else { base = 0.08; knee = 1000; }                    // far red
    var t = Math.max(0, Math.min(1, (wl - knee) / 120));
    return base * (1 - 0.85 * t);
  }

  function bgLabel(v) {
    return v >= 0.6 ? 'strong' : v >= 0.3 ? 'usable' : v >= 0.15 ? 'weak' : 'very little';
  }

  /* Decide what each channel is for.
   *
   * Every detectable fluorophore claims its best channel as a signal channel. Of
   * whatever is left over, the one with the most background at this excitation
   * wavelength becomes the anatomy channel - you always want one alongside your
   * signal channels. If nothing is left over, that is reported rather than
   * papered over: the choice has been made for you.
   */
  function planChannels(rows, channels, centres, wl, minCapture) {
    minCapture = minCapture == null ? 0.02 : minCapture;
    var plan = channels.map(function (c, i) {
      return {
        channel: c, index: i, centre: centres[i],
        role: 'skip', fluors: [],
        bg: backgroundYield(centres[i], wl),
      };
    });

    rows.forEach(function (row) {
      if (row.best >= 0 && row.total >= minCapture) {
        plan[row.best].role = 'signal';
        plan[row.best].fluors.push(row.fluor);
      }
    });

    var free = plan.filter(function (p) { return p.role !== 'signal'; });
    var background = null;
    if (free.length) {
      background = free.reduce(function (a, b) { return b.bg > a.bg ? b : a; });
      background.role = 'background';
    }

    return {
      plan: plan,
      background: background,
      noSpareChannel: !free.length,
      signals: plan.filter(function (p) { return p.role === 'signal'; }),
    };
  }

  /* --------------------------------------------------------- weighting */

  /* mW at the sample, given the laser and the losses in the optical path. */
  function sampleMw(laser, wl) {
    if (!laser || !laser._power) return null;
    return Math.max(0, laser._power.at(wl)) * PATH_TRANSMISSION;
  }

  /* 1 while there is enough power to image with, falling as the square of the
   * shortfall below that. Takes the whole laser record so it can work in mW. */
  function powerWeight(laser, wl) {
    var range = laser && laser.range;
    if (range && (wl < range[0] || wl > range[1])) return 0;

    var mw = sampleMw(laser, wl);
    if (mw != null) {
      if (mw <= 0) return 0;
      return Math.pow(Math.min(1, mw / SAMPLE_TARGET_MW), POWER_EXP);
    }

    // No absolute data (a hand-edited curve): fall back to relative weighting.
    var p = laser && laser._curve ? laser._curve.at(wl) : 1;
    if (p <= 0) return 0;
    return Math.pow(Math.min(1, p / POWER_REF), POWER_EXP);
  }

  /* 1.0 up to 950 nm, easing down above it. The ramp must NOT start earlier:
   * 920 nm is the standard GFP wavelength and has to score on its merits. */
  function contextWeight(wl, strength) {
    if (!strength || wl <= CTX_FULL) return 1;
    var t = Math.min(1, (wl - CTX_FULL) / CTX_SPAN);
    return 1 - CTX_MAX * strength * t;
  }

  /* ------------------------------------------------------- recommender */

  /* Wavelengths people actually dial in. Not merely round: 900 nm is rounder
   * than 920 nm but nobody images GFP at 900, so 920 has to outrank it when the
   * two score within a hair of each other. */
  var CONVENTIONAL_WL = [760, 780, 800, 840, 880, 920, 940, 960, 980, 1000, 1040];

  function niceness(wl) {
    if (CONVENTIONAL_WL.indexOf(wl) >= 0) return 3;
    if (wl % 50 === 0) return 2;
    if (wl % 20 === 0) return 1;
    if (wl % 10 === 0) return 0.5;
    return 0;
  }

  /* Wavelengths a laser can actually be asked for: its tuning range clipped to
   * the user's floor, on a `step` grid. A fixed-line laser offers its one line. */
  function laserGrid(laser, minWl, step) {
    var lo = Math.max(minWl, Math.ceil(laser.range[0]));
    var hi = Math.floor(laser.range[1]);
    if (hi < lo) return [];                       // cannot reach anything usable
    if (laser.tunable === false || hi === lo) return [Math.round((lo + hi) / 2)];
    var out = [];
    for (var w = Math.ceil(lo / step) * step; w <= hi; w += step) out.push(w);
    if (!out.length) out.push(Math.round((lo + hi) / 2));
    return out;
  }

  var NICE_BONUS = 0.03;   // how much a conventional wavelength is worth
  var MAX_COMBOS = 50000;

  function combos(grids) {
    var out = [[]];
    for (var i = 0; i < grids.length; i++) {
      var next = [];
      for (var a = 0; a < out.length; a++) {
        for (var b = 0; b < grids[i].length; b++) {
          next.push(out[a].concat([grids[i][b]]));
          if (next.length > MAX_COMBOS) return next;
        }
      }
      out = next;
    }
    return out;
  }

  /* Score curve + ranked candidates.
   *
   * `selection` is [{fluor, weight, source, gmCurve}], `lasers` the laser records
   * that are switched on (a single record is accepted too).
   *
   * `opts.combine` says what having more than one laser means:
   *
   *   'simultaneous'  every beam on at once, so a fluorophore collects excitation
   *                   from all of them and the contributions add.
   *   'sequential'    one pass per laser, each fluorophore imaged in whichever
   *                   pass suits it, so what counts is the best single pass.
   *
   * Only lasers that are switched on are passed in. Whether the second one
   * should be on is not decided here - the caller asks this function twice and
   * puts both answers in front of the user, because how much signal a
   * fluorophore gives depends on how well it is expressed in that brain.
   *
   * The >950 nm context penalty is applied once, from the SHORTEST wavelength in
   * use, not per beam: the background that gives you anatomy comes from the
   * bluest beam on the sample, and one such beam is enough.
   */
  function recommend(selection, lasers, opts) {
    opts = opts || {};
    if (!lasers) lasers = [];
    if (!Array.isArray(lasers)) lasers = [lasers];
    lasers = lasers.filter(Boolean);
    if (!lasers.length) return null;

    var mode = opts.mode || 'balanced';               // 'balanced' | 'total'
    var combine = opts.combine || 'single';
    var ctxStrength = opts.contextStrength == null ? 1 : opts.contextStrength;
    var minWl = opts.minWl == null ? DEFAULT_MIN_WL : opts.minWl;

    var usable = selection.filter(function (s) { return s.twopCurve; });
    if (!usable.length) return null;

    // Only bites on a single beam, and only while there is something usable
    // below it. A fixed line, or a rig that cannot tune down that far, is left
    // exactly where it is.
    var cap = (lasers.length === 1 && lasers[0].tunable !== false &&
               Math.max(minWl, lasers[0].range[0]) <= SOLO_CAP) ? SOLO_CAP : null;
    var withinCap = function (wls) {
      return cap == null || wls.every(function (w) { return w <= cap; });
    };

    // the laser the marker drags and the headline number belongs to
    var active = 0;
    if (opts.activeId != null) {
      lasers.forEach(function (l, i) { if (l.id === opts.activeId) active = i; });
    } else {
      for (var t = 0; t < lasers.length; t++) {
        if (lasers[t].tunable !== false) { active = t; break; }
      }
    }
    var aL = lasers[active];
    var lo = Math.max(minWl, Math.floor(aL.range[0]));
    var hi = Math.min(1320, Math.ceil(aL.range[1]));
    if (hi < lo) return null;

    /* Compare fluorophores in ABSOLUTE cross-section (GM) whenever every one of
     * them has it, exactly as the chart switches its own units.
     *
     * Normalising each fluorophore to its own peak silently assumes they are all
     * equally bright, and they are not: tdTomato peaks at 140 GM against eGFP's
     * 56. At 920 nm tdTomato sits at 23% of its own best, which reads as dire,
     * but 32 GM is still not far off eGFP's 55 - and pushing out to 980 nm to
     * "rescue" it costs eGFP half its signal to gain tdTomato very little in
     * absolute terms. Scored in GM, the best worst case lands at 940-950 nm.
     *
     * Scaled by the brightest fluorophore in the selection so the objective
     * stays in 0..1 and the score curve can share the chart's axis.
     */
    var absolute = usable.every(function (s) { return s.gmCurve; });
    var gmScale = 1;
    if (absolute) {
      gmScale = usable.reduce(function (m, s) {
        return Math.max(m, s.gmCurve.peak(700, 1320).y);
      }, 0) || 1;
    }
    /* The tracers are the exception to all of this. They are bright enough that
     * the gain has to come down to stop them saturating, and DiI bleeds into
     * every channel when it is driven hard, so "brightest" is the wrong target -
     * "clears the bar" is. Their score therefore rises to 1 at the sufficiency
     * level and stays there, which frees the wavelength to be chosen on other
     * grounds: 920 nm excites more evenly with depth and leaves enough green
     * background to register sections against, so a saturated tie goes long.
     * s.sat is the sufficiency level in the curve's own units. */
    var sigma = function (s, wl) {
      if (s.sat) return Math.min(1, Math.max(0, s.twopCurve.at(wl)) / s.sat);
      return absolute
        ? Math.max(0, s.gmCurve.at(wl)) / gmScale
        : Math.max(0, s.twopCurve.at(wl));
    };
    var allSaturating = usable.every(function (s) { return s.sat; });

    /* One wavelength vector, one row of numbers. */
    function evalVec(wls) {
      var pw = [], ctxWl = Infinity;
      for (var i = 0; i < lasers.length; i++) {
        var w = powerWeight(lasers[i], wls[i]);
        pw.push(w);
        if (w > 0 && wls[i] < ctxWl) ctxWl = wls[i];
      }
      var cw = contextWeight(isFinite(ctxWl) ? ctxWl : CTX_FULL, ctxStrength);

      var from = [];                       // sequential: which pass each fluor uses
      var clears = allSaturating;          // every dye already bright enough here
      var contrib = [];                    // what each beam gives each fluorophore
      var raw = [];                        // before the anatomy penalty
      var per = usable.map(function (s) {
        var v = 0, pick = 0, parts = [];
        for (var i = 0; i < lasers.length; i++) {
          var term = sigma(s, wls[i]) * pw[i];
          parts.push(term);
          if (combine === 'sequential') {
            if (term > v) { v = term; pick = i; }
          } else {
            v += term;
          }
        }
        from.push(pick);
        contrib.push(parts);
        if (v < 0.999) clears = false;
        raw.push(v);
        return v * cw;
      });

      var obj;
      if (mode === 'total') {
        var wsum = 0, tot = 0;
        usable.forEach(function (s, i) { tot += per[i] * (s.weight || 1); wsum += (s.weight || 1); });
        obj = wsum ? tot / wsum : 0;
      } else {
        /* Balanced. A strict worst case reads well and behaves badly: put two
         * beams on the sample and the weakest fluorophore's total stops moving,
         * so the minimum goes flat and the answer slides to an arbitrary point
         * on the plateau. eGFP + mCherry on a Mai Tai and an Axon 1064 landed on
         * 820 nm, throwing away half of eGFP to lift mCherry by 4.7 GM on top of
         * the 22 GM the fixed line already gave it.
         *
         * The harmonic mean fixes that while keeping what the minimum was for:
         * it still collapses to zero if anything is left unexcited, so a
         * fluorophore cannot be abandoned, but it will not trade a large loss
         * for a token gain. */
        var inv = 0, iw = 0, dead = false;
        usable.forEach(function (s, i) {
          var w = s.weight || 1;
          if (per[i] <= 0) dead = true;
          else { inv += w / per[i]; iw += w; }
        });
        obj = (dead || !inv) ? 0 : iw / inv;
      }
      var tot = per.reduce(function (a, b) { return a + b; }, 0);
      return {
        wls: wls, wl: wls[active], obj: obj, tot: tot, per: per, ctx: cw, from: from,
        clears: clears, raw: raw, contrib: contrib,
        power: aL._curve ? aL._curve.at(wls[active]) : 1,
        mw: sampleMw(aL, wls[active]),
        beams: lasers.map(function (l, i) {
          return { laser: l, wl: wls[i], pw: pw[i], mw: sampleMw(l, wls[i]) };
        }),
      };
    }

    /* --- the raw optimum, over every combination on a 2 nm grid ---------- */
    var fine = combos(lasers.map(function (l) { return laserGrid(l, minWl, 2); }));
    var best = null, beyond = null;
    fine.forEach(function (v) {
      var r = evalVec(v);
      // what the cap is costing, so the advice can say so rather than just
      // quietly stopping at 940 nm
      if (!withinCap(v)) {
        if (!beyond || r.tot > beyond.tot) beyond = r;
        return;
      }
      if (!best || r.obj > best.obj * 1.0001) { best = r; return; }
      if (r.obj <= best.obj * 0.9999) return;
      // Every dye already over the bar both ways: nothing is bought by going
      // brighter, so take the longer wavelength.
      if (r.clears && best.clears) { if (r.wl > best.wl) best = r; return; }
      // ties on the worst case are broken by total signal: if eGFP is the
      // limiting fluorophore either way, take the option that also gives
      // tdTomato more rather than the first one found
      if (r.tot > best.tot) best = r;
    });
    if (!best || best.obj <= 0) {
      return {
        scoreCurve: null, best: null, candidates: [], allCandidates: [],
        usable: usable, range: [lo, hi], minWl: minWl, lasers: lasers,
        active: active, combine: combine, absolute: absolute, gmScale: gmScale,
      };
    }

    /* --- 1 nm sweep of the active laser, others held at the optimum ------ */
    var curveYs = [];
    for (var wl = lo; wl <= hi; wl++) {
      var v2 = best.wls.slice();
      v2[active] = wl;
      curveYs.push(round4(evalVec(v2).obj));
    }
    var scoreCurve = new SV.Curve({ x0: lo, dx: 1, y: curveYs });

    /* --- round-number candidates ----------------------------------------- */
    var cands = [];
    combos(lasers.map(function (l) { return laserGrid(l, minWl, 10); })).forEach(function (v) {
      if (!withinCap(v)) return;
      var r = evalVec(v);
      if (r.obj <= 0) return;
      r.rel = r.obj / best.obj;
      var tunables = 0;
      r.nice = lasers.reduce(function (n, l, i) {
        if (l.tunable === false) return n;
        tunables++;
        return n + niceness(v[i]);
      }, 0);
      /* Being a wavelength people actually dial in is worth a few per cent of
       * score, no more. As a sort key rather than a tolerance band, so the
       * ordering is a real ordering: 920 nm beats 930 nm for eGFP + tdTomato on
       * two beams, where the old within-2% test missed it by a third of a per
       * cent and handed back 930. */
      r.rank = r.obj * (1 + NICE_BONUS * (tunables ? r.nice / (3 * tunables) : 0));
      cands.push(r);
    });
    if (!cands.length) {
      cands.push(Object.assign(evalVec(best.wls), { rel: 1, nice: 0, rank: best.obj }));
    }

    cands.sort(function (a, b) {
      // with every dye already over its floor, score says nothing: go long
      if (a.clears && b.clears) return b.wl - a.wl || b.nice - a.nice;
      return b.rank - a.rank || b.tot - a.tot;
    });

    var top = cands[0];

    /* Alternatives have to be genuine trade-offs, not just worse.
     *
     * An alternative is only offered if it beats everything already on offer for
     * at least one selected fluorophore. Proposing 890 nm alongside 920 nm for
     * eGFP + tdTomato is nonsense - it is worse for both, i.e. strictly
     * dominated, and simply part-way down the same flank.
     *
     * With a single fluorophore nothing can beat the optimum for it, so there are
     * correctly no alternatives at all.
     */
    var beats = function (c, p) {
      return c.per.some(function (v, i) { return v > p.per[i] * 1.02; });
    };

    var picks = [top];
    cands.forEach(function (c) {
      if (picks.length >= 4) return;
      if (c.obj < 0.4 * top.obj) return;   // not a real option, just a local bump
      if (picks.some(function (p) { return Math.abs(p.wl - c.wl) < 20; })) return;
      if (!picks.every(function (p) { return beats(c, p); })) return;
      picks.push(c);
    });

    return {
      scoreCurve: scoreCurve,
      rawBest: best,
      best: picks[0] || null,
      candidates: picks,
      allCandidates: cands,
      usable: usable,
      lasers: lasers,
      active: active,
      combine: combine,
      range: [lo, hi],
      minWl: minWl,
      mode: mode,
      cap: cap,             // a lone beam is not sent past this, for anatomy
      beyond: beyond,       // the best the cap ruled out, so it can be explained
      absolute: absolute,   // scored in GM rather than "% of own peak"
      gmScale: gmScale,
      evalVec: evalVec,     // so the page can score a dragged marker the same way
    };
  }

  function round4(v) { return Math.round(v * 1e4) / 1e4; }

  SV.optics = {
    channelThroughput: channelThroughput,
    detectionEfficiency: detectionEfficiency,
    channelBreakdown: channelBreakdown,
    separability: separability,
    backgroundYield: backgroundYield,
    bgLabel: bgLabel,
    planChannels: planChannels,
    powerWeight: powerWeight,
    laserGrid: laserGrid,
    sampleMw: sampleMw,
    contextWeight: contextWeight,
    recommend: recommend,
    EM_LO: EM_LO,
    EM_HI: EM_HI,
    POWER_REF: POWER_REF,
    DEFAULT_MIN_WL: DEFAULT_MIN_WL,
  };
})(window.SV || (window.SV = {}));
