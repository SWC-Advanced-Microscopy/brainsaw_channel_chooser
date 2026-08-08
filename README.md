# Two-photon spectra & wavelength chooser

An interactive viewer that overlays two-photon excitation spectra and one-photon
emission spectra on a microscope's filter set, and suggests an excitation
wavelength to tune to.

Built for [SWC Advanced Microscopy](https://swcmicroscopy.com/). It is a
fancier successor to
[2p_crosssection_viewer](https://github.com/SWC-Advanced-Microscopy/2p_crosssection_viewer),
and it folds in the job the MATLAB
[`+channelChooser`](https://github.com/SWC-Advanced-Microscopy/BakingTray/tree/master/code/%2BBakingTray/%2BchannelChooser)
GUI started: given a set of fluorophores, tell the user what wavelength to use.

## What it does

- **Two-photon excitation chart** — overlays the 2p spectra of the selected
  fluorophores from 740 nm up, with the laser tuning curve and a "suitability"
  score. Shows absolute GM automatically whenever every selected fluorophore has
  absolute data, falling back to "% of own peak" when any of them does not; the
  hover readout gives both (`48.3 GM (86%)`).
- **Emission chart** — emission spectra over the detection channels' bandpass filters.
- **Wavelength recommendation** — a suggested round-number wavelength, ranked
  alternatives, and plain-English reasoning about the trade-offs.
- **Channels to acquire** — which detectors to record, and which spare channel to
  use for the anatomical background you register sections against. Anything to do
  with where emission lands — bleed-through, uncapturable fluorophores, pairs the
  filter set cannot separate — is reported here rather than with the wavelength
  advice at the top.
- **Channel assignment** — how each fluorophore splits across the channels, what
  fraction of its emission is captured at all, and which pairs the filter set
  cannot separate.
- **Configurable hardware** — BrainSaw 1 loads by default; any channel can be
  swapped for any of ~4,000 filters from the FPbase library, and the whole setup
  is encoded in the URL so it can be shared.

## Running it

It is a static site with no build step and no dependencies. Open `index.html`
directly, or serve the directory:

```
python3 -m http.server
```

The data is emitted as both `.json` and `.js`, and the page loads the `.js`
variants via plain `<script>` tags, so **it works straight off the filesystem** —
unlike the previous viewer. The only feature that needs an HTTP server is the
on-demand filter library (`data/filters/*.json`), which is fetched lazily when
you open the filter picker.

## Deploying

Copy this directory into the GitHub Pages site and embed it. Because it is a
self-contained app rather than a content block, an iframe keeps it clear of the
site's own CSS:

```html
<iframe src="/two-photon-chooser/" style="width:100%;height:90vh;border:0"
        title="Two-photon spectra and wavelength chooser"></iframe>
```

## Rebuilding the data

```
python3 build/fetch_data.py
```

This pulls from FPbase and from the Drobizhev/Zipfel CSVs in the old viewer's
repo, and writes `data/`. Downloaded spectra are cached in `build/.cache/`, so a
re-run to change how the data is shaped does not re-download ~4,000 curves.

Edit `CURATED` in `build/fetch_data.py` to change the fluorophore list and which
entries count as "common" (the short list shown by default), `ONE_PHOTON_ONLY` for
entries with no published two-photon curve, and `BRAINSAW` for the default
microscope and its channels.

## Data sources

| Data | Source | Units |
|---|---|---|
| 2p spectra, "D" | Drobizhev *et al.* 2011, [doi:10.1038/nmeth.1596](https://doi.org/10.1038/nmeth.1596) | absolute (GM) |
| 2p spectra, "Z" | [Zipfel lab, Cornell](https://www.drbio.cornell.edu/cross_sections.html) | absolute (GM) |
| 2p spectra, "F" | [FPbase](https://www.fpbase.org) | relative |
| 1p excitation / emission | FPbase | normalised |
| Filter transmission | FPbase filter library | fraction transmitted |

Chroma's spectra viewer was checked as a two-photon source and does not have
one — its open API exposes 203 fluorochromes and 913 dyes, none with 2p data. The
FPbase 2P collection (99 spectra, largely Drobizhev-derived) is used instead.

FPbase has no `tdStayGold` entry, so the parent **StayGold** is used. StayGold,
DiO, DiI, DiD and Venus have no usable two-photon spectrum — Venus's FPbase "2P"
curve actually spans 300–700 nm, so it disappears once the data is clipped. All
five are drawn on the emission chart and counted in the channel maths, but sit out
of the wavelength recommendation, and the UI says so. Anything with an emission
spectrum is kept this way rather than dropped silently.

Two things on the page are **not** measured data and are labelled as such:

- **Laser tuning curves** — absolute average power in mW, interpolated from the
  minima manufacturers publish at a handful of wavelengths, at roughly typical
  rather than worst-case output. Edit `LASERS` in `build/fetch_data.py` to match
  your own rig.
- **Background estimates** in "Channels to acquire" — a heuristic for how much
  tissue and agar autofluorescence a channel sees, not a measurement.

Channels are modelled from their bandpass filters alone. The dichroics that route
light to them (FF635-Di01, DMSP490R) only trim edges the bandpass filters already
define. PMT quantum efficiency is left out for the same reason it would not change
a decision: it is common to every channel and nobody can change it.

## How the recommendation works

For each fluorophore, at each 1 nm step:

```
score = sigma2(L) x powerWeight(L) x contextWeight(L)
```

- `sigma2` is the 2p curve normalised to its own peak, so the score reads as
  "fraction of the best this fluorophore can do".
- `powerWeight` asks an **absolute** question: can the laser still put enough
  light on the sample here? A scan wants around 100 mW at the sample (70 for
  bright labels, 150–200 for dim ones), and roughly 80% is lost in the optical
  path, so ~500 mW out of the head is the floor and 1 W is comfortable. The
  weight is 1 wherever there is enough, and falls as the *square* of the
  shortfall below it, since two-photon signal goes as the square of the power.
  A laser at 20% of its peak can be entirely fine — which is why this is not
  modelled as a fraction of peak. Doing that was wrong twice over: it pushed GFP
  towards 800 nm where a Ti:Sapph peaks, and it penalised the red end on lasers
  that have plenty of power there.
- `contextWeight` penalises above ~950 nm, for the one thing up there that is a
  property of the sample rather than the laser: there is little background
  autofluorescence to give anatomical context for registering sections.

With more than one fluorophore selected, they are compared in **absolute GM**
whenever all of them have it — the same condition that switches the chart's own
units. Normalising each to its own peak silently assumes they are equally bright,
and they are not: tdTomato peaks at 140 GM against eGFP's 56, so 23% of tdTomato's
best is still 32 GM, close to eGFP's 55. Scored that way the eGFP + tdTomato pair
lands at 940 nm rather than being dragged out to 980 to rescue a percentage that
was never the point.

Short wavelengths are a **hard floor**, not a penalty: nothing below 760 nm is
ever suggested, because the laser is less stable there and the embedding agar
autofluoresces heavily. mCherry's cross-section peaks at 740 nm and the tool still
sends you to 760. The floor is editable in the rail.

Nothing below 740 nm is stored or plotted at all — the curves are clipped there
and normalised over 740–1100 nm. Cutting at 740 rather than lower means the curves
have already fallen away by the left edge instead of being sliced through mid-rise,
and it is comfortably below the 760 nm floor for recommendations, so nothing usable
is lost.

Multiple fluorophores are combined either as the **worst case** (default, so
nothing is left unusable) or the **average**. The 1 nm optimum is then snapped to
a round number, preferring conventional values when they score within 2%.

**Alternatives are only offered when they are genuine trade-offs.** A candidate
has to beat the recommendation for at least one selected fluorophore. Suggesting
890 nm next to 920 nm for eGFP + tdTomato is meaningless — it is worse for both,
i.e. strictly dominated, and merely part-way down the same flank. With a single
fluorophore nothing can beat its own optimum, so no alternatives are shown, which
is the honest answer.

The >950 nm penalty is the opinionated part and is a slider — set it to zero to
score on measured cross-section and laser power alone.

The round-number snap prefers **wavelengths people actually dial** over merely
round ones: 900 nm is rounder than 920 nm, but nobody images GFP at 900.

Sanity checks against normal practice: eGFP → 920 nm, mCherry → 760 nm (its
740 nm peak is below the floor), tdTomato → 1040 nm on an InSight or a Discovery
and 1010 nm on a Mai Tai, which runs out of power past that, eGFP + tdTomato →
940 nm with 960, 920 and 980 offered as alternatives.

### Lasers

| Laser | Range | Notes |
|---|---|---|
| Spectra-Physics Mai Tai eHP / HP DeepSee | 690–1040 nm | Ti:Sapphire; ~2.7 W at 800 nm, 330 mW at 1040 |
| Spectra-Physics InSight X3 | 680–1300 nm | ~2 W right across the red end |
| Coherent Chameleon Ultra II | 680–1080 nm | Ti:Sapphire; 3.5 W at 800 nm, 210 mW at 1080 |
| Coherent Chameleon Discovery NX | 660–1320 nm | Watts everywhere; fixed 1040 nm second beam not modelled |
| Light Conversion CRONUS-2P | 680–1300 nm | Two tunable outputs treated as one range; fixed 1025 nm output not modelled |
| Coherent Axon 920 / 1064 | fixed | Single-line fibre lasers, 1 W. Nothing to recommend — the page just shows how well your selection does there |

Fixed-line lasers are pinned to their one wavelength, so the page reports how
well the selection is excited rather than pretending to choose.

### Which channels to acquire

Every detectable fluorophore claims its best channel for signal. Of whatever is
left, the channel seeing the most background at the chosen wavelength becomes the
anatomy channel — you always want one alongside your signal channels.

Background falls off as the laser is tuned redder, and soonest for the bluest
channels. So eGFP at 920 nm gives green for signal and **red** for anatomy, since
blue collects little background that far out; add tdTomato and red is taken, so
blue becomes the anatomy channel by default rather than by choice. Below ~800 nm
blue is the obvious pick. If no channel is free at all, the tool says so instead
of pretending.

This estimates *relative* signal. It is not a substitute for measuring on your
own rig.

## Licence

MIT — see [LICENSE](LICENSE).

## Layout of the code

```
index.html          markup
css/app.css         all styling, light + dark tokens
js/curves.js        curve unpacking, interpolation, integration, wavelength colour
js/chart.js         the canvas chart engine
js/optics.js        detection model, recommender, channel planner
js/advice.js        turns the model's numbers into sentences
claude/             the brief this was built from
js/app.js           state, UI wiring, URL sharing
build/fetch_data.py regenerates data/
```
