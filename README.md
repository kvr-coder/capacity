# Capacity Cockpit

**A tool for answering one question: can our factories actually make what we've promised — and if not, where does it break, and what can we do about it?**

Five plants on four continents. 15,000 products. 150 machines. Eighteen months of weekly
plan. This shows you where the network runs out of hours, and lets you try fixes and see
what they'd do — without touching the real plan.

Everything runs in your browser. No server, no database, no account, no data leaves your
machine.

> Everything below is also in the app itself — click the **?** in the top-right corner
> (Help & guide) for the same walkthrough and glossary without leaving the screen you're on.

---

## Open it

**Just want to look at it?** → [kvr-coder.github.io/capacity](https://kvr-coder.github.io/capacity/)

Nothing to install. It's a website.

**Want to run it yourself, without installing anything?**
Click **Code → Codespaces → Create codespace** on the GitHub page. That gives you the whole
development environment in a browser tab; it installs itself and opens the app.

**Want it on your own machine?** You'll need [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/kvr-coder/capacity.git
cd capacity
npm install
npm start
```

That opens `http://localhost:5173`. The first screen takes a few seconds while it builds the
15,000-product dataset — the loading bar says what it's doing.

> **Why can't I just open the files from GitHub?** The source is written in TypeScript, which
> browsers can't run directly. It has to be compiled into plain JavaScript first — that's what
> `npm start` and the hosted link both do for you.

---

## The idea in one minute

If you've never done capacity planning, here's the whole concept.

**A machine has hours.** A work center running 2 shifts × 8 hours × 5 days has 80 hours a
week. That's all it will ever have.

**A plan asks for units.** "Make 40,000 housings in week 12."

**A rate converts between them.** If the machine makes 500 housings an hour, 40,000 units
needs 80 hours.

**Utilisation is the comparison.** Needs 80 hours, has 80 hours → 100% utilised. Needs 95 →
119%, which is impossible. Something doesn't get made.

That impossible number is a **bottleneck**, and the whole job is: find them, then decide what
to do. Usually one of:

| Fix | When it helps |
|---|---|
| Move the work to another machine | Something else has spare hours and is allowed to make it |
| Add a shift | The machine is idle part of the week |
| Hire more operators | The *people* ran out before the machine did |
| Improve OEE | The machine loses time to changeovers, small stops, scrap |
| Modify a machine | It *could* do the job with a retrofit you'd have to pay for |

This tool shows you all five, with the numbers attached.

---

## Your first five minutes

A guided walkthrough. Open the app and follow along.

### 1. Start at the Cockpit

The big number is **network utilisation** — how hard the whole network is working. Around
80% is healthy: busy, with room to absorb surprises.

But the network average hides everything interesting. Look at the tiles beside it:

- **Peak utilisation** — the single worst machine-week anywhere. If this is 145%, one machine
  somewhere is being asked for half again more hours than it has.
- **Overloaded work-center weeks** — how many machine-weeks are over the line.
- **Plan gap** — demand the plan already decided not to serve.
- **Shortfall units** — what the network physically cannot make.
- **Machine-bound vs labour-bound** — of the overloaded machines, how many ran out of
  *machine* hours versus *operator* hours. This decides whether the answer is money or
  people, and it's the most useful number on the screen.

### 2. Read the grid

Scroll to **"Where the network runs out"**. Every row is a machine, every column a week.

- **Blue** = spare capacity
- **Grey** = right at the limit
- **Red** = over the limit
- **Hatched** = shut down that week (maintenance, holiday, a project)
- **▲** = so far over it had to be clipped

You should see it drift from blue on the left to red on the right. That's the story: the
network is comfortable now and tightens later. **Click any red cell.**

### 3. Look for relief

Clicking a cell selects that machine and shows **relief options** — other work centers that
could take some of its load. Each one is labelled:

| Label | Meaning |
|---|---|
| **Approved** | Allowed today. Use it now, costs nothing. |
| **Needs qualification** | Physically capable, but not signed off. Takes time. |
| **Needs retrofit** | Would work if you modified it. Shows the price and the lead time. |

That distinction is the point of the tool. A machine being *able* to do something and being
*allowed* to do it are different facts, and only one of them is in your ERP system.

### 4. Try a fix, then undo it

Drag the **utilisation ceiling** slider down to 90%. This says "don't plan above 90% of the
hours that exist" — realistic, because nobody runs flat out. Watch every number update.

Notice the header: you started on **Baseline**, and it switched to **Scenario 1**. The
baseline is read-only on purpose — it's what the real master data says, so nothing can
quietly change it. Your edit forked a working copy automatically.

Now press **Undo**. Everything goes back.

**Every change works this way.** It applies immediately, it's listed in plain English on the
Scenarios screen, and it can be taken back.

### 5. See the network

Go to **Network map**. You start on a globe with five plants, each a circle sized by capacity
and coloured by how loaded it is.

**Click a plant.** You zoom into its machines, arranged left to right by process stage —
moulding, then painting, then packing. Each machine shows its code, a utilisation ring, and
an **L** badge if operators are the constraint rather than the machine.

Down the right edge are the **other plants**, showing how many machines there share a
capability with this one. Hover a machine to see its links. **Backspace** goes back out.

### 6. Turn the OEE knob

Go to **Work centers**, click any row. Scroll to **OEE**.

You'll see two controls that deliberately never touch each other:

- **The OEE ramp** — a curve showing OEE improving over time. Drag the handle on the right,
  or focus it and use arrow keys. This models an improvement programme: "we'll get this line
  from 77% to 85% over twelve weeks."
- **The run rate** — how many units per hour the machine makes.

Both change capacity, and they're separate on purpose, so you can always see which one you
moved.

---

## The six screens

| Screen | Use it to answer |
|---|---|
| **Cockpit** | Where does the network run out, and what is it costing us? |
| **Network map** | Where physically is everything, and what could take load from what? |
| **Work centers** | What's happening at one machine, hour by hour? |
| **Products** | What are we being asked to make, and which products aren't getting served? |
| **Scenarios** | What did we change, and what did it do? |
| **Data** | What's the underlying master data, and can I export it? |

---

## Words you'll see

| Word | What it means |
|---|---|
| **Work center** | A machine or group of machines that does one kind of job. The thing that has hours. |
| **Routing** | The ordered list of steps to make a product. Mould → trim → paint → inspect → pack. |
| **Operation** | One step in a routing, done at one work center. |
| **Machine pool / labour pool** | A work center has two separate limits: machine hours and operator hours. Either can run out first. |
| **Binding pool** | Which of the two ran out. Machine-bound → buy equipment. Labour-bound → hire people. |
| **OEE** | Overall Equipment Effectiveness. What fraction of time the machine is actually producing good parts. 0.80 means 80%. |
| **Run rate** | Units per hour when it *is* running. Separate from OEE. |
| **Ceiling** | The utilisation you refuse to plan above. Set it to 90% and anything over reads as overload even though the hours technically exist. |
| **Supply plan** | What the factories have committed to make. **This is what consumes capacity.** |
| **Demand plan** | What customers actually want. Reference only. |
| **Plan gap** | Demand minus supply. What the plan chose not to serve. |
| **Shortfall** | What the plan wanted but the machines physically can't produce. |
| **Setup / changeover** | Time lost switching a machine from one product to another. Charged once per product per week. |
| **Yield** | Fraction of good parts. 0.98 means you must start 102 to finish 100 — and that compounds backwards up the routing. |
| **Downtime event** | Planned, dated lost time: maintenance, a project, a shutdown, a qualification. |
| **WIP transfer** | Shipping a half-finished part to another plant to complete it. |
| **Dual sourcing** | Making one product in two places *in the same week*. Different from moving it, which is a dated switch. |
| **Retrofit** | Modifying a machine so it can do something new. Costs money, takes weeks. |
| **Glide path** | A planned improvement over time, rather than a step change. |
| **Move** | Any change you make. Named, dated, and undoable. |
| **Scenario** | A list of moves. Your plan-B, comparable against the baseline. |

---

## Changing things

Everything you can change is a **move**, and every move follows the same three rules:

1. **It applies immediately.** No Apply button anywhere.
2. **It can be undone.** Ctrl/Cmd-Z, or the undo arrow in the header.
3. **It's written down.** The Scenarios screen lists every move in plain English, in order.
   You could hand that list to a colleague and they'd know exactly what you proposed.

You can move load between machines, set or ramp OEE, change a run rate, change shifts, add
or edit downtime, set a utilisation ceiling, retrofit a machine, invent a machine that
doesn't exist yet, transfer half-finished work between plants, scale a plan, or switch a
product's source on a date.

The **baseline can't be edited** — it's what master data says. Editing it forks a scenario
automatically and tells you it did.

---

## Using your own data

The built-in dataset is generated, but it's shaped like a real SAP extract on purpose.

**Export** — the Data screen downloads every table: `MARA`, `MARC`, `MAST`, `STPO`, `PLKO`,
`PLPO`, `MAPL`, `CRHD`, `CRCA`, `KAKO`, `KAPA`, plus `DEMAND`, `SUPPLY` and `INVENTORY`.

**Import** — feed the same shapes back in. The loader finds columns by name, so extra columns
don't matter and column order doesn't matter. Problems are reported per row with the table
and row number, all at once rather than one at a time, and you choose whether to import the
valid rows anyway.

Two things standard SAP tables can't express ship as clearly-named extensions rather than
being smuggled into a field that doesn't mean that: machine **features** (what a machine is
physically capable of) and **OEE** overrides and ramps.

```bash
npm run generate:extract                    # writes the CSVs to mock/extract/
npm run generate:extract -- --profile=demo  # a smaller one
```

Profiles: `demo` (1,500 products / 40 machines), `standard` (15,000 / 150), `large`
(30,000 / 240).

---

## For developers

```bash
npm start          # dev server
npm run build      # production bundle into dist/
npm run typecheck  # tsc -b, strict + noUncheckedIndexedAccess
npm test           # 436 unit tests
npm run lint
npm run uxtest     # drives the built app in Chromium, screenshots every screen
npx vite-node scripts/diagnose.ts   # asserts the dataset's calibration bands
```

```
src/
  domain/    the model — pure, deterministic, no React, no DOM
  data/      mock data factory, SAP writer and loader
  worker/    the engine's home, and the typed client that talks to it
  state/     zustand UI state + worker-backed hooks
  charts/    hand-built SVG chart kit
  canvas/    the zoomable network map
  routes/    one file per screen
  components/, lib/, styles/
```

**Architecture, briefly.** At 15,000 products the shape isn't a style choice. The dataset
never leaves the Web Worker; only aggregates and paged slices cross to the UI. Dense results
are `Float64Array` indexed `row * weekCount + week`. The engine rebuilds the 150 × 78 grids
on every run (~390ms) and computes per-product detail only for what you've selected. The
runtime is shown in the header so a regression is visible rather than merely felt.

`src/domain` imports nothing above it and touches no browser API, so the model lifts into
Node or a server unchanged. That's the migration path when this outgrows the browser, around
20–30k products.

**One rule worth knowing before you change the model:** OEE is applied to the *rate* and
nowhere else. Available hours stay raw shift hours minus dated downtime, because unplanned
loss already lives inside OEE. Applying it in both places inflates every required hour by
`1/OEE` — a ~20% error that looks entirely plausible on a chart and survives a long way into
a capex conversation. There's a boxed comment in `rates.ts` and a test that fails if anyone
does it.

`CLAUDE.md` has the full conventions, including the data-visualisation rules the charts were
built and validated against.

---

## What this doesn't do

Worth knowing before you trust a number:

- **No inventory between weeks.** Each week is solved on its own. You can't build ahead in
  week 10 to cover week 14.
- **No lot sizing or sequencing.** Setup is charged once per product per machine per week,
  which is an approximation of a real changeover schedule.
- **Tooling isn't modelled.** For moulding, the mould is often the real constraint — and a
  mould can only be in one machine at a time. The two-pool structure would accept a third
  pool for it, but it isn't there yet.
- **Demand is one fixed plan.** No probability, no safety-stock logic.
- **Relief search is a ranked heuristic, not an optimiser.** It's deterministic and
  explainable, which for this kind of planning is usually the better trade — but it won't
  claim to have found the best possible answer, because it hasn't looked.
