window.SV_MICROSCOPES = {
  "generated": "2026-08-08",
  "note": "Built-in microscope configurations.",
  "microscopes": [
    {
      "id": "brainsaw-1",
      "name": "BrainSaw 1",
      "notes": "SWC BrainSaw 1. MaiTai eHP DS, Nikon 16x NA 0.8, 8 kHz resonant scanner.",
      "laser": "maitai-ehp-ds",
      "channels": [
        {"n": 1, "name": "Far red", "fpbase": "Semrock FF01-676/29", "label": "Brightline 676/29", "pmt": "AFK5930", "spectrum": "1043"},
        {"n": 2, "name": "Red", "fpbase": "Chroma ET605/70m", "label": "Chroma 605/70m", "pmt": "AFK5929", "spectrum": "351"},
        {"n": 3, "name": "Green", "fpbase": "Semrock FF01-525/39", "label": "Brightline 525/39", "pmt": "AFK6125", "spectrum": "903"},
        {"n": 4, "name": "Blue", "fpbase": "Semrock FF01-460/60", "label": "Brightline basic 460/60", "pmt": "AFK6121", "spectrum": "838"}
      ]
    }
  ]
};
