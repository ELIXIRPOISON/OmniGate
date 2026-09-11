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

**Brand.** A violet scale, deliberately distinct from the blue used for chart series so brand chrome
and data never read as the same thing. It is one block in one file. Point it at the real logo's hue
and nothing else changes.

**Type.** System sans throughout, no display face. `tabular-nums` is applied to tables and to any
number that sits in a column; standalone figures keep proportional digits.

## Chart colour, and how it was chosen

Chart colours were not picked by eye. Each set was run through the palette validator against the
real surfaces this dashboard renders on (`#ffffff` light, `#18181b` dark) for lightness band, chroma
floor, colour-vision separation and contrast.

| Use | Light | Dark | Result |
|---|---|---|---|
| Categorical slots 1-3 (cache states, refusal types) | `#2a78d6` `#eb6834` `#1baf7a` | `#3987e5` `#d95926` `#199e70` | all-pairs PASS both modes |
| Latency p50 → p95 (ordinal, one hue) | `#86b6ef` → `#2a78d6` | `#6da7ec` → `#256abf` | ordinal PASS both modes |
| Errors (single series) | `#d03b3b` | `#e66767` | contrast PASS; no separation check applies to one series |

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
components/brand/    logo (placeholder mark and wordmark)
```

## Replacing the placeholder logo

`components/brand/logo.tsx` holds a stand-in mark: a gateway aperture with traffic passing through.
To swap in the real artwork, drop it at `src/assets/logo.svg`, import it in that file, and delete the
inline paths. Then set the brand scale in `index.css` to the logo's hue. Those are the only two
places brand identity is expressed.

## Accessibility commitments

- Every interactive element has a visible focus ring, one treatment everywhere.
- State is never colour alone: badges pair a colour with a numeral or word, and chart series pair a
  swatch with a legend label.
- Text contrast was checked rather than assumed. White on brand 600 is 6.39:1, brand 600 on white is
  6.39:1, muted labels clear 4.5:1 in both themes.
- Both themes are selected, not flipped: the dark chart steps were chosen for the dark surface and
  validated against it.
- Tables carry captions, drawers are dialogs that close on Escape, and the rail traps nothing.

## Known deviations from the supplied component

The supplied filter bar is used verbatim apart from one line. Its ref registration returned the
result of an assignment, which React 19 interprets as a cleanup function and TypeScript rejects
outright. It is now a block body that returns nothing. Its remaining lint warnings (reading a ref
during render, setting state inside an effect) are the component's own patterns and were left alone.
