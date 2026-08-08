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
core.json          fluorophores, BrainSaw filters, detectors, lasers  (loaded up front)
filter-index.json  searchable index of the whole FPbase filter library
filters/NN.json    sharded transmission curves, fetched on demand by the picker
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
    ("morange2",     "mOrange2",        "mOrange2",        "orange",  True),
    ("mko2",         "mKO2",            "mKO2",            "orange",  False),
    ("tdtomato",     "tdTomato",        "tdTomato",        "orange",  True),
    ("dsred2",       "DsRed2",          "DsRed2",          "red",     True),
    ("mruby2",       "mRuby2",          "mRuby2",          "red",     True),
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

# Entries with a one-photon emission spectrum but no published two-photon curve.
# They still plot on the emission chart and take part in the channel maths; the
# recommender leaves them out and the UI says so.
#
# FPbase has no tdStayGold entry - StayGold, StayGold-E138D, mStayGold and
# mStayGold2 only - so the parent StayGold is used here.
ONE_PHOTON_ONLY = [
    # slug          label        fpbase name  family   kind
    ("staygold",   "StayGold",   "StayGold",  "green",  "protein"),
    ("dio",        "DiO",        "DiO",       "green",  "dye"),
    ("dii",        "DiI",        "DiI",       "orange", "dye"),
    ("did",        "DiD",        "DiD",       "farred", "dye"),
]

# BrainSaw-1, from the SWC wiki. `role` drives how it is drawn.
# Channels are defined by their bandpass alone. The dichroics that route light to
# them (FF635-Di01, DMSP490R) are deliberately left out: they only trim the edges
# of bands the bandpass filters already define, and one of them has no
# machine-readable data anyway.
BRAINSAW = {
    "id": "brainsaw-1",
    "name": "BrainSaw 1",
    "notes": "SWC BrainSaw 1. MaiTai eHP DS, Nikon 16x NA 0.8, 8 kHz resonant scanner.",
    "laser": "maitai-ehp-ds",
    "channels": [
        {"n": 1, "name": "Far red", "fpbase": "Semrock FF01-676/29",
         "label": "Brightline 676/29", "pmt": "AFK5930"},
        {"n": 2, "name": "Red", "fpbase": "Chroma ET605/70m",
         "label": "Chroma 605/70m", "pmt": "AFK5929"},
        {"n": 3, "name": "Green", "fpbase": "Semrock FF01-525/39",
         "label": "Brightline 525/39", "pmt": "AFK6125"},
        {"n": 4, "name": "Blue", "fpbase": "Semrock FF01-460/60",
         "label": "Brightline basic 460/60", "pmt": "AFK6121"},
    ],
}


# MaiTai eHP DeepSee nominal tuning curve, normalised to its peak near 800 nm.
# Approximates the published shape for the eHP family: a broad flat top and a
# gradual roll-off, still delivering roughly 60% of peak at 950 nm and ~20% at
# 1040 nm. Getting this right matters - an over-pessimistic long end suppresses
# every wavelength past 900 nm and hides sensible choices like 950 nm for a
# GFP/tdTomato pair. Editable in the UI, and only ever used as a relative
# weighting, never as an absolute power claim.
MAITAI_TUNING = [
    (690, 0.25), (700, 0.35), (710, 0.45), (720, 0.55), (730, 0.65), (740, 0.74),
    (750, 0.82), (760, 0.88), (770, 0.93), (780, 0.97), (790, 0.99), (800, 1.00),
    (810, 1.00), (820, 0.99), (830, 0.98), (840, 0.96), (850, 0.94), (860, 0.92),
    (870, 0.90), (880, 0.87), (890, 0.84), (900, 0.81), (910, 0.77), (920, 0.74),
    (930, 0.70), (940, 0.67), (950, 0.63), (960, 0.59), (970, 0.55), (980, 0.51),
    (990, 0.47), (1000, 0.43), (1010, 0.38), (1020, 0.33), (1030, 0.28), (1040, 0.22),
]

LASERS = [
    {"id": "maitai-ehp-ds", "name": "Spectra-Physics MaiTai eHP DeepSee",
     "kind": "Ti:Sapphire", "range": [690, 1040], "curve": MAITAI_TUNING,
     "note": "Nominal tuning curve, normalised to peak. Edit to match your own laser."},
    {"id": "insight-x3", "name": "Spectra-Physics InSight X3", "kind": "OPO",
     "range": [680, 1300],
     "curve": [(680, 0.25), (700, 0.40), (720, 0.52), (740, 0.62), (760, 0.71),
               (780, 0.79), (800, 0.86), (820, 0.91), (840, 0.95), (860, 0.98),
               (880, 1.00), (900, 1.00), (920, 0.98), (940, 0.96), (960, 0.93),
               (980, 0.90), (1000, 0.86), (1020, 0.82), (1040, 0.78), (1060, 0.73),
               (1080, 0.68), (1100, 0.62), (1150, 0.48), (1200, 0.34), (1250, 0.21),
               (1300, 0.10)],
     "note": "Nominal OPO tuning curve. Retains useful power well past 1000 nm."},
    {"id": "chameleon-ultra-ii", "name": "Coherent Chameleon Ultra II",
     "kind": "Ti:Sapphire", "range": [680, 1080],
     "curve": [(690, 0.18), (700, 0.30), (720, 0.48), (740, 0.62), (760, 0.74),
               (780, 0.85), (800, 0.94), (820, 0.99), (840, 1.00), (860, 0.98),
               (880, 0.94), (900, 0.88), (920, 0.81), (940, 0.73), (960, 0.64),
               (980, 0.55), (1000, 0.45), (1020, 0.34), (1040, 0.24), (1060, 0.14),
               (1080, 0.06)],
     "note": "Nominal tuning curve. Holds power to slightly longer wavelengths than a MaiTai."},
    {"id": "fixed-1040", "name": "Fixed 1040 nm fibre laser", "kind": "Fibre",
     "range": [1035, 1045],
     "curve": [(1035, 0.0), (1038, 1.0), (1042, 1.0), (1045, 0.0)],
     "note": "Single-line source; the recommender can only ever return 1040 nm."},
]


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
    os.makedirs(os.path.join(OUT, "filters"), exist_ok=True)

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
    for slug, label, fpname, family, kind in ONE_PHOTON_ONLY:
        entry = by_name.get(fpname, {})
        for sub in ("EX", "EM"):
            if sub in entry:
                op_ids[(slug, sub)] = entry[sub]
    print(f"fetching {len(op_ids)} one-photon-only spectra ...")
    op_raw = fetch_spectra(list(op_ids.values()))

    for slug, label, fpname, family, kind in ONE_PHOTON_ONLY:
        rec = {"id": slug, "name": label, "family": family, "fpbase": fpname,
               "common": False, "twop": {}, "noTwoP": True,
               "dye": kind == "dye"}
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

    # ---- BrainSaw hardware ------------------------------------------------
    hw_ids = []
    for ch in BRAINSAW["channels"]:
        sid = lookup_filter(by_name, ch["fpbase"])
        ch["spectrum"] = sid
        hw_ids.append(sid)

    print("fetching BrainSaw filter curves ...")
    hw_raw = fetch_spectra(hw_ids)

    filters = {}
    for ch in BRAINSAW["channels"]:
        filters[ch["spectrum"]] = filt_record(ch["spectrum"], ch["fpbase"], "BP",
                                              hw_raw[ch["spectrum"]])

    core = {
        "generated": time.strftime("%Y-%m-%d"),
        "normWindow": [NORM_LO, NORM_HI],
        "minWavelength": MIN_WL,
        "fluorophores": fluorophores,
        "filters": filters,
        "lasers": LASERS,
        "scopes": [BRAINSAW],
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
        },
    }
    write(os.path.join(OUT, "core.json"), core, "SV_CORE")

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
            "id": e["id"], "n": name, "t": e["subtype"], "s": shard,
            "v": vendor_of(name), "c": centre_of(name, curve),
        })

    write(os.path.join(OUT, "filter-index.json"),
          {"shardSize": SHARD_SIZE, "filters": idx}, "SV_FILTER_INDEX")
    for shard, payload in shards.items():
        write(os.path.join(OUT, "filters", f"{shard:03d}.json"), payload)
    print(f"  -> {len(idx)} filters in {len(shards)} shards")


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


def write(path, obj, global_name=None):
    with open(path, "w") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    print(f"  wrote {os.path.relpath(path, OUT)} ({os.path.getsize(path) / 1024:.0f} kB)")

    # Also emit a plain-script version so index.html works straight off the
    # filesystem, without needing to serve it over HTTP.
    if global_name:
        js_path = os.path.splitext(path)[0] + ".js"
        with open(js_path, "w") as fh:
            fh.write(f"window.{global_name}=")
            json.dump(obj, fh, separators=(",", ":"))
            fh.write(";\n")
        print(f"  wrote {os.path.relpath(js_path, OUT)} "
              f"({os.path.getsize(js_path) / 1024:.0f} kB)")


if __name__ == "__main__":
    build()
