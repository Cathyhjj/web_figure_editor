# SAC styles

Open **SAC styles** beside **Shapes** in the toolbar. The gallery has 40 entries.
Click **Complete poster reference** to insert all 103 layers from the reference
sheet, or insert one of its sections under **Poster layouts**:

- **Ecosystem ring & callouts** includes four editable gradient teardrops, the
  ring, leaders, callouts, headings and the original Dr.XAS pictures.
- **Six gradient method rows** includes the overlapping crescent, six colors
  of radial-gradient labels, matching descriptions and the two original picture accents.
- **Three-category matrix** includes the blue, green and plum hexagons, their
  leaders and the corresponding outlined text fields.

**Ring & nodes**, **Gradient rows** and **Category cards** also offer the individual
components. The remaining groups contain the frames, headings, dividers,
connectors, arrows and accents from the v0.14 poster. The editor centers the
selection on the current slide and fits it within the canvas. One Undo removes
one insertion. Select an individual layer to change its text, paths, paint or
picture. The four original PNGs in the reference sheet are replaceable pictures.
Saving the project embeds each required picture once.

## Source and adaptations

The reference sheet comes from editor page 14, **Slide 07**, in
`APS_ArgonneSciencePoster_48x36inches.figure.json`. The geometry, gradients,
labels, stacking order and picture crop follow that page. Its four SVG-wrapped
teardrop nodes are rebuilt as native paths with editable gradients and shadows.
The two logo pictures and two image accents use the source PNGs. Thumbnail
previews use reduced copies. The full PNGs load when an insert needs them.

The original 17 entries use decorative geometry from
`JuanjuanHuang_SAC_poster_v0.14.pptx` (4608 × 3456 CSS px).

| Component | Source object IDs |
| --- | --- |
| Fine panel frame | ppt-6 |
| Soft blue divider | ppt-53 |
| Fading divider | ppt-222 |
| Pastel highlight | ppt-35 |
| Lavender rounded card | ppt-298 |
| Blush card | ppt-106 |
| Purple glass orb (two layers) | ppt-113, ppt-114 |
| Blue glass node | ppt-124 |
| Fading blue arrow | ppt-314 |
| Fading U-turn arrow | ppt-307 |
| Feathered paper strip | ppt-265 |
| Dot connectors | ppt-225, ppt-226 |

Native paths, gradient stops, transparency, brightness, shadows and layer order
are retained. Motifs are normalized for ordinary slide sizes; frame strokes stay
2 px, connector strokes 2.7 px and endpoint dots 8 px before fitting small slides.
The original vertical divider is horizontal and fades to transparency so it
works on any background. The white feathered paper preview has a gray backing
for visibility; that backing is not inserted. Connector variants use the source
ecosystem colors: peach `#EE916F`, coral `#DC486E`, magenta `#A63387`, purple `#69438C`.

Section panel and Blue title band are reusable arrangements of the poster's
charcoal outline, Arial heading, blue `#0082CA`, navy `#00609C` and pale blue
`#D7E2EA`. Their placeholder titles are directly editable text.

`sac-theme.js` provides the gallery’s palette and text styles. `sac-motifs.js` stores source geometry;
`sac-styles.js` clones it on every insertion and uses the normal SVG renderer for
previews. `sac-poster-parts.js` records the source sheet’s geometry and colors,
and `sac-poster.js` defines the reusable sections and their picture references.

Run `node --test tests/sac-*.test.mjs` and `node tests/sac-styles-browser.mjs`
(set `PLAYWRIGHT_MODULE` if needed) for focused checks. Normal repo tests apply.
