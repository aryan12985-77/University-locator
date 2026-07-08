---
name: Canvas rotating globe (static container, animated surface)
description: How to make a decorative globe whose container doesn't move but whose surface (continents) appears to rotate
---

To satisfy a "the element must stay put but something on/inside it should look animated" request, keep the canvas element itself in a fixed CSS position (no transform/position animation), and only animate values used inside the draw loop.

**Why:** users can be picky about a decorative element "moving" (e.g. floating orbs) but still want visual life — a rotating-in-place sphere is a good replacement.

**How to apply:** Use standard orthographic sphere projection per surface feature: given a feature's (lon, lat) and a rotating `rot` offset added to lon each frame, project `x = cx + R*cos(lat)*sin(lonRad)`, `y = cy - R*sin(lat)`, and scale the feature horizontally by `abs(cos(lonRad))` (foreshortening) while skipping/fading when `cos(lonRad)` goes negative (back of sphere). Clip everything to a circle and add a static radial-gradient overlay for lighting so it reads as a 3D sphere.
