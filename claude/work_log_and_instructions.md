# Work log and instructions

This tool was written by Claude (Anthropic) working from a spoken-style brief
given interactively by Rob Campbell. The file is a mix of the two things that
conversation produced: the **instructions** as they were given, round by round,
and a **log** of what each round became once it met the data. It is the
reference for anyone picking the project up — including a future model — so read
it before changing the model or the presentation rules.

Roughly chronological. Sections 1–9 are the original build; everything after
"Next phase" is a later round of instructions with a note of what came of it.

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
served from the GitHub Pages site alongside the existing 2p-cross-section page.
A page of its own that is linked to, not embedded: it is an application shell
that assumes it owns the viewport, and its own URL is what keeps saved rigs and
the BakingTray handoff working. See "Deploying" in the README.

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



# Next phase

Different users will have different hardware. We want them to be able to select their hardware in the GUI. 
Ideally their choices should be remembered next time they visit. But if that involves stupid shit like cookies then we leave it. 
Advise.

We want two generic systems to choose from in the microscope drop-down. 

The first is "BrainSaw 4 chan" this is what you have now but choose the Mai Tai eHP DS laser. 

The second is "BrainSaw 3 chan". As for 4 chan but use these three filters:
Red ET570lp (570 nm to about 700 nm, where the laser blocking filter kicks in)
Green   ET525/50m (~500 to 550 nm) (installed 20/11/2019)
Blue    FF01-450/70

Note the laser blocking filter. Just assume that always lives at 700 nm in all rigs. 

## Exporting configs
The user should be able to change the settings as they currently can (changing filters, number of emission channels, laser, etc) then they should have the option to download this. Add a button to export the config. They must be prompted to enter a microscope name. The downloaded file should include the name of the scope as a field. 

## Importing configs
There should be an "load config" button. That reads the config and names the scope according to the name in the config. The "BrainSaw 3 chan" and "BrainSaw 4 chan" should similarly exist as configs in the repo and their information is obtained from that. 
Sensible location for the import and export buttons is at the top near the microscope drop-down.

## Automating config import
I want to be able to set the config then download it. Then add it as a file to the BakingTray SETTINGS directory. BakingTray will (I will do not you) have a button or menu item to "go to channel chooser site". Upon doing that it uploads (I don't know how. Serialised via URL?) automatically the settings from disk so the user is automagically presented with THEIR scope on the site. 

## Multiple lasers
It is possible (although not common) for a rig to have multiple laser lines. So we need a way to handle this. Presently the laser is a drop-down up at the top. It can't stay there. 1. It can't be a drop-down if we want to be able to select multiple lasers. 2. It will get busy with the extra buttons for import and export. I think it just has to go below "detection channels" on the left hand bar. No other obvious choice.

---

## What the next phase asked for, and what it became

### Readable data files

`core.json` held everything and `filters/000.json` said nothing about its
contents. Split into files named after what is in them — `fluorophores`,
`lasers`, `bundled-filters`, `microscopes`, `filter-library-index`, and library
shards called `filters-0001-0120.json` — and pretty-printed with **one spectrum
per line**: structure indented, but anything purely numeric kept on a single line
so a 4000-sample curve does not run for 4000 lines.

### Microscopes are config files

`configs/*.json` are the source of truth for the two built-in BrainSaws, vendored
into `data/microscopes.json` by the build. A user's saved rig is the same object,
so import, export, the built-ins and the URL handoff all share one code path.
**Hardware only**, as decided: channels, filters, blocker, lasers. Not the
objective, not the penalty, not the fluorophores.

Persistence is `localStorage` — not a cookie, nothing leaves the machine, no
consent banner. Imported and saved rigs join the microscope dropdown and can be
forgotten again; the last rig used reopens next visit.

### The laser blocking filter

Assumed at 700 nm on every rig, and a field in the config so a different one is
not a code change. It is what closes the top of a long-pass emission filter —
BrainSaw 3 chan's ET570lp is a 570 nm to 700 nm band, not 570 to infinity — and
it applies to the charts and the detection maths alike.

### Multiple lasers

Moved out of the topbar, which now carries the config buttons, and into the rail
below Detection channels. Three modes, since the brief asked for all three:

1. **One at a time** — one laser on, scored as before.
2. **All on together** — beams add, so a fluorophore is excited by all of them.
3. **One pass per laser** — each fluorophore takes its best single pass.

A fixed-line laser is never offered a "Tune" button, and the marker over it is
not draggable: it has exactly one wavelength.

Modes 2 and 3 are the same search with a different combiner (sum against max),
over the cartesian product of each laser's candidate wavelengths. Mode 3 carries
a red warning that no BrainSaw can do it yet, but it is offered as a real choice
when optimising, because it is worth knowing what it would be worth.

Two things follow from the brief and are worth keeping straight:

- **Power is judged per beam, never as a shared budget.** The question is only
  ever "does this laser have enough output at this wavelength" — a Mai Tai eHP at
  920 and an Axon at 1064 are both fine and the tool should say nothing. Heating
  is not modelled at all: the tissue is dead.
- **The >950 nm penalty is applied once, from the shortest wavelength in use.**
  Anatomical background comes from the bluest beam on the sample, so one such
  beam is enough to have context.

A worked case, eGFP + tdTomato on a Mai Tai plus an Axon 1064: one laser gives
940 nm as a compromise; both beams on gives 920 + 1064, with tdTomato at 117% of
its own peak because two beams excite it. The hero shows a wavelength per beam,
and in two-pass mode names which fluorophore belongs to which.

### BakingTray handoff

`#cfg=<base64url JSON>`, the same object as a config file. Fragments are not sent
to the server, so the rig never leaves the machine.
`matlab/channelChooserURL.m` is the reference encoder — its real job is to pin
the format so the two ends cannot drift.


## Dealing with the tracer dyes
You could not find 2p spectra for the tracer dyes. I have recorded them. 
These are are mean signal values in the best detector channel for that dye. 
So units are NOT GM but arbitrary. That said, these dyes are very bright indeed. 
I had to use low PMT gains to avoid saturation.  
So I would consider the values below about 300 to be "low" and below about 1000 to be "medium" bright. 
Other than that we should be good. So I know, for example, that DiI looks great in tissue in real experiments at 920 nm. 
So we infer from that that 780 should also be good. 

You can take the data below and use them to add 2p excitation curves to integrate into your library of fluorophores. 

wavelength_nm         760      780      820     850     920
DiI               10302.0   1990.0    262.0   264.0  2880.0
DiD               25645.0  28828.0  24535.0  5883.0   782.0
DiO                  59.0    143.0    246.0   715.0  4032.0



## Feedback on choices
After the DiI commit, let's look at how well the suggestions for excitation wavelength are working. 
Mai Tai alone and 4 channels:
1. eGFP and tdTomato suggests 940 nm. Agree. good
2. eCFP and eYFP. Deliberately bad combination. Suggestions of 870 to 910 nm all make sense. 
3. eBFP and mCherry at 760 nm makes sense. good.
4. eGFP, eBFP, and mCherry at 770 to 800 nm makes sense. good.
5. eGFP, and mCherry at 800 nm makes sense. good.

Now I try tunable laser (Mai Tai) plus an Axon 1060
1. eGFP, and mCherry. Suggests 820 nm on Mai Tai. WHY? Here GFP signal is half and we get mCherry at 4% of its max. That adds nothing meaningful to the 1064 nm line. At 920 nm, GFP is at max and mCherry is 2%. Clearly around 920 nm makes the most sense. NEEDS CORRECTING.
2. eGFP and tdTomato. Suggests tunable at 920 nm. Good makes sense. BUT -- the second beam isn't necessary. Since we get pretty good signal also at 940 nm. So (and this is a substantial change, maybe) you should suggest to the user that they can use ONLY the 940 nm line. **THE IDEA** the rig has two lines, sure, but that doesn't mean the user HAS to use them. If they add not much, then you should provide alternatives. If they add nothing. State that the second line should be off. In the laser boxes you have made add red "OFF" text for the laser that can be off. Green "ON" text for the laser that will be on. ONLY do this if there is more than one line. Otherwise it will be confusing. The idea is that the ON and OFF should display according to the current state displayed. The "alternatives" should be aware of that. So it should (940 nm) if only the MaiTai is on. But (940 nm & 1064 nm) if both are to be on. Presumably the user must be able to click on the lasers to turn them on and off to try different configs. Remember the issue is that the presence of the second laser is a hardware feature. We don't want to add and remove it. We want to toggle it's availability depending on need. 
3. tdTom and mCherry. Suggest tunable at 760 nm. Makes sense good. 
4. eYFP and tdTom. Suggest tunable at 960 nm. Indeed that's optimal but it could also work without. 
5. eYFP and mCherry. Suggests 940 nm for tunable line. NO! This isn't peak for YFP and there is LESS signal in mCherry than at 960 nm which is peak for YFP. Signal is HIGHER for both fluorophores at 960 nm. 940 is is worse all around. 
6. eCFP and mCherry. Tunable line at 860 nm where we have eCFP peak. GOOD. that is a reasonable choice. 
7. mCherry and DiI. Suggests 760 nm. This isn't wrong. it's the peak. But then you should suggest no 1064 nm line needed (this is a new feature, you couldn't do that in testing here). What you COULD do in testing here which is equally a good choice is 920 nm. As we know DiI is good there and we have the 1064 nm line for mCherry. That said: there is a lot MORE mCherry at 760 nm and at that wavelength we don't need the co-aligned 1064 nm line. So you need to balance those things and report. 
8. mCherry on its own. You correctly suggest 760 nm. You should tell the user they don't need the 1064 nm line. 
9. tdTomato on its own. You suggest 940 nm plus the single line. This is a reasonable choice because it gives the user background signal in green from the 940 nm plus also a bit of extra signal in red maybe plus the 1064 nm hitting the tdTom. You can tell the user that, unless tdTom signal is weak, they don't need the 1064 nm line. **EXTRA POINT**  tdTomato is a tandem dimer made by linking two dTomato units head-to-tail, making tdTomato vastly brighter, more stable, and widely preferred for biological imaging over the standard dimeric dTomato. SO: add dTomato to the dye list. We don't have GM readings for it. We guess by using HALF the tdTom values. If the user has selected dTomato then the message text should say what I explained just now. That it's dimmer and why. So they should the 1064 nm line if available. No point telling them that latter point if there is no 1064 nm line on the microscope. But the explanation should be there because people won't know what the dTomato is. 

**An additional note**
The eGFP plus tomato case is unclear. I don't have data. 940 nm could be fine or it might need the extra line to boost the tomato. So give the user those choices. 940 nm is more simple. So you can say: "940 nm is the optimal with one line, but if the tomato signal is suspected to be weak, 920 nm plus 1064 nm might give better overall results". Just make it obvious that those are the two clear choices. Then the user can choose. Remember: these proteins are being expressed in the brain. If expression is good there is LOTS of protein = big signal. Low expression and we have problems. We don't know the situation here, making our webpage. Only the user does.


## Downloads, notes, and a summary plot

The next set of instructions, as I understood them.

### Downloading the data, not just the picture
Each chart already has a download button that saves a PNG. Both should instead
hand over the picture *and* the numbers behind it, zipped together, with the
hover text reading "Download image and data". If a zip cannot be produced in the
browser then fall back to plain buttons under "Data & provenance", one for the
excitation panel's data and one for the emission panel's.

Either way, put those buttons in the **collapsed** "Data & provenance" panel, so
that the download is visible without expanding anything, and keep them in the
expanded view. The large table of two-photon values in the expanded panel goes:
it is redundant once the data can be downloaded.

Drop the "Download CSV" button from "Channel assignment" as well. Nobody is
going to download that. The panel stays — it is worth looking at — but it does
not drive anyone's choice.

### Notes on fluorophores
`notes/fluorophore_notes.md` holds qualitative notes, and they belong in the
page. Pick a far-red fluorophore and the page should say what follows from that.
State the facts and stop: no suggested alternatives, no explaining things the
user already knows, and in a plainer voice than I have been using — the edit made
to the background note in `app.js` is the register to write in.

### A summary colour plot
A small new rail panel with two buttons, each opening a **pop-up window** holding
a heatmap the user can look at and close.

- Rows are fluorophores, columns are excitation wavelength in **20 nm bins**,
  with **longer wavelengths on the left** and shorter on the right.
- One button for the common fluorophores, in the order the list shows them; one
  for all of them. Both in relative units.
- Where the underlying data is coarser than 20 nm, do not interpolate — that
  would be inventing numbers. A point measured every 60 nm fills three 20 nm bins
  centred as near as possible on the measurement.
- Three separate plots, stacked with a 4-5 px gap: proteins, Alexa dyes,
  tracers. No titles needed — the row labels say what each one is.



## Two tunable lasers

As asked:

1. When two lasers are selected the text up at the top should say, for example,
   "920 nm & 1064 nm", because otherwise it is unclear what is being shown.
2. The excitation graph is too high. The emission graph looks like it is set to
   occupy about 60% of the screen height, which is good; do the same for the
   excitation.
3. Add a second tunable laser — a Discovery, which has a lot of power at all
   wavelengths. With GFP plus tdTomato the algorithm does not suggest tuning it
   to the 1050 nm range. Instead it suggests parking both lasers at around
   950 nm, which makes no sense.

### What that became

Three things, the last of them the substantial one.

1. With two lines on, the headline said one number. It now reads
   "920 nm & 1064 nm", pluralises its label, and drops in size to fit; the cards
   underneath keep saying which laser each wavelength belongs to.
2. The excitation chart was taller than the emission one. It is now slightly
   shorter, because its card carries a second row of controls and a footnote, so
   the two panels come out level on the page.
3. **A Mai Tai plus a Chameleon Discovery, eGFP + tdTomato, parked both lines at
   ~940 nm** instead of putting the Discovery out at 1050 nm where tdTomato
   peaks. Two faults, both in how several beams combine:

   - Contributions were summed outright, so stacking both beams on one
     wavelength doubled every fluorophore's score. But powerWeight is a
     sufficiency test capped at 1 — surplus power buys nothing anywhere else in
     the model — so a co-tuned second beam is not twice the signal, it is the
     same excitation with the power turned up. Beams now add only in so far as
     they differ, over 60 nm.
   - That alone gave 930 + 990 nm. Scored in GM the dimmer label can never reach
     the brighter one's peak, so it is always the limiting term of the harmonic
     mean, and the second beam kept being dragged back to prop it up — lifting
     eGFP from 55 to 77 GM, neither of them a number anyone worries about, at
     the cost of tdTomato dropping 170 → 106. Each fluorophore's score now stops
     at its own single-beam best, on the same "enough is enough" argument as the
     power weight. Answer: 920 & 1040 nm.

   Neither rule can bite on a single laser, and every case in "Feedback on
   choices" above still gives the wavelength recorded there.

## References
The page should close with a list of references, as some of these data came from people's papers. 
Also, the reader needs to know where to go for further information. 

Currently the text reads:
_[SWC Advanced Microscopy](https://swcmicroscopy.com/). Spectra from [FPbase](https://fpbase.org) (CC-BY-SA), Drobizhev et al. 2011 and the Zipfel lab at Cornell. Filter curves via FPbase._

Change it to
_[SWC Advanced Microscopy](https://swcmicroscopy.com/). Filter curves and some spectra from [FPbase](https://fpbase.org). Relevant papers (some of which contributed data)
* [Drobizhev et al. 2011](https://pmc.ncbi.nlm.nih.gov/articles/PMC4772972/)
* [Mütze et al. 2012](https://pmc.ncbi.nlm.nih.gov/articles/PMC3283774/)
* [Zipfel lab 2-photon spectra](http://www.drbio.cornell.edu/TwoPhotonXsec.html)
