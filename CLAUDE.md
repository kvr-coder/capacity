# Project: Capacity Cockpit

An interactive **production capacity modeling cockpit** for a five-plant, four-continent
network. 15,000 SKUs, 150 work centers, weekly buckets over 18 months.

Planners see where the network runs out of hours, drag load from a saturated work center
to one that can take it, turn OEE and rate knobs independently, ramp OEE along a glide
path, and watch capacity move.

Standalone web app. The model runs in a **Web Worker**; there is no backend.

## Stack

- Vite 5 + React 18 + TypeScript (strict, `noUncheckedIndexedAccess` on)
- React Router 6 (`createHashRouter`)
- Zustand for UI state — **never for model data**
- Vitest for the model and the SAP loader
- No charting library. Hand-built SVG.

## Commands

```
npm run dev            dev server
npm run typecheck      tsc -b
npm test               vitest
npm run lint
npm run build          production bundle
npm run generate:extract   write SAP-shaped CSVs to mock/extract/
```

## The model in one paragraph

A **SKU** is made by walking a **routing** — ordered **operations**, each at one **work
center**. A work center owns two independent **capacity pools**, machine and labour; an
operation consumes both and either can bind. What a work center *may* run is the
**production version** allow-list (master-data truth). What it is *physically capable* of
is computed from its **feature** set and exists only to propose retrofits. The **supply
plan** loads capacity; **demand** and **inventory** are reference. **Rate** and **OEE**
are independent knobs whose product is the effective rate, and OEE may follow a dated
**glide path**.

Two distinctions the code must never blur:

- A **transfer** (source changes between buckets) is not **dual sourcing** (two sources in
  one bucket). Different approvals, different risk, different objects.
- **Planned** downtime is a dated `DowntimeEvent`. **Unplanned** loss lives inside OEE and
  has no date — never invent one.

## Structure

```
src/
  domain/      pure model — no React, no DOM, no Math.random, no Date.now
    types.ts       THE CONTRACT. Read first.
    lookup.ts      mustGet/at/groupBy/safeDiv/addTo/key/clamp/round
    time.ts        week grid, ISO weeks, month/quarter roll-up
    indexes.ts     built lookup structures over a Snapshot
    capability.ts  allow-list truth + feature matching + retrofit search
    oee.ts         OEE cascade + glide path evaluation
    rates.ts       routing -> production version -> SKU override resolution
    capacity.ts    available hours per (work center, pool, week)
    load.ts        supply plan -> operation hours -> pool grids
    sourcing.ts    single-source per bucket, dual toggle, dated switches
    moves.ts       apply scenario moves onto a Snapshot
    rollup.ts      aggregation to any RollupLevel x bucket
    relief.ts      bottleneck ranking + relief candidate search
    engine.ts      runModel()
  data/
    factory.ts     deterministic mock data generator (seeded PRNG)
    sap-writer.ts  Snapshot -> SAP-shaped CSV text
    sap-loader.ts  SAP-shaped CSV text -> Snapshot
  worker/
    protocol.ts    typed request/response contract
    engine.worker.ts
    client.ts      main-thread wrapper, promise-per-request
  state/         zustand UI state + worker-backed selectors
  charts/        hand-built SVG chart kit
  canvas/        the zoomable globe -> plant -> work center map
  routes/        one file per screen
  components/    shell, filter bar, shared UI
  lib/           format, csv, storage
  styles/        tokens.css (validated palette), global.css
```

`src/domain` imports nothing above it. The model lifts into Node or a server unchanged.

## Conventions

- Functional components, hooks only.
- `src/domain/**` is pure and deterministic. Lint enforces no `Math.random`, no
  `Date.now`, no DOM globals.
- **`noUncheckedIndexedAccess` is on.** `arr[i]` is `T | undefined`. Use `mustGet`/`at`/
  `getOr` from `@/domain/lookup`. Never `!`, never `any`, never `@ts-ignore`.
- `import type { ... }` for type-only imports.
- `@/` path alias for cross-folder imports.
- CSS Modules per component. All colour and spacing from `src/styles/tokens.css`.
  **Never a hard-coded hex in a component.**
- Money is USD past the plant boundary; local currency only on
  `Plant.labourCostPerHourLocal`.
- Time on the hot path is `WeekIndex` (an integer). ISO labels are for display only.

## Performance rules — these are not optional at 15k SKUs

- **Nothing that scales with SKU x week may enter React state.** The worker returns
  aggregates. The main thread never holds the operation grid.
- Dense numeric results are `Float64Array`, indexed `row * weekCount + week`. Never an
  array of objects for anything per-SKU-per-week.
- The engine materialises `PoolLoadGrid` (150 x 2 x 78 = 23,400 cells) on every run. That
  is cheap. SKU-level detail is computed **only for the selected slice**, on demand.
- A full run must stay under ~400ms. `ModelResult.runtimeMs` is surfaced in the UI so
  regressions are visible rather than felt.
- Drag interactions recompute optimistically against the aggregate grid; the authoritative
  run follows from the worker.

## Data-viz rules (non-negotiable — the palette was validated against them)

The five categorical slots passed a CVD and contrast validator in both modes. Changing a
hex in `tokens.css` invalidates that.

- **Colour follows the entity.** A plant owns its slot (`Plant.colorSlot`) for the life of
  the app. Filtering never repaints the survivors.
- **Never generate a 9th hue.** Fold to "Other" (`--series-other`) or facet.
- **One y-axis. Never a dual-axis chart.**
- **Sequential = one hue light→dark** (`--seq-*`) for magnitude. **Diverging = blue↔red
  with a neutral grey midpoint** (`--div-*`) for polarity. Utilisation against a ceiling is
  polarity — it is diverging, centred on the ceiling.
- **Status colours are reserved** (`--status-*`), always with an icon **and** a label.
- **Text never wears the series colour.** A coloured mark sits *beside* the text.
- Marks: bars ≤24px with a 4px data-end radius square at the baseline; lines 2px; markers
  ≥8px; area fills ~10%; gridlines hairline **solid**, never dashed.
- **2px surface-coloured gap** between touching fills; **2px surface ring** on overlapping
  dots. Never a border stroke to separate marks.
- **Legend whenever ≥2 series**, none for exactly 1. Direct-label selectively — never a
  number on every point.
- Every chart has a **table-view twin** and a hover/focus tooltip with a ≥24px hit target.
- Tooltip/legend labels come from user data — React children only, never `innerHTML`.
- Filters in **one row above** the content they scope.
- Dark mode is a selected set of steps, not a flip. The toggle wins over
  `prefers-color-scheme` in both directions.

## Visual design

This tool is looked at for hours. It should feel like precision instrumentation — quiet,
dense, confident. Generous negative space around loud data. Hairline chrome. One accent at
a time. Motion only where it explains something (a value moving between work centers), and
never longer than 200ms. Respect `prefers-reduced-motion`.
