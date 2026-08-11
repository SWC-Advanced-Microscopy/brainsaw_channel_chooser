# Notes on different fluorophores

## What is this?
This page includes various qualitative notes on different fluorophores or fluorophore combinations. 
They are to be incorporated into the web app or even just read be users. 


## Far-red fluorophores
* Experience shows iRFP 670 has been found to look pretty good at 880 nm in a far-red channel (e.g. 700-661 nm), although it bleaches quickly. It should look even better at 850 nm, where the peak lies. 
* Alexa 647, like other far-red fluorophores, bleaches really quickly and produces nasty tiling artefacts in the overlap regions as a consequence. This dye is well known for looking good under conventional, 1 photon, excitation but looks much worse under 2-photon.
* Experience shows that Alexa-488 and Alexa-647 work reasonably well together at 780 to 800 nm.
* Far red dyes are generally worse under 2-p than 1-p excitation; an exception is DiD.

## Single fluorophores
* tdTomato is more efficient at 1040 nm than 920 nm, but the laser emits much less power at 1040 nm. If expression is good, you will find you get the same signal at these two wavelengths, because the fluorophores are saturated. However, if expression is low, you may find you get virtually no signal at 920 nm but acceptable signal at 1040 nm. This could be the case where, for example, tdTomato expression is being driven by cFos.



## 3 Colour Combinations
* A commonly used combination for three colours is eGFP, eBFP2, and mCherry excited at around 780 nm.



# Qualitative notes
* tdTomato is well known for being very bright
* mScarlet is very bright. 
