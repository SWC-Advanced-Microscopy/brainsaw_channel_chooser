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

- **Common (13):** eBFP2, eCFP, eGFP, eYFP, tdTomato, DsRed2, mCherry,
  Alexa 488 / 568 / 594, and the tracers DiI, DiO, DiD (in that order).
  mOrange2 and mRuby2 were moved out to uncommon.
- **Uncommon:** everything else — the cyans, yellows, oranges, all far-reds, the
  red calcium sensors, and the 1p-only entries below.
- **Deleted outright:** mEGFP, Superfolder GFP.
- **Naming:** lower-case leading `e` — eGFP, eYFP, eCFP, eBFP2.

Additions requested: **tdStayGold, DiO, DiI, DiD**. The three carbocyanine
tracers have their own family chip, **Tracers**, rather than being scattered
across the emission colours: you reach for "a tracer" first and pick the colour
that stays clear of your labels second.

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
- **`powerWeight` is absolute, in mW at the sample.** See §9 — a laser well down
  its tuning curve but still delivering a watt is fine, so the question is never
  "how far down the curve am I" but "is there still ~100 mW at the sample". The
  weight is 1 wherever there is enough, and falls as the square of the shortfall
  below it, because two-photon signal goes as the square of the power.
- **`contextWeight`** penalises above ~950 nm, for the one problem up there that
  belongs to the sample rather than the laser: there is little background
  autofluorescence to give anatomical context for registering sections. This is
  why tdTomato alone is not imaged at 1050 nm despite its peak sitting there.
  Adjustable via a slider.
- **Multiple fluorophores are compared in absolute GM** when all of them have it.
  Normalising each to its own peak assumes they are equally bright; tdTomato
  peaks at 140 GM and eGFP at 56, so eGFP + tdTomato belongs at 940 nm, not out
  at 980 chasing a percentage.
- **The round-number snap prefers conventional wavelengths, not merely round
  ones.** 900 nm is rounder than 920 nm and wins any tie on roundness alone,
  which is wrong for GFP.

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

The laser was originally modelled as a *fraction of peak*, and the assumed MaiTai
shape was far too pessimistic at the long end. Both were wrong, and §9 replaced
them: tuning curves are now absolute mW from manufacturer datasheets, and the
question they answer is whether ~100 mW still reaches the sample. That removed
the need to guess how pessimistic a curve should be, and it stopped the model
penalising the red end of lasers — an InSight, an Axon — that have power to
spare there.

**Alternatives must also be non-dominated by the other alternatives**, not just by
the top pick. Otherwise 890 nm rides in behind 920 nm, which beats it for every
fluorophore.

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
   This has to survive a shared link too: channels arrive from the URL in
   whatever order they were saved in, and the sort only settles once every
   filter curve has loaded and its centre is known.
6. Charts use a **single y axis**; overlays that would need a second scale are
   expressed in the same relative units or dropped.
7. Modelled or heuristic values are always labelled where they appear.
8. **Never state a power at the sample.** The model needs a throughput figure to
   decide whether a wavelength is power-limited, and assumes one, but what
   actually reaches the sample depends on a rig calibration this tool does not
   have. Quoting the assumption back as a number would be presenting a guess as a
   measurement. Talk about the laser's own output instead.
9. Do not show a column that carries no decision — the matrix's "Assigned"
   column just repeated the largest number in its own row.

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


## 9. Lasers
You need to understand how the laser works in this scenario. We image at with the laser by scanning it over the sample to record emitted photons at each location and build up an image over time on the PC. We scan with a power of around 100 mW at the sample most times. For really bright stuff we may go down to around 70 mW at the sample. For dimmer cases maybe about 150 mW. We rarely do 200 mW. A laser will typically emit somewhere between 750 mW and 4 W depending on the laser source itself and the wavelength. There are significant loses in the optical pathway. Those loses will be different for different rigs but let's estimate them as 80%. So a 1W output should give us enough power: around 200 mW. But a 600 mW output, say, might not. Thus your model of the laser tuning curve does not have to as strict as it is. This should help you answer these issues you brought up:

- The MaiTai tuning curve should be measured (see §5).
- Whether 980 nm is the right answer for an eGFP + tdTomato pair, or whether the >950 nm penalty should be stronger.

We have wavelength tunable lasers. These are Ti:Sph lasers such as the SpectraPhysics Mai Tai, SpectraPhysics Insight, Coherent Chameleon and Coherent Discovery, and LightConversion Cronus-2p. Then we have single line lasers, such as the Coherent Axon 1064. These are fibre lasers. Not Ti:Sph. 
So when the user, for example, sets the web app to a 1040 nm single line laser you should be careful with printing things like "Above ~950 nm there is very little background autofluorescence, so the other channels give you almost no anatomical context to register sections against. Ti:Sapphire output is also falling away fast here." There is no Ti:Sph output here. Plus the single line lasers have much power. So the it's true background is low but it's not true we lack power in this case.

### What §9 changed

Acted on in full:

- **Power is absolute, not relative.** `SAMPLE_TARGET_MW = 100`,
  `PATH_TRANSMISSION = 0.20`, and a square-law falloff below the target. Both
  open questions at the end of §9 are answered by this: the Mai Tai curve no
  longer needs measuring for the model to behave (only for exact numbers), and
  the >950 nm penalty did not need strengthening.
- **Laser kind is respected in the prose.** "Ti:Sapphire output is falling away
  fast here too" is now appended only when the laser really is a Ti:Sapphire
  *and* it really is short of power there. The background-scarcity sentence
  stands on its own, because that is true of every laser.
- **Fixed-line lasers say so.** Their range is pinned to the single wavelength,
  no alternatives are offered, and the text states plainly that this is the only
  wavelength available rather than a recommendation.
- **The generic 1040 nm laser is gone**, replaced by the Coherent Axon 1064
  (and an Axon 920 alongside it).

Lasers modelled, all from published datasheet figures at typical rather than
worst-case output:

| Laser | Kind | Range | Anchors |
|---|---|---|---|
| Mai Tai eHP DeepSee | Ti:Sapphire | 690–1040 | >2.6 W @ 800, >1.38 W @ 920, >330 mW @ 1040 |
| Mai Tai HP DeepSee | Ti:Sapphire | 690–1040 | same shape, ~12% lower |
| InSight X3 | OPO | 680–1300 | 1.4 W @ 800, 1.8 W @ 900, 1.6 W @ 1000, 1.2 W @ 1200 |
| Chameleon Ultra II | Ti:Sapphire | 680–1080 | 3.5 W @ 800, 1.6 W @ 920, 550 mW @ 1020, 200 mW @ 1080 |
| Chameleon Discovery NX | OPO | 660–1320 | 3.6 W @ 800, 3.2 W @ 900, 2.7 W @ 1000, 1.9 W @ 1300 |
| CRONUS-2P | OPCPA | 680–1300 | >3 W @ 920 (output A), >2.5 W @ 1100 (output B) |
| Axon 920 / Axon 1064 | Fibre | fixed | 1 W |

Not found and therefore not modelled: per-unit measured tuning curves for any of
these (manufacturers publish guaranteed minima at a few wavelengths plus a graph,
not tabulated data), and the Coherent Discovery's and CRONUS-2P's fixed secondary
outputs, which are separate beams rather than points on a tuning curve.
