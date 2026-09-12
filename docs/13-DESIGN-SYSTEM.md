# 13 · Design system

The dashboard's visual language is taken from the reference component supplied with the brief (the
filter token bar, now at `apps/dashboard/src/components/ui/filter-token-bar.tsx`). Everything here
exists so a new screen can be built without inventing anything.

## What the reference established

Reading the component rather than guessing at it, seven rules fall out:

| Rule | How it shows up |
|---|---|
| Neutral first | zinc scale throughout; colour appears only for state and data |
| Small chrome type | 13px body, 1.35 line height (`text-chrome`) |
| Hairlines, not borders | `zinc-950/[0.07]` and `white/[0.07]`, never a solid grey rule |
| Translucent fills | `bg-zinc-100/70` and `bg-white/[0.04]`, so surfaces layer rather than stack |
| 6px geometry | `rounded-md` for controls, `rounded-lg` for surfaces and popovers |
| Motion is functional | 120ms ease for popovers, springs for layout, `active:scale-[0.98]` for presses, `useReducedMotion` respected |
| Accessibility is structural | roving tabindex, `aria-activedescendant`, focus restoration, `focus-visible` rings |

## Tokens

All tokens live in `apps/dashboard/src/index.css`. Theme is class based (`.dark` on `<html>`), which
the reference popover requires: it detects its own theme with `closest('.dark')`.

**Brand.** The scale is built around the logo's own blue. `brand-600` is `#1a56f0`, sampled from the
supplied artwork; the rest of the scale is stepped around it. Chart series slot 1 is the same hue, so
brand chrome and the primary data series read as one family rather than two competing blues.

**Type.** System sans throughout, no display face. `tabular-nums` is applied to tables and to any
number that sits in a column; standalone figures keep proportional digits.

## Chart colour, and how it was chosen

Chart colours were not picked by eye. Each set was run through the palette validator against the
real surfaces this dashboard renders on (`#ffffff` light, `#18181b` dark) for lightness band, chroma
floor, colour-vision separation and contrast.

| Use | Light | Dark | Result |
|---|---|---|---|
| Categorical slots 1-3 (cache states, refusal types) | `#1a56f0` `#eb6834` `#1baf7a` | `#5c85ff` `#d95926` `#199e70` | CVD and normal-vision PASS both modes |
| Latency p50 → p95 (ordinal, one hue) | `#93b0ff` → `#1a56f0` | `#2f63fb` → `#93b0ff` | ordinal PASS both modes |
| Errors (single series) | `#d03b3b` | `#e66767` | contrast PASS; no separation check applies to one series |

Two results are worth recording because they constrain future changes.

**p95 keeps the higher-contrast step in both themes.** On white that is the deeper blue; on the dark
surface it is the lighter one. The dark ramp is therefore not the light ramp flipped, and reversing
it would make the metric the reader cares about the quieter of the two lines.

**Slot 3 carries a contrast warning in light mode, and it is kept anyway.** `#1baf7a` measures 2.74:1
against white, below the 3:1 relief threshold. Darkening it fixes that and breaks something worse:
at `#149a6b` its protanopia separation from slot 2 falls to ΔE 7.3, and by `#0f8f63` to 5.5, below
the floor of 8. Colour-vision separation outranks surface contrast, so the green stays and the
warning is discharged the way the validator allows: every chart using it carries a legend, series of
four or fewer are direct-labelled, and the same data is available as a table.

### The status stack was rejected

`docs/07` section 3.1 asked for a stacked 2xx/4xx/5xx bar chart. That encoding was dropped for two
reasons, one measured and one structural:

- **Measured.** The four status colours fail as a categorical fill set. Good versus critical measures
  Delta E 4.1 under deuteranopia, far below the floor of 8: the classic red/green pair that a large
  minority of readers cannot separate. Substituting the categorical yellow and red steps failed too,
  at 13.0 in normal vision against a floor of 15.
- **Structural.** A stack dominated by 2xx hides exactly the error slivers the chart exists to show.

What shipped instead: requests, latency and refusals are three single-purpose charts, and the status
split is a bar list where the label sits beside its own bar and no colour carries identity. Status
colours are reserved for badges, where they always appear with a numeral or a word.

## Chart conventions

- Every chart has a hover layer: a crosshair cursor and a tooltip built on the same surface as the
  reference popover.
- A legend is present whenever there are two or more series. One series needs none; the title names it.
- Empty ranges explain themselves. "No traffic in this range" with a hint, never a blank box.
- Gaps are gaps. The metrics API groups by bucket, so a quiet minute returns no row; the client fills
  the window with zeroes before charting, and latency in an empty bucket is drawn as a break in the
  line rather than a dip to zero.
- Spikes above three times the median of the range are marked on the requests chart.

## Component inventory

```
components/ui/       button, badge, card, data-table, empty-state, kpi-card, problem-alert,
                     skeleton, sparkline, theme-toggle, time-range, filter-token-bar (supplied)
components/charts/   chart-parts (frame, tooltip, axis styling, spike detection), traffic-charts
components/shell/    app-shell (rail + page header), health-pill
components/brand/    logo (Mark, Wordmark), logo-paths (generated)
```

## The logo

The supplied artwork is a raster PNG on a transparent ground, kept at
`apps/dashboard/src/assets/logo.png` and mirrored to `docs/assets/logo.png` for the README banner.

The app cannot use the raster directly. It needs the mark at 20px in the rail and at banner size on
the login screen, in two themes, which rules out a fixed bitmap. Redrawing it by hand was tried and
rejected: the disc is not a true circle and the door is not a true parallelogram, so a "clean"
reconstruction drifts visibly against the original.

Instead `tools/trace-logo.mjs` traces the artwork's own outlines and writes
`components/brand/logo-paths.ts`. It decodes the PNG with Node's zlib (no image dependency), runs
marching squares over the alpha coverage field for sub-pixel edges, links the segments into closed
loops, and simplifies each loop to 0.12 units with Ramer-Douglas-Peucker. The result is three paths
(mark, "Omni", "Gate") totalling about 8 KB, filled from the theme's tokens. The same script emits
`public/favicon.svg` from the mark path, so the favicon cannot drift from the app.

Re-run it after any change to the artwork:

```
node tools/trace-logo.mjs
```

Two places express brand identity: those generated paths, and the `brand` scale in `index.css`.

`Mark` is the disc and door alone, for square slots. `Wordmark` is the full lockup and is what the
rail, the mobile header and the login screen use, so the lettering is always the artwork's own rather
than a system font set to resemble it.

## Accessibility commitments

- Every interactive element has a visible focus ring, one treatment everywhere.
- State is never colour alone: badges pair a colour with a numeral or word, and chart series pair a
  swatch with a legend label.
- Text contrast was checked rather than assumed. White on brand 600 is 5.78:1, brand 600 on white is
  5.78:1, muted labels clear 4.5:1 in both themes.
- Both themes are selected, not flipped: the dark chart steps were chosen for the dark surface and
  validated against it.
- Tables carry captions, drawers are dialogs that close on Escape, and the rail traps nothing.

## Known deviations from the supplied component

The supplied filter bar is used verbatim apart from one line. Its ref registration returned the
result of an assignment, which React 19 interprets as a cleanup function and TypeScript rejects
outright. It is now a block body that returns nothing. Its remaining lint warnings (reading a ref
during render, setting state inside an effect) are the component's own patterns and were left alone.
