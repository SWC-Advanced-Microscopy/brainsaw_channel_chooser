# The brief

This tool was written by Claude (Anthropic) working from a spoken-style brief
given interactively by Rob Campbell. This document synthesises that brief into
one place: what was asked for, what was decided along the way, and why the
opinionated parts are the way they are. It is the reference for anyone picking
the project up — including a future model.

---

## 1. Origin and goal

Two existing SWC things were the starting point:

- [`2p_crosssection_viewer`](https://github.com/SWC-Advanced-Microscopy/2p_crosssection_viewer) —
  a simple web plot of two-photon cross-sections, deployed at
  <https://swcmicroscopy.com/2p-cross-section/>. Its data directory is the source
  of the Drobizhev (`D`) and Zipfel (`Z`) curves.
- [`BakingTray/+channelChooser`](https://github.com/SWC-Advanced-Microscopy/BakingTray/tree/master/code/%2BBakingTray/%2BchannelChooser) —
  an unfinished MATLAB GUI meant to suggest an excitation wavelength.

The goal: **one slick, responsive page** that replaces the first and finishes the
job the second started. The user picks fluorophores; the page overlays their 2p
excitation spectra, shows where their emission lands in the microscope's filters,
and recommends a wavelength to tune to — with reasoning.

Explicitly allowed: not a copy of the old applet, and free to use a different
plotting approach if better.

## 2. Hardware

The default microscope is
[BrainSaw 1](https://github.com/SWC-Advanced-Microscopy/swc-advanced-microscopy.github.io/wiki/BrainSaw-1):

| Channel | Filter |
|---|---|
| Blue | Semrock FF01-460/60 |
| Green | Semrock FF01-525/39 |
| Red | Chroma ET605/70m |
| Far red | Semrock FF01-676/29 |

Laser: Spectra-Physics MaiTai eHP DeepSee (~690–1040 nm).

**Dichroics are deliberately ignored.** The rig has FF635-Di01 and a Thorlabs
DMSP490R, but they only trim edges the bandpass filters already define, so
detection is modelled from the bandpasses alone. This also removed the one curve
that had to be modelled rather than measured (Thorlabs does not serve
machine-readable data to scripts).

**PMT quantum efficiency was removed** after being built. It is common to every
channel and the user cannot change it, so it cannot change a decision. Channel
throughput plots went for the same reason: correct, but too much detail.

Channels remain fully configurable — any of ~4,000 FPbase filters can be swapped
in, and the whole setup is shareable via the URL.

## 3. Fluorophore list

Requested structure: a **"Show common only" checkbox, on by default**, with
everything else still reachable behind it. Searching always finds uncommon
entries even when the box is ticked.

- **Common (12):** eBFP2, eCFP, eGFP, eYFP, mOrange2, tdTomato, DsRed2, mRuby2,
  mCherry, Alexa 488 / 568 / 594.
- **Uncommon:** everything else — the cyans, yellows, oranges, all far-reds, the
  red calcium sensors, and the 1p-only entries below.
- **Deleted outright:** mEGFP, Superfolder GFP.
- **Naming:** lower-case leading `e` — eGFP, eYFP, eCFP, eBFP2.

Additions requested: **tdStayGold, DiO, DiI, DiD**.

> FPbase has no `tdStayGold` entry (only StayGold, StayGold-E138D, mStayGold,
> mStayGold2), so the parent **StayGold** was used. None of the four have a
> published two-photon spectrum. Rather than drop them, they are kept as
> **1p-only** entries: drawn on the emission chart, counted in the channel maths,
> excluded from the wavelength recommendation, with the UI saying so.

**Venus** joined that group by accident and is worth recording: its FPbase "2P"
spectrum actually spans 300–700 nm, so it vanished when the data was clipped. The
build now keeps any entry with a real emission spectrum as 1p-only rather than
dropping it silently.

## 4. Data sources

| Data | Source | Units | Code |
|---|---|---|---|
| 2p spectra | Drobizhev *et al.* 2011 | absolute (GM) | `D` |
| 2p spectra | Zipfel lab, Cornell | absolute (GM) | `Z` |
| 2p spectra | FPbase | relative | `F` |
| 1p ex/em | FPbase | normalised | |
| Filter transmission | FPbase filter library | fraction | |

`D` is the default preference, per the brief ("prefer the D curves, the Z look
odd"), overridable globally and per fluorophore.

**Chroma was checked as a 2p source and does not have one.** Its open API
(`/api/sv/data-providers/{fluorochromes,dyes,filters}`) exposes 203 fluorochromes
and 913 dyes, none with two-photon data. FPbase's 2P collection — largely
Drobizhev-derived — serves as the third source instead.

### Wavelength range

2p curves are **clipped at 740 nm** and normalised over 740–1100 nm. The clip
moved 680 → 700 → 740 during development. 740 was chosen because the curves have
already fallen away by that point, so they enter the plot smoothly instead of
being sliced through mid-rise, and it sits below the 760 nm recommendation floor,
so nothing usable is lost.

A side effect worth knowing: this changes reported peaks for the reds. tdTomato
now reads 1052 nm / 140 GM instead of 684 nm, because the short-wavelength band
that used to dominate normalisation is gone. These are the more useful numbers.

## 5. The wavelength recommender

For each fluorophore at each 1 nm step:

```
score = sigma2(L) x powerWeight(L) x contextWeight(L)
```

- **`sigma2`** — the 2p curve normalised to its own peak.
- **`powerWeight` saturates.** Above ~50% of the laser's peak power, more power
  does not improve the answer. Without saturation the model recommends 800 nm for
  GFP, where a Ti:Sapph peaks, instead of 920 nm. Nobody is power-limited on GFP
  at 920 on a healthy eHP.
- **`contextWeight`** penalises above ~950 nm — Ti:Sapph output falls away, and
  there is little background autofluorescence to give anatomical context for
  registering sections. This is why tdTomato alone is not imaged at 1050 nm
  despite its peak sitting there. Adjustable via a slider.

**760 nm is a hard floor, not a penalty.** Below it the laser is less stable and
the embedding agar autofluoresces heavily, so those wavelengths are not used
whatever the cross-section says — mCherry peaks at 740 nm and is still imaged at
760+. Editable in the rail. An earlier "scattering and photodamage" penalty was
rejected as untrue and removed.

Multiple fluorophores combine as the **worst case** (default) or the **average**.
The 1 nm optimum is snapped to a round number, preferring conventional values
within 2%.

### Alternatives must be genuine trade-offs

An alternative is only offered if it **beats the recommendation for at least one
selected fluorophore** (Pareto non-dominance). Proposing 890 nm alongside 920 nm
for eGFP + tdTomato is meaningless — worse for both, merely part-way down the same
flank. With a single fluorophore nothing can beat its own optimum, so no
alternatives appear, which is the honest answer.

### A correction worth remembering

The nominal MaiTai tuning curve was originally far too pessimistic at the long end
(32% of peak at 950 nm; a real eHP DeepSee holds ~60%). That suppressed everything
above 900 nm and hid sensible choices. It was corrected, which moved tdTomato from
760 → 980 nm and eGFP + tdTomato from 920 → 980 nm.

**The laser curve drives every recommendation above ~900 nm and is inferred, not
measured.** Because `powerWeight` saturates and the corrected curve is flat across
750–1000 nm, the >950 nm penalty is now the main brake on long wavelengths.
Measuring the actual rig would materially improve the answers. If a result reads
too red, strengthen the penalty rather than re-touching the laser curve.

## 6. Which channels to acquire

Requested behaviour: **there must always be a background channel alongside the
signal channels**, because you need anatomy to register sections against.

Every detectable fluorophore claims its best channel for signal. Of whatever is
left, the channel seeing the most background at the chosen wavelength becomes the
anatomy channel. If nothing is left, that is stated rather than papered over.

Background yield is a **heuristic, labelled as such**: autofluorescence is
brightest towards the blue and needs short excitation, and the bluer the emission
the sooner it dies off as the laser tunes redder. The two cases from the brief
that it must reproduce:

| Selection @ 920 nm | Result |
|---|---|
| eGFP | Green signal, **Red** anatomy — blue collects too little that far out |
| eGFP + tdTomato | Green + Red signal, **Blue** anatomy, by force rather than choice |

**Far red is never useful for background** at any excitation wavelength. It must
not say "very little background at 950 nm", which implies some other wavelength
would help. It says there is almost none in the far red at any wavelength, and
that the channel is only worth recording for an actual far-red label.

## 7. Presentation rules

These came up repeatedly and are worth stating as rules:

1. **Emission belongs with emission.** Anything about where light lands —
   bleed-through, uncapturable fluorophores, inseparable pairs — goes in the
   channels area, never in the wavelength notes at the top. This was corrected
   twice.
2. **Do not repeat what a chart already shows.** Per-fluorophore "% of its own
   peak" statements were removed: the bar chart and the marker hover already
   carry them.
3. **State the problem, do not prescribe the fix.** The inseparable-pair warning
   ends at "this filter set cannot separate them" — no suggestion of linear
   unmixing. That is out of scope.
4. **No advice the user cannot act on.** Suggestions that a different laser would
   do better were removed; the laser is not something they can change.
5. Channel order is always **blue → red**, matching the emission chart above.
6. Charts use a **single y axis**; overlays that would need a second scale are
   expressed in the same relative units or dropped.
7. Modelled or heuristic values are always labelled where they appear.

## 8. Deployment

Self-contained static site, destined for
<https://github.com/SWC-Advanced-Microscopy/brainsaw_channel_chooser>, to be
embedded in the GitHub Pages site alongside the existing 2p-cross-section page.
Standalone and iframe-embeddable, so it is not at the mercy of the host site's
CSS.

Data is emitted as both `.json` and `.js`, and the page loads the `.js` variants
via plain `<script>` tags, so **it works straight off the filesystem** — the
explicit pain point in the old viewer's README. Only the on-demand filter library
needs an HTTP server.

## 9. Still open

- The MaiTai tuning curve should be measured (see §5).
- Whether 980 nm is the right answer for an eGFP + tdTomato pair, or whether the
  >950 nm penalty should be stronger.
