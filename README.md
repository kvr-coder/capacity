# Capacity Cockpit

An interactive **production capacity modeling cockpit** for a five-plant, four-continent
manufacturing network. 15,000 SKUs, 150 work centers, weekly buckets over 18 months.

Planners see where the network runs out of hours, drag load from a saturated work center to
one that can take it, turn OEE and run rate independently, ramp OEE along a glide path, and
watch capacity move.

Everything runs in the browser. The model lives in a Web Worker; no backend, no data leaves
the machine.

---

## The model

A **SKU** is made by walking a **routing** — an ordered list of **operations**, each
performed at one **work center**. Routings are 2 to 7 operations long; a SKU can be moulded
in Suzhou, shipped as a semi-finished part, and painted and packed in Wrocław.

A work center owns **two independent capacity pools**:

```
machine   count × shiftsPerDay × hoursPerShift × daysPerWeek × utilisationFactor
labour    the same, over operators
```

An operation consumes hours from both, and **either can bind**. That distinction is the
point: a machine-bound work center wants capex, a labour-bound one wants hiring, and a
single capacity number cannot tell you which.

**Rate** and **OEE** are two independent knobs whose product is the effective rate:

```
effectiveRate = resolvedRate × resolvedOEE
requiredHours = quantity / effectiveRate
```

Rate resolves routing operation → production version → SKU override. OEE resolves plant →
work center → glide path → SKU×work-center override. Moving one never disturbs the other,
so a planner can always see which knob they turned.

Available hours are raw shift hours **minus dated downtime only**. Unplanned loss is
already inside OEE — counting it twice is the easiest error in a model like this, and the
tests guard against it.

## Capability, and what a machine *could* do

Two separate questions, deliberately kept apart:

| Question | Source | Used for |
|---|---|---|
| What may this work center run? | The production-version **allow-list** | Planning. Always. |
| What could it run? | Its **feature** set vs the operation's requirements | Proposals only |

A generation-1 moulding machine has `{MOLD, TOL_C, CAV_2}`. A painting operation needs
`{PAINT, CURE}`. It is not capable — but its machine class carries a retrofit that adds
exactly those features for a known capex and lead time. The tool surfaces that as a costed
candidate. The plan never uses it until someone approves it.

That is why the network map can answer *"which machine could we repurpose?"* instead of
only *"which machine is busy?"*.

## Two plans and an inventory

- **Supply plan** — what the plants have committed to. **This is what loads capacity.**
- **Demand plan** — unconstrained customer demand. Reference only, drawn as a hairline.
- **Inventory** — on hand, in transit, safety stock.

The supply plan does not track demand, because it is constrained by inventory, projects and
capacity. The distance between the two is the **plan gap**: demand the plan quietly chose
not to serve. It is a headline number, not a footnote.

## Sourcing rules

In any week a SKU runs at exactly **one** work-center chain. The source **may change**
between weeks — that is a dated transfer, and it is legal by default. Two sources in one
week is **dual sourcing**, a different thing with different approvals, and it requires an
explicit switch.

## Downtime

Planned loss is a typed, dated, work-center-scoped event you can argue with:

`shutdown` · `project` · `qualification` · `maintenance` · `installation` · `changeover`

Each names the pools it blocks — collective vacation drains **labour**, preventive
maintenance drains **machine** — and carries a status. An `atRisk` event can be modelled
with a slip, so "the installation runs four weeks late" is one field, not a rebuild.

Unplanned loss has no date and lives in OEE.

## What you can change

Every change is a **move**: a named, dated, reversible object. Moves apply immediately and
are undoable; a scenario is a list of them that reads as a decision log.

`resourceMove` · `oeeSet` · `oeeGlide` · `rateSet` · `shiftChange` · `downtimeUpsert` ·
`utilisationCeiling` · `retrofit` · `addWorkCenter` · `wipTransfer` · `planScale` ·
`sourceSwitch`

`addWorkCenter` seeds a machine that does not exist in master data yet by copying a
sibling's features and pools — so a capex proposal can be modelled before anyone buys
anything.

## The screens

| Screen | What it answers |
|---|---|
| **Cockpit** | Where does the network run out, and what is the plan gap? |
| **Network map** | Zoomable globe → plant → work center, with capability links and drag-and-drop |
| **Work centers** | The register, and the hour-by-hour build-up for one machine |
| **Products** | What the network is making, by family, group and SKU |
| **Scenarios** | The decision log, and this plan against another |
| **Data** | Master data, and SAP import/export |

## The five plants

| Plant | Site | Region | Role |
|---|---|---|---|
| `US-TOL` | Toledo, Ohio, US | NAM | High automation, best OEE, expensive hours |
| `MX-SLP` | San Luis Potosí, MX | NAM | The NAM cost play |
| `DE-ING` | Ingolstadt, DE | EUR | The flagship — highest labour, deepest capability |
| `PL-WRO` | Wrocław, PL | EUR | The EUR cost play, growing |
| `CN-SUZ` | Suzhou, CN | APAC | Cheapest hours, longest transit |

## Data

The mock data factory is deterministic — a seeded PRNG, no `Math.random`, no `Date.now`.
The same profile produces byte-identical output every time.

```bash
npm run generate:extract              # writes SAP-shaped CSVs to mock/extract/
npm run generate:extract -- --profile=demo
```

It emits the extract objects a real SAP pull would give you — `MARA`, `MARC`, `MAST`,
`STPO`, `PLKO`, `PLPO`, `MAPL`, `CRHD`, `CRCA`, `KAKO`, `KAPA`, plus `DEMAND`, `SUPPLY` and
`INVENTORY` — and the loader parses them back. A round-trip test asserts the reconstruction
is lossless, so the integration path is real from day one rather than deferred.

Two things standard SAP objects cannot express are carried as clearly-named extensions:
work-center **features** and **OEE** overrides/glide paths. Being explicit about that seam
beats pretending `CRHD` carries them.

Profiles: `demo` (1,500 SKUs / 40 work centers), `standard` (15,000 / 150), `large`
(30,000 / 240).

## Getting started

```bash
npm install
npm run dev            # http://localhost:5173
```

```bash
npm run typecheck
npm test               # model + SAP round-trip
npm run lint
npm run build
npm run uxtest         # drives the built app in Chromium and screenshots every screen
```

Deploying to a subpath:

```bash
VITE_BASE=/capacity/ npm run build
```

## Layout

```
src/
  domain/    pure model — no React, no DOM, deterministic, unit-tested
  data/      mock data factory, SAP writer and loader
  worker/    the engine's home, and the typed client that talks to it
  state/     zustand UI state + worker-backed hooks
  charts/    hand-built SVG chart kit
  canvas/    the zoomable network map
  routes/    one file per screen
  components/ shell, filter bar, shared UI
  lib/       format, CSV, storage
  styles/    design tokens + global CSS
```

`src/domain` imports nothing above it and touches no browser API. The model lifts into
Node, a CLI or a server unchanged — which is the migration path when this outgrows the
browser.

## Performance

At 15,000 SKUs the architecture is not a style choice:

- Nothing sized SKU × week enters React state. The worker returns aggregates.
- Dense results are `Float64Array` indexed `row * weekCount + week`.
- The engine materialises the work-center × week grids (11,700 cells) on every run; SKU
  detail is computed only for the selected slice.
- `ModelResult.runtimeMs` is displayed in the header, so a regression is visible rather
  than merely felt.

The browser ceiling is roughly 20–30k SKUs. Past that this wants a server, and the domain
package is written so that is a configuration change rather than a port.

## A note on the charts

There is no charting library. Every chart is hand-built SVG — except the utilisation grid,
which draws 11,700 cells to a `<canvas>` with a thin SVG interaction layer on top, because
an 11,700-node SVG does not stay interactive.

The palette was checked with a CVD and contrast validator in both light and dark mode.
Colour follows the **entity**: a plant owns its hue for the life of the app, so filtering
never repaints the survivors. Utilisation against a ceiling is **polarity**, so it is
diverging — cool below, neutral at the ceiling, warm above — never a rainbow and never a
sequential ramp.

Changing a hex in `src/styles/tokens.css` invalidates that validation. Re-run it first.

## Caveats

- Single-period allocation. No inventory carried between weeks, no lot sizing, no
  lead-time offset between the week a part is made and the week it is needed.
- Tooling and moulds are not modelled as a shared cross-work-center pool. For moulding this
  is often the real constraint, and the pool structure is built to accept it as a third
  pool — but it is not in this version.
- The relief search is a ranked heuristic, not an optimiser. It is deterministic and
  explainable, which for capacity planning is usually the better trade.
- Demand is a single deterministic plan. No stochastic demand, no service-level buffering.
