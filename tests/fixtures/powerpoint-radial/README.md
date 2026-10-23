# Native PowerPoint radial gradient references

Captured on 2026-10-23 using **Microsoft PowerPoint for Mac 16.114.1**. These are synthetic comparison shapes; no user presentation content is included.

`reference.pptx` and `extra.pptx` were generated from the models in `cases.json`, opened in the installed PowerPoint application, and exported through **File → Export → PNG → Save Every Slide → 800 × 600**. Every reference PNG has its SHA-256 in the manifest. `nativeGeometry` records the radial shading coordinates from PowerPoint's separate **PDF / Best for printing** export, converted from EMU to CSS pixels. PNG export is the pixel reference; PDF is used only to measure geometry.

Reproduce the input deck with:

```sh
node scripts/create-radial-reference.mjs /tmp/radial-reference.pptx
```

The combined deck has 32 slides in manifest order. Export it with native PowerPoint; other office applications are not interchangeable references. To compare the checked-in references, serve the repository and run `tests/powerpoint-radial.html`. The test exercises the actual editor `exportPNG()` path, with a two-pixel exclusion around antialiased boundaries.

## Findings and scope

- The radial outer circle circumscribes the **actual path bounds**. `fillToRect` positions the focus within those bounds, not within the circle's square. Custom cubic paths use their extrema, not the control-point rectangle.
- With `rotWithShape=0`, bounds are computed after rotation in slide coordinates. The resulting gradient is transformed back to local coordinates.
- A corner focus degenerates onto the circle. Native PowerPoint expands each half-extent by one point (4/3 CSS px) before calculating the radius. This avoids the black wedges produced by an exterior SVG focus.
- Exactly two stops at 0 and 1 use a different color interpolation from ordinary multistop/inset-endpoint gradients. Native PNG measurements match a per-channel exponent of 1.875: decreasing channels use `t^1.875`, increasing channels use `1-(1-t)^1.875`. Alpha stays linear. This is an empirical compatibility rule verified for primary colors, mixed colors, reversed colors, brightness, transparency, and linear/radial fills on this PowerPoint version, not a claim that OOXML mandates it.
- The editor emits bounded intermediate SVG paint stops. The original two editable/project/PPTX stops remain intact. Adding a stop samples the displayed color; native PowerPoint also changes interpolation once there are more than two stops.

The main 16 cases have measured interior mean RGB error below 1/255 after the fix. Main shapes and the additional color/geometry cases use a 1.2/255 regression threshold. A 60 × 20 corner sample has a 5/255 allowance for native raster sampling at this size; the diagonal 12 px outline has a 6/255 allowance because PowerPoint computes that stroke paint from its expanded outline. Those allowances are explicit and are not evidence of pixel identity. The references do not claim parity for Windows PowerPoint, nonempty `tileRect`, or unsupported regional focus geometry.
