#!/usr/bin/env python3
"""Build the vendored spectra dataset for the BrainSaw spectra viewer.

Sources
-------
FPbase (https://www.fpbase.org)  - CC-BY-SA. 1p excitation/emission, two-photon
                                   spectra, optical filter transmission curves and
                                   detector quantum-efficiency curves.
Drobizhev et al. 2011            - absolute 2p action cross sections (GM), taken
                                   from SWC-Advanced-Microscopy/2p_crosssection_viewer
Zipfel lab (Cornell)             - absolute 2p action cross sections (GM), same repo

Outputs (written to ../data)
----------------------------
fluorophores.json          1p and 2p spectra for every curated fluorophore
lasers.json                laser tuning curves, absolute mW at the head
bundled-filters.json       curves for the filters the built-in microscopes use
microscopes.json           built-in microscope configurations
filter-library-index.json  searchable index of the whole FPbase filter library
filter-library/*.json      the library's curves, fetched on demand by the picker

Each of these is written twice: a .json for reading and tooling, and an identical
.js that assigns the same object to a window global, so index.html works when
opened straight off the filesystem. Both are formatted for a human to read, with
each spectrum kept on a single line.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "data"))
CACHE = os.path.join(HERE, ".cache")
UA = {"User-Agent": "swc-brainsaw-spectra-viewer/1.0 (build script)"}

XSEC_REPO = "https://github.com/SWC-Advanced-Microscopy/2p_crosssection_viewer.git"

# Two-photon curves are normalised to their peak inside this window, and anything
# shorter than NORM_LO is discarded outright. Nothing near 740 nm is used in
# practice (the floor for recommendations is 760), and cutting here rather than
# lower means the curves have already fallen away by the left edge instead of
# being sliced through mid-rise. Several red proteins also climb steeply towards
# the 1p band edge (>1150 nm), which would otherwise flatten the region anyone
# actually images in.
NORM_LO, NORM_HI = 740, 1100

# Shortest excitation wavelength the recommender will suggest. Below this the
# laser is less stable and there is a great deal of autofluorescence from the
# embedding agar, so it is not used in practice regardless of cross-section.
MIN_WL = 760

# Range retained for stored 2p curves. The short end matches NORM_LO: data below it
# is dropped rather than plotted, so the charts and the maths agree.
TWOP_LO, TWOP_HI = 740, 1320
# Range retained for stored 1p / filter / detector curves.
ONEP_LO, ONEP_HI = 350, 900


# --------------------------------------------------------------------------- io

def gql(query, retries=4):
    url = "https://www.fpbase.org/graphql/?query=" + urllib.parse.quote(query)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as fh:
                payload = json.load(fh)
            if "errors" in payload:
                # A handful of FPbase curves contain NaN samples. GraphQL reports
                # those as errors but still returns every other alias, so keep the
                # partial result and only fail if nothing came back at all.
                if not payload.get("data"):
                    raise RuntimeError(payload["errors"])
                print(f"  ({len(payload['errors'])} spectra with bad samples skipped)",
                      file=sys.stderr)
            return payload["data"]
        except Exception as exc:  # noqa: BLE001 - build script, surface and retry
            if attempt == retries - 1:
                raise
            print(f"  retry {attempt + 1} after {exc}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    return None


def get_json(url, name):
    """Fetch and cache a plain JSON endpoint."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if os.path.exists(path):
        with open(path) as fh:
            return json.load(fh)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as fh:
        payload = json.load(fh)
    with open(path, "w") as fh:
        json.dump(payload, fh)
    return payload


# ---------------------------------------------------------------- curve packing

def pack(points, lo, hi, decimals=4):
    """Compress a [[x, y], ...] curve.

    Uniformly-sampled 1 nm curves become {x0, dx, y:[...]}; anything else keeps
    explicit pairs. Leading/trailing runs of zero are trimmed, and values are
    clamped to >= 0 (a few FPbase curves carry tiny negative baseline noise).
    """
    import math
    pts = []
    for x, y in points:
        if x is None or y is None:
            continue
        x, y = float(x), float(y)
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if lo <= x <= hi:
            pts.append((x, y))
    if not pts:
        return None
    pts.sort(key=lambda p: p[0])

    ys = [max(0.0, y) for _, y in pts]
    xs = [x for x, _ in pts]

    # trim zero runs, keeping one zero either side so lines close to the baseline
    first = next((i for i, y in enumerate(ys) if y > 0), None)
    if first is None:
        return None
    last = len(ys) - 1 - next(i for i, y in enumerate(reversed(ys)) if y > 0)
    first = max(0, first - 1)
    last = min(len(ys) - 1, last + 1)
    xs, ys = xs[first:last + 1], ys[first:last + 1]

    ys = [round(y, decimals) for y in ys]

    uniform = (
        len(xs) > 2
        and all(abs(xs[i + 1] - xs[i] - 1.0) < 1e-6 for i in range(len(xs) - 1))
        and abs(xs[0] - round(xs[0])) < 1e-6
    )
    if uniform:
        return {"x0": int(round(xs[0])), "dx": 1, "y": ys}
    return {"xy": [[round(x, 2), y] for x, y in zip(xs, ys)]}


def unpack(curve):
    if curve is None:
        return []
    if "xy" in curve:
        return [(p[0], p[1]) for p in curve["xy"]]
    return [(curve["x0"] + i * curve["dx"], y) for i, y in enumerate(curve["y"])]


def normalise(points, lo=NORM_LO, hi=NORM_HI):
    """Scale so the peak inside [lo, hi] is 1.0. Returns (points, peak, peak_wl)."""
    window = [(x, y) for x, y in points if lo <= x <= hi]
    if not window:
        window = list(points)
    peak = max(y for _, y in window)
    if peak <= 0:
        return points, 0.0, None
    peak_wl = next(x for x, y in window if y == peak)
    return [(x, y / peak) for x, y in points], peak, peak_wl


# ------------------------------------------------------------ curated selection

# Fluorophores relevant to serial-section whole-brain imaging on BrainSaw.
# `fp` is the FPbase protein name; `twop` the FPbase 2P spectrum owner name.
# `common` marks the short list shown by default. Everything else is still here,
# behind the "show uncommon" toggle - the distinction is what people at SWC
# actually put in a brain, not a judgement about the protein.
CURATED = [
    # slug            label              fpbase name        family    common
    ("ebfp2",        "eBFP2",           "EBFP2",           "blue",    True),
    ("tagbfp",       "TagBFP",          "TagBFP",          "blue",    False),
    ("mturquoise2",  "mTurquoise2",     "mTurquoise2",     "cyan",    False),
    ("mcerulean3",   "mCerulean3",      "mCerulean3",      "cyan",    False),
    ("ecfp",         "eCFP",            "ECFP",            "cyan",    True),
    ("mtfp1",        "mTFP1",           "mTFP1",           "cyan",    False),
    ("egfp",         "eGFP",            "EGFP",            "green",   True),
    ("mneongreen",   "mNeonGreen",      "mNeonGreen",      "green",   False),
    ("clover",       "Clover",          "Clover",          "green",   False),
    ("eyfp",         "eYFP",            "EYFP",            "yellow",  True),
    ("citrine",      "Citrine",         "Citrine",         "yellow",  False),
    ("mcitrine",     "mCitrine",        "mCitrine",        "yellow",  False),
    ("venus",        "Venus",           "Venus",           "yellow",  False),
    ("morange2",     "mOrange2",        "mOrange2",        "orange",  False),
    ("mko2",         "mKO2",            "mKO2",            "orange",  False),
    ("tdtomato",     "tdTomato",        "tdTomato",        "orange",  True),
    ("dsred2",       "DsRed2",          "DsRed2",          "red",     True),
    ("mruby2",       "mRuby2",          "mRuby2",          "red",     False),
    ("mscarlet",     "mScarlet",        "mScarlet",        "red",     False),
    ("mscarlet_i",   "mScarlet-I",      "mScarlet-I",      "red",     False),
    ("mcherry",      "mCherry",         "mCherry",         "red",     True),
    ("tagrfp",       "TagRFP",          "TagRFP",          "red",     False),
    ("mstrawberry",  "mStrawberry",     "mStrawberry",     "red",     False),
    ("mkate2",       "mKate2",          "mKate2",          "farred",  False),
    ("mneptune",     "mNeptune",        "mNeptune",        "farred",  False),
    ("mcardinal",    "mCardinal",       "mCardinal",       "farred",  False),
    ("mplum",        "mPlum",           "mPlum",           "farred",  False),
    ("e2crimson",    "E2-Crimson",      "E2-Crimson",      "farred",  False),
    ("katushka",     "Katushka",        "Katushka",        "farred",  False),
    ("tdkatushka2",  "tdKatushka2",     "tdKatushka2",     "farred",  False),
    ("eqfp670",      "eqFP670",         "eqFP670",         "farred",  False),
    ("irfp670",      "iRFP670",         "iRFP670",         "farred",  False),
    ("irfp720",      "iRFP720",         "iRFP720",         "farred",  False),
    ("jrgeco1a",     "jRGECO1a",        "jRGECO1a",        "sensor",  False),
    ("jrcamp1a",     "jRCaMP1a",        "jRCaMP1a",        "sensor",  False),
    ("rgeco1",       "R-GECO1",         "R-GECO1",         "sensor",  False),
]

# Entries whose one-photon spectra come from FPbase. Most have no published
# two-photon curve at all: they still plot on the emission chart and take part in
# the channel maths, but the recommender leaves them out and the UI says so. The
# tracers are the exception - their 2p excitation is measured here, see
# MEASURED_2P below.
#
# FPbase has no tdStayGold entry - StayGold, StayGold-E138D, mStayGold and
# mStayGold2 only - so the parent StayGold is used here.
# The lipophilic carbocyanine tracers get their own family rather than being
# scattered across the emission colours, because they are picked as a set - you
# reach for "a tracer", then choose the colour that stays clear of your labels.
# Listed in the order people say them: DiI, DiO, DiD.
ONE_PHOTON_ONLY = [
    # slug          label        fpbase name  family    kind       common
    ("dii",        "DiI",        "DiI",       "tracer",  "dye",     True),
    ("dio",        "DiO",        "DiO",       "tracer",  "dye",     True),
    ("did",        "DiD",        "DiD",       "tracer",  "dye",     True),
    ("staygold",   "StayGold",   "StayGold",  "green",   "protein", False),
]

# Two-photon excitation for the lipophilic tracers, measured on BrainSaw at SWC
# because nobody has published curves for them.
#
# Each number is the mean signal in the dye's best detector channel, so the units
# are arbitrary - detector counts, not GM - and only ratios within one dye mean
# anything. They are not comparable between dyes and never scored against GM
# data. All three are bright enough that the PMT gain had to be turned down:
# below ~300 counts is dim, below ~1000 is moderate, above that is plenty.
#
# Five wavelengths, and the shapes are not smooth (DiI drops by a factor of forty
# between 760 and 820 nm, then climbs again), so the curve is stored as the
# measured points and linearly interpolated between them. Nothing is invented
# outside 760-920 nm: the sampler returns zero there, so the recommender will not
# propose a wavelength these dyes were never tested at.
MEASURED_2P = {
    #        760      780      820     850     920
    "dii": [10302.0,  1990.0,   262.0,  264.0, 2880.0],
    "did": [25645.0, 28828.0, 24535.0, 5883.0,  782.0],
    "dio": [   59.0,   143.0,   246.0,  715.0, 4032.0],
}
MEASURED_2P_WL = [760, 780, 820, 850, 920]

# The line below which one of these dyes counts as dim. Below about 300 counts
# the signal is low and below about 1000 it is moderate, so 300 is where a dye
# stops being a problem rather than where it becomes impressive.
#
# It is a floor, not a target, and that is the whole point of treating the
# tracers as a special case. The question for them is not "where is this dye
# brightest" but "where is it not dim", because past a workable signal more
# excitation buys nothing - DiI driven hard bleeds into every channel. Once a
# wavelength clears the floor it is as good as any other, so the choice is made
# on other grounds and the longest clearing wavelength wins: excitation is more
# even with depth and the green channel keeps enough background to register
# sections against. For a decently coated electrode that lands on 920 nm, which
# is where these dyes are imaged in practice, even though DiI is nearly four
# times brighter at 760 nm.
SUFFICIENT_COUNTS = 300.0

# BrainSaw-1, from the SWC wiki. `role` drives how it is drawn.
# Channels are defined by their bandpass alone. The dichroics that route light to
# them (FF635-Di01, DMSP490R) are deliberately left out: they only trim the edges
# of bands the bandpass filters already define, and one of them has no
# machine-readable data anyway.
# Built-in microscopes are authored as JSON in configs/, so the files a user
# imports and the ones shipped with the tool are the same kind of object. The
# build resolves each channel's filter name to an FPbase spectrum and vendors
# the result into data/microscopes.json.
CONFIG_DIR = os.path.normpath(os.path.join(HERE, "..", "configs"))

# Every rig has a filter in front of the detectors to keep scattered laser light
# out. Assumed to sit at 700 nm unless a config says otherwise, and it is what
# sets the upper edge of any long-pass emission filter.
DEFAULT_BLOCKER_NM = 700


def load_configs():
    out = []
    for fname in sorted(os.listdir(CONFIG_DIR)):
        if not fname.endswith(".json"):
            continue
        with open(os.path.join(CONFIG_DIR, fname)) as fh:
            cfg = json.load(fh)
        cfg.setdefault("blockerNm", DEFAULT_BLOCKER_NM)
        cfg["source"] = fname
        out.append(cfg)
    if not out:
        raise SystemExit(f"no microscope configs found in {CONFIG_DIR}")
    out.sort(key=lambda c: (c.get("order", 99), c.get("name", "")))
    return out


# ------------------------------------------------------------------------ lasers
#
# Tuning curves are held in ABSOLUTE average power at the laser head, in mW,
# not as a fraction of peak. That matters because what decides whether a
# wavelength is usable is not "how far down the tuning curve am I" but "can I
# still put ~100 mW on the sample". With ~80% loss in the optical path, roughly
# 500 mW out of the head is the floor and 1 W is comfortable, so a laser can sit
# at 20% of its peak and still be perfectly fine. See js/optics.js.
#
# Values are typical, drawn from manufacturer datasheets. Datasheets quote
# guaranteed minima at a handful of wavelengths; the numbers here interpolate
# those anchors into a smooth curve at roughly typical (not worst-case) output.
# They are nominal, never a claim about any individual laser - measure your own
# if you want the recommendations to be exact.

# Spectra-Physics Mai Tai eHP DeepSee. Datasheet minima: >540 mW @ 690,
# >1.38 W @ 710, >2.6 W @ 800, >1.38 W @ 920, >330 mW @ 1040.
MAITAI_EHP = [
    (690, 600), (700, 900), (710, 1200), (720, 1500), (740, 1950), (760, 2300),
    (780, 2580), (800, 2700), (820, 2700), (840, 2600), (860, 2450), (880, 2250),
    (900, 2000), (920, 1750), (940, 1450), (960, 1150), (980, 880), (1000, 640),
    (1020, 450), (1040, 330),
]

# Mai Tai HP DeepSee - same shape, the slightly lower-power sibling.
MAITAI_HP = [(wl, round(mw * 0.88)) for wl, mw in MAITAI_EHP]

# Spectra-Physics InSight X3. Datasheet (X3 A) minima: >0.9 W @ 700,
# >1.4 W @ 800, >1.8 W @ 900, >1.6 W @ 1000, >1.4 W @ 1100, >1.2 W @ 1200,
# >0.9 W @ 1300. Typical output runs above those.
INSIGHT_X3 = [
    (680, 800), (700, 1100), (750, 1450), (800, 1750), (850, 2050), (900, 2250),
    (950, 2200), (1000, 2050), (1050, 1950), (1100, 1800), (1150, 1650),
    (1200, 1500), (1250, 1300), (1300, 1100),
]

# Coherent Chameleon Ultra II. Datasheet minima: >650 mW @ 680, >1.6 W @ 700,
# >3.5 W @ 800, >1.6 W @ 920, >550 mW @ 1020, >200 mW @ 1080.
CHAMELEON_ULTRA_II = [
    (680, 700), (700, 1650), (720, 2200), (740, 2600), (760, 2950), (780, 3300),
    (800, 3500), (820, 3450), (840, 3300), (860, 3050), (880, 2700), (900, 2250),
    (920, 1700), (940, 1350), (960, 1100), (980, 900), (1000, 720), (1020, 570),
    (1040, 430), (1060, 310), (1080, 210),
]

# Coherent Chameleon Discovery NX. Datasheet: 2.0 W @ 700, 3.6 W @ 800,
# 3.2 W @ 900, 2.7 W @ 1000, 2.3 W @ 1200, 1.9 W @ 1300, over 660-1320 nm.
DISCOVERY_NX = [
    (660, 1100), (680, 1550), (700, 2000), (750, 2900), (800, 3600), (850, 3450),
    (900, 3200), (950, 2950), (1000, 2700), (1100, 2500), (1200, 2300),
    (1300, 1900), (1320, 1800),
]

# Light Conversion CRONUS-2P. Two independently tunable outputs, A over
# 680-960 nm (>3 W @ 920) and B over 960-1300 nm (>2.5 W @ 1100). Treated here
# as one continuous source, since from the microscope's point of view you tune
# whichever output covers the wavelength you want.
CRONUS_2P = [
    (680, 1500), (700, 2000), (750, 2600), (800, 3000), (850, 3200), (900, 3200),
    (920, 3000), (960, 2500), (1000, 2600), (1100, 2500), (1200, 2200), (1300, 1800),
]


def fixed_line(centre, mw, halfwidth=3):
    """Curve for a single-line (fixed wavelength) laser.

    The range is pinned to the single wavelength, so the recommender can only
    ever return that one number; the couple of nm either side exist purely so
    the overlay has something to draw.
    """
    return [(centre - halfwidth, mw), (centre, mw), (centre + halfwidth, mw)]


LASERS = [
    {"id": "maitai-ehp-ds", "name": "Spectra-Physics Mai Tai eHP DeepSee",
     "kind": "Ti:Sapphire", "tunable": True, "range": [690, 1040],
     "power": MAITAI_EHP,
     "note": "Typical output from the datasheet minima (>2.6 W at 800 nm, "
             ">1.38 W at 920 nm, >330 mW at 1040 nm). Nominal, not measured."},
    {"id": "maitai-hp-ds", "name": "Spectra-Physics Mai Tai HP DeepSee",
     "kind": "Ti:Sapphire", "tunable": True, "range": [690, 1040],
     "power": MAITAI_HP,
     "note": "The lower-power, longer-pulse sibling of the eHP. Same tuning "
             "shape, roughly 12% less power."},
    {"id": "insight-x3", "name": "Spectra-Physics InSight X3",
     "kind": "OPO", "tunable": True, "range": [680, 1300],
     "power": INSIGHT_X3,
     "note": "Gap-free 680-1300 nm. Holds ~2 W past 1000 nm, so unlike a "
             "Ti:Sapphire it is not power-limited at the red end."},
    {"id": "chameleon-ultra-ii", "name": "Coherent Chameleon Ultra II",
     "kind": "Ti:Sapphire", "tunable": True, "range": [680, 1080],
     "power": CHAMELEON_ULTRA_II,
     "note": "High power at the Ti:Sapphire peak (>3.5 W at 800 nm), falling "
             "away above 950 nm much as a Mai Tai does."},
    {"id": "discovery-nx", "name": "Coherent Chameleon Discovery NX",
     "kind": "OPO", "tunable": True, "range": [660, 1320],
     "power": DISCOVERY_NX,
     "note": "660-1320 nm with watts everywhere. There is also a fixed 3.5 W "
             "1040 nm second beam, not modelled here."},
    {"id": "cronus-2p", "name": "Light Conversion CRONUS-2P",
     "kind": "OPCPA", "tunable": True, "range": [680, 1300],
     "power": CRONUS_2P,
     "note": "Two tunable outputs (680-960 and 960-1300 nm) treated as one "
             "range. A third fixed output at 1025 nm is not modelled."},
    {"id": "axon-920", "name": "Coherent Axon 920 (fixed line)",
     "kind": "Fibre", "tunable": False, "range": [920, 920],
     "power": fixed_line(920, 1000),
     "note": "Single-line fibre laser, 1 W at 920 nm. Not tunable, so the only "
             "question it answers is how well your fluorophores do at 920 nm."},
    {"id": "axon-1064", "name": "Coherent Axon 1064 (fixed line)",
     "kind": "Fibre", "tunable": False, "range": [1064, 1064],
     "power": fixed_line(1064, 1000),
     "note": "Single-line fibre laser, 1 W at 1064 nm. Plenty of power for "
             "red probes, but nothing to give you an anatomical background."},
]


def laser_record(spec):
    """Emit both the absolute power curve (mW) and a normalised one.

    The recommender works in absolute mW - "have I got enough power at the
    sample" - while the chart overlay only needs a shape, so it uses the
    normalised copy and stays on the same axis as everything else.
    """
    peak = max(mw for _, mw in spec["power"]) or 1
    out = {k: v for k, v in spec.items() if k != "power"}
    out["powerMw"] = [[wl, round(mw, 1)] for wl, mw in spec["power"]]
    out["peakMw"] = round(peak, 1)
    out["curve"] = [[wl, round(mw / peak, 4)] for wl, mw in spec["power"]]
    return out


# ------------------------------------------------------------------------ build

def load_local_2p():
    """Drobizhev ('D') and Zipfel ('Z') absolute GM curves from the SWC repo."""
    repo = os.path.join(CACHE, "2p_crosssection_viewer")
    if not os.path.isdir(repo):
        os.makedirs(CACHE, exist_ok=True)
        subprocess.run(["git", "clone", "-q", "--depth", "1", XSEC_REPO, repo], check=True)

    out = {"D": {}, "Z": {}}
    mapping = {
        "drobizhev": ("D", {
            "EGFP_average_w.csv": "egfp", "tdTomato_w.csv": "tdtomato",
            "mCherry_w.csv": "mcherry", "citrine_w.csv": "citrine",
            "EBFP2_0_w.csv": "ebfp2", "ECFP_w.csv": "ecfp",
        }),
        "zipfel": ("Z", {
            "eGFP.csv": "egfp", "YFP.csv": "eyfp", "dsRed.csv": "dsred2",
            "Alexa488.csv": "alexa488", "Alexa568.csv": "alexa568",
            "Alexa594.csv": "alexa594",
        }),
    }
    for folder, (key, files) in mapping.items():
        for fname, slug in files.items():
            path = os.path.join(repo, "data", folder, fname)
            if not os.path.exists(path):
                print(f"  !! missing {path}", file=sys.stderr)
                continue
            pts = []
            with open(path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = re.split(r"[,\s]+", line)
                    try:
                        pts.append((float(parts[0]), float(parts[1])))
                    except (ValueError, IndexError):
                        continue
            if pts:
                out[key][slug] = sorted(pts)
    return out


# Dyes that exist only in the Zipfel set - no FPbase protein record.
ZIPFEL_ONLY = {
    "alexa488": ("Alexa Fluor 488", "green", 495, 519),
    "alexa568": ("Alexa Fluor 568", "orange", 578, 603),
    "alexa594": ("Alexa Fluor 594", "red", 590, 617),
}


def build():
    os.makedirs(OUT, exist_ok=True)

    print("fetching FPbase spectra index ...")
    index = gql("{spectra{id category subtype owner{name}}}")["spectra"]
    by_name = {}
    for s in index:
        by_name.setdefault(s["owner"]["name"], {})[s["subtype"]] = s["id"]

    print("fetching FPbase protein metadata ...")
    meta_list = get_json("https://www.fpbase.org/api/proteins/?format=json", "proteins.json")
    meta = {m["name"]: m for m in meta_list}

    print("fetching FPbase 1p spectra ...")
    prot_spectra = get_json(
        "https://www.fpbase.org/api/proteins/spectra/?format=json", "protein_spectra.json")
    prot_spectra = {p["name"]: p for p in prot_spectra}

    local2p = load_local_2p()

    # ---- fluorophores -----------------------------------------------------
    wanted_ids = {}
    for slug, label, fpname, family, common in CURATED:
        sid = by_name.get(fpname, {}).get("2P")
        if sid:
            wanted_ids[slug] = sid

    print(f"fetching {len(wanted_ids)} two-photon spectra ...")
    twop_raw = fetch_spectra(list(wanted_ids.values()))

    def add_1p(rec, fpname):
        """Attach one-photon ex/em and photophysics for an FPbase protein."""
        sp = prot_spectra.get(fpname)
        if sp:
            for entry in sp.get("spectra", []):
                state = entry.get("state", "")
                if state.endswith("_ex") or state == "ex":
                    rec["ex"] = pack(entry["data"], ONEP_LO, ONEP_HI, 4)
                    rec["exMax"] = entry.get("max")
                elif state.endswith("_em") or state == "em":
                    rec["em"] = pack(entry["data"], ONEP_LO, ONEP_HI, 4)
                    rec["emMax"] = entry.get("max")
        m = meta.get(fpname)
        if m and m.get("states"):
            st = m["states"][0]
            rec["exMax"] = rec.get("exMax") or st.get("ex_max")
            rec["emMax"] = rec.get("emMax") or st.get("em_max")
            rec["qy"] = st.get("qy")
            rec["ec"] = st.get("ext_coeff")
            rec["brightness"] = st.get("brightness")

    fluorophores = []
    for slug, label, fpname, family, common in CURATED:
        rec = {"id": slug, "name": label, "family": family, "fpbase": fpname,
               "common": common, "twop": {}}
        add_1p(rec, fpname)

        # two-photon: F = FPbase (relative), D = Drobizhev (GM), Z = Zipfel (GM)
        sid = wanted_ids.get(slug)
        if sid and twop_raw.get(sid):
            add_2p(rec, "F", twop_raw[sid], absolute=False)
        if slug in local2p["D"]:
            add_2p(rec, "D", local2p["D"][slug], absolute=True)
        if slug in local2p["Z"]:
            add_2p(rec, "Z", local2p["Z"][slug], absolute=True)

        if not rec["twop"]:
            # Some FPbase "2P" curves do not actually cover the two-photon range
            # (Venus's spans 300-700 nm), so they vanish once the data is clipped.
            # Keep the entry as one-photon-only rather than dropping it silently:
            # it still belongs on the emission chart and in the channel maths.
            if rec.get("em"):
                rec["noTwoP"] = True
                print(f"  -- {label}: no 2p data in range, keeping as 1p-only")
                fluorophores.append(rec)
            else:
                print(f"  -- {label}: no 2p and no emission, skipping")
            continue
        fluorophores.append(rec)

    # Zipfel-only dyes
    for slug, (label, family, exmax, emmax) in ZIPFEL_ONLY.items():
        if slug not in local2p["Z"]:
            continue
        rec = {"id": slug, "name": label, "family": family, "fpbase": None,
               "exMax": exmax, "emMax": emmax, "dye": True, "common": True,
               "twop": {}}
        add_2p(rec, "Z", local2p["Z"][slug], absolute=True)
        fluorophores.append(rec)

    # ---- one-photon-only entries -------------------------------------------
    op_ids = {}
    for slug, label, fpname, family, kind, common in ONE_PHOTON_ONLY:
        entry = by_name.get(fpname, {})
        for sub in ("EX", "EM"):
            if sub in entry:
                op_ids[(slug, sub)] = entry[sub]
    print(f"fetching {len(op_ids)} one-photon-only spectra ...")
    op_raw = fetch_spectra(list(op_ids.values()))

    for slug, label, fpname, family, kind, common in ONE_PHOTON_ONLY:
        rec = {"id": slug, "name": label, "family": family, "fpbase": fpname,
               "common": common, "twop": {},
               "dye": kind == "dye"}
        if slug in MEASURED_2P:
            counts = MEASURED_2P[slug]
            add_2p(rec, "M", list(zip(MEASURED_2P_WL, counts)), absolute=False)
            # The curve is stored normalised to its own peak, so express the
            # "bright enough" level in the same units.
            rec["twop"]["M"]["sufficient"] = round(
                SUFFICIENT_COUNTS / max(counts), 4)
        else:
            rec["noTwoP"] = True
        if kind == "protein":
            add_1p(rec, fpname)
        for sub, key in (("EX", "ex"), ("EM", "em")):
            sid = op_ids.get((slug, sub))
            if sid and op_raw.get(sid) and not rec.get(key):
                rec[key] = pack(op_raw[sid], ONEP_LO, ONEP_HI, 4)
                pk = max(op_raw[sid], key=lambda p: (p[1] or 0))
                rec[("exMax" if sub == "EX" else "emMax")] = int(round(pk[0]))
        if not rec.get("em"):
            print(f"  -- {label}: no emission spectrum, skipping")
            continue
        fluorophores.append(rec)

    n_common = sum(1 for f in fluorophores if f.get("common"))
    print(f"  -> {len(fluorophores)} fluorophores ({n_common} common)")

    # ---- microscope configs -----------------------------------------------
    configs = load_configs()
    hw_ids = []
    for cfg in configs:
        for ch in cfg["channels"]:
            sid = lookup_filter(by_name, ch["filter"])
            ch["spectrum"] = sid
            hw_ids.append(sid)
    print(f"fetching filter curves for {len(configs)} microscope configs ...")
    hw_raw = fetch_spectra(sorted(set(hw_ids)))

    filters = {}
    for cfg in configs:
        for ch in cfg["channels"]:
            sid = ch["spectrum"]
            if sid not in filters:
                filters[sid] = filt_record(sid, ch["filter"], "BP", hw_raw[sid])

    core = {
        "generated": time.strftime("%Y-%m-%d"),
        "normWindow": [NORM_LO, NORM_HI],
        "minWavelength": MIN_WL,
        "fluorophores": fluorophores,
        "filters": filters,
        "lasers": [laser_record(l) for l in LASERS],
        "scopes": configs,
        "sources": {
            "F": {"label": "FPbase", "units": "relative",
                  "url": "https://www.fpbase.org",
                  "note": "Two-photon spectra collated by FPbase. Relative units, "
                          "not absolute cross sections."},
            "D": {"label": "Drobizhev", "units": "GM",
                  "url": "https://doi.org/10.1038/nmeth.1596",
                  "note": "Absolute 2p action cross sections, Drobizhev et al. 2011."},
            "Z": {"label": "Zipfel", "units": "GM",
                  "url": "https://www.drbio.cornell.edu/cross_sections.html",
                  "note": "Absolute 2p action cross sections, Zipfel lab, Cornell."},
            "M": {"label": "Measured at SWC", "units": "arbitrary",
                  "url": None,
                  "note": "Two-photon excitation measured on BrainSaw for dyes with no "
                          "published curve. Detector signal at five wavelengths between "
                          "760 and 920 nm: shape only, in arbitrary units, not "
                          "comparable between dyes and not a cross section."},
        },
    }
    stamp = core["generated"]
    write(os.path.join(OUT, "fluorophores.json"), {
        "generated": stamp,
        "note": "Fluorophore spectra: one-photon excitation and emission, plus "
                "two-photon cross sections from each source.",
        "normWindow": core["normWindow"],
        "minWavelength": core["minWavelength"],
        "sources": core["sources"],
        "fluorophores": core["fluorophores"],
    }, "SV_FLUOROPHORES")
    write(os.path.join(OUT, "lasers.json"), {
        "generated": stamp,
        "note": "Laser tuning curves. powerMw is average power at the laser head "
                "in mW; curve is the same shape normalised to its peak.",
        "lasers": core["lasers"],
    }, "SV_LASERS")
    write(os.path.join(OUT, "bundled-filters.json"), {
        "generated": stamp,
        "note": "Transmission curves for the filters the built-in microscopes use. "
                "Every other filter lives in the on-demand library.",
        "filters": core["filters"],
    }, "SV_BUNDLED_FILTERS")
    write(os.path.join(OUT, "microscopes.json"), {
        "generated": stamp,
        "note": "Built-in microscope configurations, vendored from configs/*.json. "
                "Edit those files, not this one.",
        "microscopes": core["scopes"],
    }, "SV_MICROSCOPES")

    # ---- full filter library ---------------------------------------------
    build_filter_library(index)


def lookup_filter(by_name, name):
    entry = by_name.get(name)
    if not entry:
        raise SystemExit(f"FPbase has no spectrum named {name!r}")
    for sub in ("BP", "BM", "BX", "BS", "LP", "SP"):
        if sub in entry:
            return entry[sub]
    return next(iter(entry.values()))


def filt_record(sid, name, subtype, data):
    return {"id": sid, "name": name, "type": subtype, "source": "FPbase",
            "curve": pack(data, ONEP_LO, ONEP_HI, 4)}


def add_2p(rec, key, points, absolute):
    norm, peak, peak_wl = normalise(points)
    entry = {
        "curve": pack(norm, TWOP_LO, TWOP_HI, 4),
        "peakWl": peak_wl,
        "absolute": absolute,
    }
    if absolute:
        entry["gm"] = pack(points, TWOP_LO, TWOP_HI, 3)
        entry["peakGm"] = round(peak, 3)
    # A handful of samples rather than a spectrum. The chart marks where they
    # were taken so the straight lines between them do not read as measurements.
    if len(points) <= 12:
        entry["sparse"] = True
    if entry["curve"]:
        rec["twop"][key] = entry


def fetch_spectra(ids, batch=40):
    """Fetch many spectra with aliased GraphQL queries.

    Results are cached on disk so re-running the build to change how the data is
    shaped does not re-download four thousand curves from FPbase.
    """
    os.makedirs(CACHE, exist_ok=True)
    cache_path = os.path.join(CACHE, "spectra.json")
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path) as fh:
            cache = json.load(fh)

    out = {}
    ids = [i for i in ids if i]
    missing = []
    for sid in ids:
        if str(sid) in cache:
            out[sid] = cache[str(sid)]
        else:
            missing.append(sid)
    if not missing:
        print(f"  {len(ids)} spectra from cache", file=sys.stderr)
        return out

    for i in range(0, len(missing), batch):
        chunk = missing[i:i + batch]
        query = "{" + " ".join(f's{sid}:spectrum(id:{sid}){{data}}' for sid in chunk) + "}"
        data = gql(query)
        for sid in chunk:
            node = data.get(f"s{sid}")
            if node:
                out[sid] = node["data"]
                cache[str(sid)] = node["data"]
        print(f"  {min(i + batch, len(missing))}/{len(missing)}", end="\r", file=sys.stderr)
        time.sleep(0.2)
    print(file=sys.stderr)

    with open(cache_path, "w") as fh:
        json.dump(cache, fh)
    return out


LIB_SUBTYPES = ("BP", "BM", "BX", "LP", "SP", "BS")
SHARD_SIZE = 120


def build_filter_library(index):
    entries = [s for s in index if s["category"] == "F" and s["subtype"] in LIB_SUBTYPES]
    entries.sort(key=lambda s: s["owner"]["name"].lower())
    print(f"fetching {len(entries)} filter curves for the library ...")

    ids = [e["id"] for e in entries]
    raw = fetch_spectra(ids)

    shards = {}
    idx = []
    for n, e in enumerate(entries):
        data = raw.get(e["id"])
        if not data:
            continue
        curve = pack(data, ONEP_LO, ONEP_HI, 3)
        if not curve:
            continue
        shard = n // SHARD_SIZE
        shards.setdefault(shard, {})[e["id"]] = curve
        name = e["owner"]["name"]
        idx.append({
            "id": e["id"], "n": name, "t": e["subtype"], "s": shard_name(shard, len(entries)),
            "v": vendor_of(name), "c": centre_of(name, curve),
        })

    write(os.path.join(OUT, "filter-library-index.json"),
          {"note": "Searchable index of the whole FPbase filter library. Each entry "
                   "names the file in filter-library/ that holds its curve.",
           "shardSize": SHARD_SIZE, "filters": idx}, "SV_FILTER_INDEX")
    for shard, payload in shards.items():
        write(os.path.join(OUT, "filter-library", shard_name(shard, len(entries)) + ".json"),
              payload)
    print(f"  -> {len(idx)} filters in {len(shards)} shards")


def shard_name(shard, total):
    """Shards are alphabetical by filter name, so number them by the range of
    library positions they hold - readable, and obviously ordered."""
    lo = shard * SHARD_SIZE + 1
    hi = min((shard + 1) * SHARD_SIZE, total)
    return f"filters-{lo:04d}-{hi:04d}"


VENDORS = ["Semrock", "Chroma", "Alluxa", "Omega", "Thorlabs", "Zeiss", "Nikon",
           "Olympus", "Leica", "AHF", "Edmund", "Delta", "Midwest"]


def vendor_of(name):
    for v in VENDORS:
        if name.lower().startswith(v.lower()) or f" {v.lower()}" in name.lower():
            return v
    return "Other"


def centre_of(name, curve):
    """Best-effort centre wavelength: parse the part number, else use the curve."""
    m = re.search(r"(\d{3})/(\d{1,3})", name)
    if m:
        return int(m.group(1))
    pts = unpack(curve)
    if not pts:
        return None
    half = max(y for _, y in pts) / 2
    over = [x for x, y in pts if y >= half]
    return int(round((over[0] + over[-1]) / 2)) if over else None


def _is_leaf(v):
    """A value that carries no structure worth putting on its own line."""
    if isinstance(v, dict):
        return False
    if isinstance(v, list):
        return all(not isinstance(x, dict) for x in _flat(v))
    return True


def _flat(seq):
    for x in seq:
        if isinstance(x, list):
            yield from _flat(x)
        else:
            yield x


def dumps_readable(obj, indent=0):
    """JSON a person can read, with one spectrum per line.

    Structure is indented, but anything whose contents are purely numeric -
    a packed curve, a list of xy pairs, an index entry - stays on a single
    line. Otherwise a 4000-sample spectrum would run for 4000 lines and the
    shape of the file would be lost entirely.
    """
    pad, pad2 = " " * indent, " " * (indent + 2)

    if isinstance(obj, dict):
        if not obj:
            return "{}"
        if all(_is_leaf(v) for v in obj.values()):
            return json.dumps(obj, separators=(", ", ": "))
        items = [f'{pad2}{json.dumps(k)}: {dumps_readable(v, indent + 2)}'
                 for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"

    if isinstance(obj, list):
        if not obj:
            return "[]"
        if all(_is_leaf(v) for v in obj):
            return json.dumps(obj, separators=(", ", ": "))
        items = [f'{pad2}{dumps_readable(v, indent + 2)}' for v in obj]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]"

    return json.dumps(obj)


def write(path, obj, global_name=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = dumps_readable(obj)
    with open(path, "w") as fh:
        fh.write(body + "\n")
    print(f"  wrote {os.path.relpath(path, OUT)} ({os.path.getsize(path) / 1024:.0f} kB)")

    # Also emit a plain-script version so index.html works straight off the
    # filesystem, without needing to serve it over HTTP.
    if global_name:
        js_path = os.path.splitext(path)[0] + ".js"
        with open(js_path, "w") as fh:
            fh.write(f"window.{global_name} = {body};\n")
        print(f"  wrote {os.path.relpath(js_path, OUT)} "
              f"({os.path.getsize(js_path) / 1024:.0f} kB)")


if __name__ == "__main__":
    build()
