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
- **Channel assignment** — how each fluorophore splits across the channels, and
  what fraction of its emission is captured at all. Channels read blue to far red
  everywhere on the page, matching the emission chart.
- **Configurable hardware** — two BrainSaws ship built in; any channel can be
  swapped for any of ~4,000 filters from the FPbase library, lasers are added and
  removed in the rail, and the whole setup is encoded in the URL so it can be
  shared. Rigs can be saved to a file and loaded back.

## Running it

It is a static site with no build step and no dependencies. Locally: open `index.html`
directly, or serve the directory:

```
python3 -m http.server
```

The data is emitted as both `.json` and `.js`, and the page loads the `.js`
variants via plain `<script>` tags, so **it works straight off the filesystem** —
unlike the previous viewer. The only feature that needs an HTTP server is the
on-demand filter library (`data/filter-library/*.json`), which is fetched lazily when
you open the filter picker.

From GitHub, enable GitHub pages and then: [https://SWC-Advanced-Microscopy.github.io/brainsaw_channel_chooser](https://SWC-Advanced-Microscopy.github.io/brainsaw_channel_chooser)

## Microscopes

Two are built in — **BrainSaw 4 chan** and **BrainSaw 3 chan** — and they are
authored as plain JSON in `configs/`, which the build vendors into
`data/microscopes.json`. A user's own rig is the same kind of object, so there is
one code path for all of them:

```json
{
  "schema": "swc-channel-chooser/microscope",
  "version": 1,
  "name": "BrainSaw 4 chan",
  "blockerNm": 700,
  "lasers": ["maitai-ehp-ds"],
  "channels": [
    {"name": "Blue", "filter": "Semrock FF01-460/60"},
    {"name": "Green", "filter": "Semrock FF01-525/39"}
  ]
}
```

Filters are named, not just numbered: a name survives a rebuild of the library
and is what a person reading the file understands. The `spectrum` id is written
alongside as a fast path and is optional.

**Hardware only.** How you choose to work — the objective, the >950 nm penalty,
which fluorophores you picked, whether the lasers run together — is not part of
the rig and is not saved into a config.

- **Save config** prompts for a name, downloads `<name>.json`, and adds the rig to
  the microscope dropdown.
- **Load config** reads such a file back. Imported rigs also join the dropdown and
  persist in `localStorage` (not cookies: nothing is sent anywhere, so no consent
  banner is needed), with a **Forget** button to remove one. The rig you were last
  using reopens next visit.

### Every channel is cut off by the laser blocker

Rigs put a blocking filter in front of the detectors to keep scattered laser
light out, assumed to sit at 700 nm unless a config says otherwise. It is what
sets the upper edge of a long-pass emission filter: BrainSaw 3 chan's red channel
is an ET570lp, so its band is 570 nm to the blocker, not 570 nm to infinity. The
charts and the detection maths both use the cut-off curve.

### Opening the page on a particular rig

A config can be handed over in the URL fragment, which is how BakingTray will do
it:

```
https://…/channel-chooser/#cfg=<base64url of the config JSON>
```

The fragment is never sent to the server, so the rig stays on the machine. The
page loads that microscope and remembers it. `matlab/channelChooserURL.m` is a
reference implementation of the encoding side — point it at a config file in the
BakingTray `SETTINGS` directory and it opens the browser on that rig.

## Deploying

Copy this directory into the GitHub Pages site at `/channel-chooser/` and link
straight to it. **It is a page, not a content block, and it is not embedded.**

It assumes it owns the viewport: the topbar is `position: sticky; top: 0`, the
rail sticks under it and scrolls on its own, and the layout is a 328 px rail
beside the charts that collapses to a single column below 1080 px. Dropped into
an article column it would sit permanently in the narrow layout, with the
fluorophore list, channels and lasers hidden behind a button. Framed, it would
work, but only same-origin — a cross-origin frame gets partitioned
`localStorage` in Safari and Chrome, and saved rigs would quietly disappear
between visits. Its own URL avoids all of that, and is needed anyway: `Share`
copies `location.href`, and BakingTray's `#cfg=` handoff has to have somewhere
to open. `matlab/channelChooserURL.m` points at this path.

## Rebuilding the data

```
python3 build/fetch_data.py
```

This pulls from FPbase and from the Drobizhev/Zipfel CSVs in the old viewer's
repo, and writes `data/`. Downloaded spectra are cached in `build/.cache/`, so a
re-run to change how the data is shaped does not re-download ~4,000 curves.

Each file is written twice — a `.json` for reading and tooling, and an identical
`.js` assigning the same object to a window global so the page works off the
filesystem — and both are formatted to be read, with each spectrum kept on one
line:

```
data/fluorophores.json          1p and 2p spectra for every curated fluorophore
data/lasers.json                laser tuning curves, absolute mW at the head
data/bundled-filters.json       curves for the filters the built-in microscopes use
data/microscopes.json           built-in microscope configurations
data/filter-library-index.json  searchable index of the whole FPbase filter library
data/filter-library/*.json      the library's curves, fetched on demand
```

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
| 2p spectra, "M" | measured on BrainSaw at SWC | arbitrary |
| 2p spectra, "E" | estimated, not measured | absolute (GM) |
| 1p excitation / emission | FPbase | normalised |
| Filter transmission | FPbase filter library | fraction transmitted |

Chroma's spectra viewer was checked as a two-photon source and does not have
one — its open API exposes 203 fluorochromes and 913 dyes, none with 2p data. The
FPbase 2P collection (99 spectra, largely Drobizhev-derived) is used instead.

**dTomato** has no published two-photon spectrum. tdTomato is two dTomato units
linked head to tail on one polypeptide, so it carries the same chromophore twice
and absorbs about twice as much light for the same number of molecules: dTomato's
curve is tdTomato's shape at half the cross-section, carried under source "E" so it
is never mistaken for a measurement. It is in the common list next to tdTomato
because the names are one letter apart and anyone who lands on it deserves to be
told the difference.

FPbase has no `tdStayGold` entry, so the parent **StayGold** is used. StayGold and
Venus have no usable two-photon spectrum — Venus's FPbase "2P" curve actually
spans 300–700 nm, so it disappears once the data is clipped. Both are drawn on the
emission chart and counted in the channel maths, but sit out of the wavelength
recommendation, and the UI says so. Anything with an emission spectrum is kept
this way rather than dropped silently.

### The tracer dyes

Nobody has published two-photon spectra for DiI, DiO and DiD, so they were
measured on BrainSaw: mean signal in each dye's best detector channel at 760,
780, 820, 850 and 920 nm. That makes the "M" numbers detector counts, not cross
sections — the shape of one dye's curve is meaningful, the height against another
dye's is not, and they are never mixed into a GM comparison. The measurements are
stored as the five points and interpolated linearly between them; the chart draws
a dot at each one so the straight runs are not mistaken for data. Outside
760–920 nm the curve reads zero, so the recommender will not send you to a
wavelength these dyes were never tested at.

All three are bright enough that the PMT gain had to be turned down to avoid
saturating, which is why the raw counts run into the tens of thousands.

**They are also scored differently from everything else.** For a fluorescent
protein the question is where the cross-section is largest. For these dyes it is
not: past a workable signal, more excitation buys nothing and DiI driven hard
bleeds into every channel. So a tracer's score climbs to 1 at 300 counts — the
line below which the measurements call a dye dim — and stays flat above it. That
turns the answer into a plateau rather than a peak, and the tie is broken by
taking the **longest** wavelength that still clears the floor: excitation is more
even with depth, and the green channel keeps enough background to register
sections against. Each tracer alone, and all three together, land on 920 nm,
which is where they are imaged in practice.

The hero bars still show each dye as a share of its own peak, with a *bright
enough* / *may be dim* flag beside it — DiD reads 3% at 920 nm and is perfectly
usable there. Where the short end is dramatically brighter (DiI is 3.6× brighter
at 760 nm, DiD 37× at 780 nm) the advice says so, framed as the answer to weak
labelling rather than as a recommendation.

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
  path, so ~500 mW out of the head is the floor and 1 W is comfortable. Those
  losses vary from rig to rig and this tool does not know yours, so the figure is
  used internally to decide whether a wavelength is power-limited and is **never
  reported as a power at the sample** — that would be a measurement, and it is
  not one. The
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

Multiple fluorophores are combined either **balanced** (the default) or as the
**average**. Balanced is the harmonic mean of the per-fluorophore scores, not a
strict worst case. A strict worst case reads well and behaves badly: put two beams
on the sample and the weakest fluorophore's total stops moving, so the minimum goes
flat and the answer slides to an arbitrary point on the plateau. eGFP + mCherry on
a Mai Tai and an Axon 1064 landed on 820 nm, throwing away half of eGFP to lift
mCherry by 4.7 GM on top of the 22 GM the fixed line already gave it. The harmonic
mean keeps what the minimum was for — it still collapses to zero if anything is
left unexcited, so nothing can be abandoned — but it will not trade a large loss
for a token gain.

The 1 nm optimum is then snapped to a round number. Being a wavelength people
actually dial in is worth 3% of score, applied as a sort key rather than as a
tolerance band, so the ordering is a real ordering.

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

### More than one laser

A rig can have several lasers, listed in the rail. What that means is a choice,
because it changes the maths:

Each fitted laser has an **ON / OFF** switch. A second line is a hardware fact, so
it is never removed to try life without it — it is switched off, the way it would
be on the rig, and switched back on from the same place. Running one laser is not
a mode; it is the other one switched off. What remains a mode is how the
switched-on lasers combine:

| Mode | What it models |
|---|---|
| **All on together** | Every beam on at once, so each fluorophore collects excitation from all of them and the contributions add. |
| **One pass per laser** | Image once with each laser and merge, so every fluorophore gets whichever beam suits it — what counts is its best single pass. |

The last of those **cannot be done on a BrainSaw today** and says so in red. It is
selectable because it is worth knowing what it would buy: a Mai Tai at 920 nm plus
an Axon at 1064 nm gives eGFP and tdTomato each close to their own peak, which no
single wavelength can.

**A lone beam is never sent past 940 nm.** One beam has to do both jobs — excite
the label and leave the other channels enough autofluorescence to register sections
against — and past ~940 nm the green channel's background is going. This is a
constraint, not a cost, because a cost can always be outbid and here it should not
be: tdTomato is 60% brighter at 1010 nm than at 940, and no penalty gentle enough
to be fair at 960 nm will refuse that. The advice says what the cap is costing
("tdTomato is 2.1× at 1010 nm — and you can go there") so the trade is visible
rather than silently made. With a second, bluer beam on the sample the anatomy is
covered and the red one goes wherever it likes, so this never applies to more than
one beam, nor to a fixed line, nor to a laser that cannot tune below 940 nm.

**The cap is soft against a peak and hard against a slope.** eYFP doubles between
940 and 960 nm and then falls away again, so a flat boundary was cutting across a
maximum that merely happens to sit the wrong side of it. A lone beam may therefore
cross, to a point within 40 nm of the cap, if three things hold:

- **Somebody gains properly** — one fluorophore is at least 25% brighter there
  than at the best wavelength below the cap.
- **Nobody pays for it** — no other fluorophore is more than 5% worse off. One
  fluorophore buying another's peak is a trade, and the cap should not be let out
  for a trade. This is asked of each fluorophore separately, not of the combined
  score: pair eYFP with dTomato and the harmonic mean, dominated by the dimmer
  dTomato, dilutes eYFP's doubling to +16% overall even though dTomato itself is
  flat across the step and gives up nothing.
- **It is genuinely a top** — read off the gaining fluorophore's own cross-section
  curve, which must extend at least 20 nm past the peak and must not beat it by
  more than 10% anywhere further out.

That last test has to be read on the raw curve rather than on the score, because
the context penalty is already pulling the score down above 950 nm: read there,
every curve looks like it is peaking, and DsRed2 — whose data stops at 990 nm
while it is still climbing hard — came out as a maximum at 970. Having crossed,
the beam stops at the near edge of the top rather than its middle.

tdTomato and mCherry fail immediately: still climbing at 1040 nm, no top to cross
to, 940 holds. In practice this moves eYFP and citrine (alone or paired with a
tomato) from 940 to 960 nm and nothing else, and the advice says why the number is
redder than usual.

**Whether you need the second line is your call, not the tool's.** How much signal
a fluorophore gives depends on how well it is expressed in that brain, which the
page cannot know. So it works out the best answer with everything on and the best
answer with the strongest line on its own, and offers both — as chips ("940 nm
alone · 58%" beside "920 nm & 1064 nm") and in the advice. The one thing it does
say outright is when a beam contributes under 5% to everything selected: then its
ON switch turns amber and the advice says switch it off. eGFP gets 0.1 GM out of an
Axon 1064; there is nothing to weigh.

The >950 nm context penalty is applied once, from the **shortest** wavelength in
use, not per beam — the background that gives you anatomy comes from the bluest
beam on the sample, and one such beam is enough. Power is judged per beam and
independently: two beams do not share a budget, because what matters is whether
each laser has enough output at its own wavelength.

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
configs/            built-in microscopes, vendored into data/ by the build
matlab/             reference MATLAB for the BakingTray handoff
claude/             the brief this was built from
js/app.js           state, UI wiring, URL sharing
build/fetch_data.py regenerates data/
```
