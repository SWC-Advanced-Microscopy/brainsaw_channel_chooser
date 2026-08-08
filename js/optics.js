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
  var DEFAULT_MIN_WL = 760;
  var EM_LO = 380, EM_HI = 800;   // integration window for emission / detection

  /* ------------------------------------------------------ optical path */

  /* A channel's throughput is its bandpass transmission. */
  function channelThroughput(channel, filters) {
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

  var NICE = [1040, 1000, 980, 960, 940, 920, 900, 880, 860, 840, 820, 800, 780, 760];

  function niceness(wl) {
    if (wl % 50 === 0) return 3;
    if (wl % 20 === 0) return 2;
    if (wl % 10 === 0) return 1;
    return 0;
  }

  /* Score curve + ranked round-number candidates.
   *
   * `selection` is [{fluor, weight, source}], `laser` the active laser record.
   */
  function recommend(selection, laser, opts) {
    opts = opts || {};
    var mode = opts.mode || 'balanced';          // 'balanced' | 'total'
    var ctxStrength = opts.contextStrength == null ? 1 : opts.contextStrength;
    var minWl = opts.minWl == null ? DEFAULT_MIN_WL : opts.minWl;
    var range = laser ? laser.range : [700, 1100];
    var laserCurve = laser ? laser._curve : null;

    var lo = Math.max(minWl, Math.floor(range[0]));
    var hi = Math.min(1320, Math.ceil(range[1]));

    var usable = selection.filter(function (s) { return s.twopCurve; });
    if (!usable.length || hi < lo) return null;   // hi === lo for a fixed-line laser

    var scoreAt = function (wl) {
      var pw = powerWeight(laser, wl);
      var cw = contextWeight(wl, ctxStrength);
      var per = usable.map(function (s) {
        return Math.max(0, s.twopCurve.at(wl)) * pw * cw;
      });
      var obj;
      if (mode === 'total') {
        var wsum = 0, tot = 0;
        usable.forEach(function (s, i) { tot += per[i] * (s.weight || 1); wsum += (s.weight || 1); });
        obj = wsum ? tot / wsum : 0;
      } else {
        obj = Math.min.apply(null, per);
      }
      return {
        obj: obj, per: per, ctx: cw,
        power: laserCurve ? laserCurve.at(wl) : 1,   // fraction of the laser's peak
        mw: sampleMw(laser, wl),                     // mW at the sample, or null
      };
    };

    // full 1 nm score curve, for plotting and for finding the raw optimum
    var curveYs = [], best = { obj: -1, wl: null };
    for (var wl = lo; wl <= hi; wl++) {
      var s = scoreAt(wl);
      curveYs.push(round4(s.obj));
      if (s.obj > best.obj) { best = { obj: s.obj, wl: wl }; }
    }
    var scoreCurve = new SV.Curve({ x0: lo, dx: 1, y: curveYs });

    if (best.wl == null || best.obj <= 0) {
      return {
        scoreCurve: scoreCurve, best: null, candidates: [], allCandidates: [],
        usable: usable, range: [lo, hi], minWl: minWl,
      };
    }

    // Round candidates: every 10 nm in range, scored, then ranked by score with
    // a nudge towards rounder numbers so 920 wins over 930 when they tie.
    var cands = [];
    for (var c = Math.ceil(lo / 10) * 10; c <= hi; c += 10) {
      var sc = scoreAt(c);
      if (sc.obj <= 0) continue;
      cands.push({
        wl: c, obj: sc.obj, per: sc.per, power: sc.power, mw: sc.mw, ctx: sc.ctx,
        rel: sc.obj / best.obj,
        nice: niceness(c) + (NICE.indexOf(c) >= 0 ? 1 : 0),
      });
    }
    /* A single-line laser (an Axon) has no round wavelength inside its range,
     * so fall back to its one wavelength rather than returning nothing. */
    if (!cands.length) {
      var only = scoreAt(best.wl);
      cands.push({
        wl: best.wl, obj: only.obj, per: only.per, power: only.power, mw: only.mw,
        ctx: only.ctx, rel: 1, nice: niceness(best.wl),
      });
    }

    cands.sort(function (a, b) {
      // within 2% treat as equivalent and prefer the rounder / more conventional
      if (Math.abs(a.rel - b.rel) < 0.02) return b.nice - a.nice || b.obj - a.obj;
      return b.obj - a.obj;
    });

    var top = cands[0];

    /* Alternatives have to be genuine trade-offs, not just worse.
     *
     * An alternative is only offered if it beats the recommendation for at least
     * one selected fluorophore. Proposing 890 nm alongside 920 nm for eGFP +
     * tdTomato is nonsense - it is worse for both, i.e. strictly dominated, and
     * simply part-way down the same flank. 950 nm is worse for eGFP but better
     * for tdTomato, so it is a real choice and is worth showing.
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
      if (c.obj < 0.15 * top.obj) return;
      if (picks.some(function (p) { return Math.abs(p.wl - c.wl) < 30; })) return;
      // must be non-dominated by everything already offered, not just by the
      // top pick - otherwise 890 nm rides in behind 920 nm, which it loses to
      // for every fluorophore
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
      range: [lo, hi],
      minWl: minWl,
      mode: mode,
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
    sampleMw: sampleMw,
    contextWeight: contextWeight,
    recommend: recommend,
    EM_LO: EM_LO,
    EM_HI: EM_HI,
    POWER_REF: POWER_REF,
    DEFAULT_MIN_WL: DEFAULT_MIN_WL,
  };
})(window.SV || (window.SV = {}));
