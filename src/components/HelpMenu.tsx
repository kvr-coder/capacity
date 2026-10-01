/**
 * The in-app help guide.
 *
 * The README teaches the tool from zero for someone who has never done
 * capacity planning, but a README only helps if the reader remembers to go
 * find it. This is the same content, reachable without leaving the app: one
 * button in the header, always in the same place, on every screen.
 *
 * Content lives here rather than being fetched from the README at runtime —
 * the app has no server to fetch it from, and a build-time copy can't go
 * stale relative to what's on screen the way a live link to GitHub could.
 * When the README's guidance changes, this file changes with it.
 */

import { useEffect, useState } from 'react'
import { Icon, Modal, Tabs } from '@/components/ui'
import type { TabItem } from '@/components/ui'
import styles from '@/components/HelpMenu.module.css'

// ---------------------------------------------------------------------------
// Opening it from elsewhere — mirrors openCommandBar's module-level pattern,
// so any screen can send a reader to a specific section (an EmptyState's
// "what does this mean?" link, say) without threading state through props.
// ---------------------------------------------------------------------------

type Listener = (tabId: string | undefined) => void
const openListeners = new Set<Listener>()

export function openHelpMenu(tabId?: string): void {
  for (const listener of openListeners) listener(tabId)
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const FIXES: Array<{ fix: string; when: string }> = [
  { fix: 'Move the work to another machine', when: 'Something else has spare hours and is allowed to make it' },
  { fix: 'Add a shift', when: 'The machine is idle part of the week' },
  { fix: 'Hire more operators', when: 'The people ran out before the machine did' },
  { fix: 'Improve OEE', when: 'The machine loses time to changeovers, small stops, scrap' },
  { fix: 'Modify a machine', when: 'It could do the job with a retrofit you would have to pay for' },
]

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: '1. Start at the Cockpit',
    body: 'The big number is network utilisation — how hard the whole network is working. Around 80% is healthy: busy, with room to absorb surprises. But that average hides everything interesting, so look at the tiles beside it: peak utilisation (the single worst machine-week anywhere), overloaded work-center weeks, the plan gap (demand the plan already decided not to serve), shortfall units (what the network physically cannot make), and machine-bound vs labour-bound — of the overloaded machines, how many ran out of machine hours versus operator hours. That last one decides whether the answer is money or people.',
  },
  {
    title: '2. Read the grid',
    body: 'Scroll to "Where the network runs out." Every row is a machine, every column a week. Blue means spare capacity, grey means right at the limit, red means over the limit, a hatch pattern means shut down that week, and a ▲ means so far over it had to be clipped. You should see it drift from blue on the left to red on the right — comfortable now, tighter later. Click any red cell.',
  },
  {
    title: '3. Look for relief',
    body: 'Clicking a cell selects that machine and shows relief options: other work centers that could take some of its load, each labelled Approved (allowed today, costs nothing), Needs qualification (physically capable, not signed off, takes time), or Needs retrofit (would work if modified, with a price and a lead time). That distinction — able to do something versus allowed to do it — is the whole point of the tool, and only one of those two facts lives in a normal ERP system.',
  },
  {
    title: '4. Try a fix, then undo it',
    body: 'Drag the utilisation ceiling slider down to 90% — "don’t plan above 90% of the hours that exist," which is realistic, since nobody runs flat out. Every number updates. Notice the header switches from Baseline to a new working scenario: the baseline is read-only on purpose, so nothing can quietly change what master data actually says, and your edit forked a copy automatically. Press Undo. Everything goes back. Every change in this tool works this way: applies immediately, is listed in plain English on the Scenarios screen, and can always be taken back.',
  },
  {
    title: '5. See the network',
    body: 'Go to Network map. You start on a globe with five plants, each a circle sized by capacity and coloured by load. Click a plant to zoom into its machines, arranged left to right by process stage. Each one shows its code, a utilisation ring, and an L badge if operators — not the machine — are the constraint. Down the right edge are the other plants, showing how many of their machines share a capability with this one. Backspace goes back out.',
  },
  {
    title: '6. Turn the OEE knob',
    body: 'Go to Work centers, click any row, and scroll to OEE. Two controls deliberately never touch each other: the OEE ramp (a curve showing OEE improving over time — drag the handle, or focus it and use arrow keys, to model an improvement programme) and the run rate (units per hour). Both change capacity; they stay separate so you can always see which one you moved.',
  },
]

const SCREENS: Array<{ name: string; answers: string }> = [
  { name: 'Cockpit', answers: 'Where does the network run out, and what is it costing us?' },
  { name: 'Network map', answers: 'Where physically is everything, and what could take load from what?' },
  { name: 'Work centers', answers: 'What’s happening at one machine, hour by hour?' },
  { name: 'Products', answers: 'What are we being asked to make, and which products aren’t getting served?' },
  { name: 'Scenarios', answers: 'What did we change, and what did it do?' },
  { name: 'Data', answers: 'What’s the underlying master data, and can I export it?' },
]

const GLOSSARY: Array<{ term: string; meaning: string }> = [
  { term: 'Work center', meaning: 'A machine or group of machines that does one kind of job. The thing that has hours.' },
  { term: 'Routing', meaning: 'The ordered list of steps to make a product. Mould → trim → paint → inspect → pack.' },
  { term: 'Operation', meaning: 'One step in a routing, done at one work center.' },
  { term: 'Machine pool / labour pool', meaning: 'A work center has two separate limits: machine hours and operator hours. Either can run out first.' },
  { term: 'Binding pool', meaning: 'Which of the two ran out. Machine-bound → buy equipment. Labour-bound → hire people.' },
  { term: 'OEE', meaning: 'Overall Equipment Effectiveness — the fraction of time a machine is actually producing good parts. 0.80 means 80%.' },
  { term: 'Run rate', meaning: 'Units per hour when the machine is running. Kept separate from OEE.' },
  { term: 'Ceiling', meaning: 'The utilisation you refuse to plan above. Set it to 90% and anything over reads as overload even though the hours technically exist.' },
  { term: 'Supply plan', meaning: 'What the factories have committed to make. This is what consumes capacity.' },
  { term: 'Demand plan', meaning: 'What customers actually want. Reference only — it never consumes capacity.' },
  { term: 'Plan gap', meaning: 'Demand minus supply. What the plan chose not to serve.' },
  { term: 'Shortfall', meaning: 'What the plan wanted but the machines physically cannot produce.' },
  { term: 'Setup / changeover', meaning: 'Time lost switching a machine from one product to another. Charged once per product per week.' },
  { term: 'Yield', meaning: 'The fraction of good parts. 0.98 means you must start 102 to finish 100 — and that compounds backwards up the routing.' },
  { term: 'Downtime event', meaning: 'Planned, dated lost time: maintenance, a project, a shutdown, a qualification.' },
  { term: 'WIP transfer', meaning: 'Shipping a half-finished part to another plant to complete it.' },
  { term: 'Dual sourcing', meaning: 'Making one product in two places in the same week. Different from moving it, which is a dated switch.' },
  { term: 'Retrofit', meaning: 'Modifying a machine so it can do something new. Costs money, takes weeks.' },
  { term: 'Glide path', meaning: 'A planned improvement over time, rather than a step change.' },
  { term: 'Move', meaning: 'Any change you make. Named, dated, and undoable.' },
  { term: 'Scenario', meaning: 'A list of moves — a plan-B, comparable against the baseline.' },
]

const LIMITS: string[] = [
  'No inventory between weeks. Each week is solved on its own — you can’t build ahead in week 10 to cover week 14.',
  'No lot sizing or sequencing. Setup is charged once per product per machine per week, an approximation of a real changeover schedule.',
  'Tooling isn’t modelled. For moulding, the mould is often the real constraint, and a mould can only be in one machine at a time.',
  'Demand is one fixed plan — no probability, no safety-stock logic.',
  'Relief search is a ranked heuristic, not an optimiser. Deterministic and explainable, which for this kind of planning is usually the better trade — but it won’t claim to have found the best possible answer, because it hasn’t looked.',
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TABS: TabItem[] = [
  { id: 'start', label: 'Start here', icon: 'info' },
  { id: 'walkthrough', label: 'Walkthrough', icon: 'sliders' },
  { id: 'screens', label: 'Screens', icon: 'data' },
  { id: 'glossary', label: 'Glossary', icon: 'table' },
  { id: 'limits', label: 'Limits', icon: 'warning' },
]

export function HelpMenu() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<string>('start')

  useEffect(() => {
    const listener: Listener = (tabId) => {
      setOpen(true)
      if (tabId !== undefined) setTab(tabId)
    }
    openListeners.add(listener)
    return () => {
      openListeners.delete(listener)
    }
  }, [])

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Help & guide"
      description="What this tool is for, and how to use it — written for the first time you open it."
      width={760}
    >
      <Tabs label="Help sections" items={TABS} value={tab} onChange={setTab} className={styles.tabs} />

      <div className={styles.panel}>
        {tab === 'start' ? (
          <div className={styles.prose}>
            <p>
              A machine has hours. A work center running 2 shifts × 8 hours × 5 days has 80
              hours a week. That is all it will ever have.
            </p>
            <p>
              A plan asks for units: <em>&ldquo;make 40,000 housings in week 12.&rdquo;</em>
            </p>
            <p>
              A rate converts between them. If the machine makes 500 housings an hour, 40,000
              units needs 80 hours.
            </p>
            <p>
              <strong>Utilisation is the comparison.</strong> Needs 80 hours, has 80 hours
              → 100% utilised. Needs 95 → 119%, which is impossible. Something doesn&rsquo;t get
              made.
            </p>
            <p>
              That impossible number is a <strong>bottleneck</strong>, and the whole job is:
              find them, then decide what to do. Usually one of these:
            </p>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Five ways to fix a bottleneck</caption>
              <thead>
                <tr>
                  <th scope="col">Fix</th>
                  <th scope="col">When it helps</th>
                </tr>
              </thead>
              <tbody>
                {FIXES.map((row) => (
                  <tr key={row.fix}>
                    <td>{row.fix}</td>
                    <td className={styles.muted}>{row.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.muted}>This tool shows you all five, with the numbers attached.</p>
          </div>
        ) : null}

        {tab === 'walkthrough' ? (
          <div className={styles.prose}>
            <p className={styles.muted}>
              A guided first session. Open any screen and follow along — this panel stays
              reachable while you do.
            </p>
            {STEPS.map((step) => (
              <section key={step.title} className={styles.step}>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </section>
            ))}
          </div>
        ) : null}

        {tab === 'screens' ? (
          <div className={styles.prose}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>The six screens and what each answers</caption>
              <thead>
                <tr>
                  <th scope="col">Screen</th>
                  <th scope="col">Use it to answer</th>
                </tr>
              </thead>
              <tbody>
                {SCREENS.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td className={styles.muted}>{row.answers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.muted}>
              Everything you can change is a <strong>move</strong>: it applies immediately, it
              can always be undone, and it is written down in plain English on the Scenarios
              screen. The baseline itself can&rsquo;t be edited — it is what master data
              says — editing it forks a working scenario automatically.
            </p>
          </div>
        ) : null}

        {tab === 'glossary' ? (
          <div className={styles.prose}>
            <dl className={styles.glossary}>
              {GLOSSARY.map((row) => (
                <div key={row.term} className={styles.glossaryRow}>
                  <dt>{row.term}</dt>
                  <dd>{row.meaning}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        {tab === 'limits' ? (
          <div className={styles.prose}>
            <p className={styles.muted}>Worth knowing before you trust a number:</p>
            <ul className={styles.list}>
              {LIMITS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className={styles.footer}>
        <Icon name="info" size={13} />
        <span>
          The full write-up — including how to bring in your own SAP-shaped data — lives
          in the project&rsquo;s README.
        </span>
      </div>
    </Modal>
  )
}
