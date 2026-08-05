/**
 * Transport tests for the worker client.
 *
 * Vitest runs in node here, so there is no real `Worker` and none is wanted:
 * spinning one up would test the browser, not the routing. Every test drives a
 * fake worker that records what was posted and replays responses on demand,
 * which is the only way to control the one thing that matters — the ORDER
 * answers come back in.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Filters, Scenario } from '@/domain/types'
import type { CatalogPayload, WorkerRequest, WorkerResponse } from '@/worker/protocol'
import type { WorkerEventLike, WorkerLike } from '@/worker/client'
import {
  EngineClient,
  SupersededError,
  WorkerError,
  WorkerTimeoutError,
  isSuperseded,
} from '@/worker/client'
import { at } from '@/domain/lookup'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class FakeWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = []
  terminated = false
  private readonly listeners = new Map<string, Array<(event: WorkerEventLike) => void>>()

  postMessage(message: WorkerRequest): void {
    this.sent.push(message)
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: WorkerEventLike) => void,
  ): void {
    const bucket = this.listeners.get(type)
    if (bucket === undefined) this.listeners.set(type, [listener])
    else bucket.push(listener)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Deliver a response as the worker would. */
  respond(response: WorkerResponse): void {
    this.emit('message', { data: response })
  }

  /** An uncaught failure inside the worker, which arrives as an `error` event. */
  crash(message: string): void {
    this.emit('error', { message })
  }

  idAt(index: number): number {
    return at(this.sent, index, 'posted request').id
  }

  private emit(type: string, event: WorkerEventLike): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

function scenario(id = 'baseline'): Scenario {
  return { id, name: 'Baseline', description: '', moves: [], colorSlot: 1 }
}

function filters(): Filters {
  return {
    plantIds: [],
    regions: [],
    familyIds: [],
    groupIds: [],
    workCenterIds: [],
    machineClassIds: [],
    fromWeek: 0,
    toWeek: 12,
    bucket: 'week',
  }
}

function catalog(): CatalogPayload {
  return {
    meta: {
      profile: 'demo',
      generatedBy: 'factory',
      seed: 1,
      skuCount: 0,
      workCenterCount: 0,
      weekCount: 0,
    },
    time: {
      weeks: [],
      weekStart: [],
      monthOfWeek: [],
      quarterOfWeek: [],
      months: [],
      quarters: [],
    },
    plants: [],
    workCenters: [],
    machineClasses: [],
    features: [],
    standardOperations: [],
    families: [],
    groups: [],
    materialCountByGroup: {},
  }
}

/** A client wired to a fake worker, already attached. */
async function attached(): Promise<{ client: EngineClient; worker: FakeWorker }> {
  const worker = new FakeWorker()
  const client = new EngineClient({ createWorker: () => worker })
  await client.ready()
  return { client, worker }
}

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------

describe('promise-per-id routing', () => {
  it('resolves each request with its own response, whatever order they arrive in', async () => {
    const { client, worker } = await attached()

    const first = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARA' })
    const second = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARC' })
    await client.ready()

    expect(worker.sent).toHaveLength(2)
    const firstId = worker.idAt(0)
    const secondId = worker.idAt(1)
    expect(firstId).not.toBe(secondId)

    // Answered in reverse — the id, not the arrival order, decides who gets what.
    worker.respond({ id: secondId, type: 'csv', table: 'MARC', content: 'second' })
    worker.respond({ id: firstId, type: 'csv', table: 'MARA', content: 'first' })

    const secondEnvelope = await second
    const firstEnvelope = await first
    expect(secondEnvelope.response.content).toBe('second')
    expect(firstEnvelope.response.content).toBe('first')
  })

  it('routes progress to the requesting caller without settling it', async () => {
    const { client, worker } = await attached()
    const phases: Array<[string, number]> = []

    const pending = client.request(
      { type: 'init', source: { kind: 'factory', profile: 'demo', seed: 1 } },
      { onProgress: (phase, pct) => phases.push([phase, pct]) },
    )
    await client.ready()
    const id = worker.idAt(0)

    worker.respond({ id, type: 'progress', phase: 'Generating', pct: 0.1 })
    worker.respond({ id, type: 'progress', phase: 'Indexing', pct: 0.6 })
    expect(phases).toEqual([
      ['Generating', 0.1],
      ['Indexing', 0.6],
    ])
    expect(client.inFlight).toBe(1)

    worker.respond({ id, type: 'ready', catalog: catalog(), timings: { totalMs: 12 } })
    const envelope = await pending
    expect(envelope.response.timings.totalMs).toBe(12)
    expect(client.inFlight).toBe(0)
  })

  it('ignores a response whose id nobody is waiting for', async () => {
    const { client, worker } = await attached()
    const pending = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARA' })
    await client.ready()

    worker.respond({ id: 9999, type: 'csv', table: 'MARA', content: 'nobody asked' })
    worker.respond({ id: worker.idAt(0), type: 'csv', table: 'MARA', content: 'mine' })

    expect((await pending).response.content).toBe('mine')
  })
})

describe('error propagation', () => {
  it('rejects the matching promise with the message and the worker stack', async () => {
    const { client, worker } = await attached()
    const pending = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARA' })
    await client.ready()

    worker.respond({
      id: worker.idAt(0),
      type: 'error',
      message: 'material not found: M-1',
      stack: 'Error: material not found\n    at mustGet',
    })

    await expect(pending).rejects.toBeInstanceOf(WorkerError)
    await pending.catch((error: unknown) => {
      expect(error).toBeInstanceOf(WorkerError)
      if (error instanceof WorkerError) {
        expect(error.message).toBe('material not found: M-1')
        expect(error.workerStack).toContain('mustGet')
      }
    })
    expect(client.inFlight).toBe(0)
  })

  it('fails everything in flight when the worker itself dies', async () => {
    const { client, worker } = await attached()
    const one = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARA' })
    const two = client.request({ type: 'relief', scenario: scenario(), filters: filters(), workCenterId: 'WC-1' })
    await client.ready()

    worker.crash('out of memory')

    await expect(one).rejects.toThrow(/out of memory/)
    await expect(two).rejects.toThrow(/out of memory/)
  })

  it('treats an error with no matching request as fatal for everything in flight', async () => {
    const { client, worker } = await attached()
    const pending = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARA' })
    await client.ready()

    worker.respond({ id: 0, type: 'error', message: 'worker received a malformed message' })

    await expect(pending).rejects.toThrow(/malformed message/)
  })
})

describe('timeout', () => {
  it('rejects with a timeout error naming the request', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const client = new EngineClient({ createWorker: () => worker, timeoutMs: 30_000 })
    const pending = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARA' })
    await client.ready()

    vi.advanceTimersByTime(29_999)
    expect(client.inFlight).toBe(1)
    vi.advanceTimersByTime(2)

    await expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError)
    await expect(pending).rejects.toThrow(/30000ms/)
    expect(client.inFlight).toBe(0)
  })

  it('does not resolve a request that already timed out when the answer finally lands', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const client = new EngineClient({ createWorker: () => worker, timeoutMs: 1_000 })
    const pending = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARA' })
    await client.ready()
    const id = worker.idAt(0)

    vi.advanceTimersByTime(1_001)
    await expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError)

    // The late answer must not be mistaken for an unattributable worker error.
    expect(() => {
      worker.respond({ id, type: 'csv', table: 'MARA', content: 'late' })
    }).not.toThrow()
  })
})

describe('supersession', () => {
  it('marks an overtaken answer stale rather than losing it', async () => {
    const { client, worker } = await attached()

    const older = client.request({ type: 'relief', scenario: scenario(), filters: filters(), workCenterId: 'WC-1' })
    const newer = client.request({ type: 'relief', scenario: scenario(), filters: filters(), workCenterId: 'WC-2' })
    await client.ready()

    // The newer one answers first; the older one straggles in behind it.
    worker.respond({ id: worker.idAt(1), type: 'relief', workCenterId: 'WC-2', candidates: [] })
    worker.respond({ id: worker.idAt(0), type: 'relief', workCenterId: 'WC-1', candidates: [] })

    const newerEnvelope = await newer
    const olderEnvelope = await older
    expect(newerEnvelope.stale).toBe(false)
    expect(newerEnvelope.response.workCenterId).toBe('WC-2')
    expect(olderEnvelope.stale).toBe(true)
    expect(olderEnvelope.response.workCenterId).toBe('WC-1')
  })

  it('rejects a superseded requestLatest with the sentinel, and only that one', async () => {
    const { client, worker } = await attached()

    const older = client.requestLatest({
      type: 'relief',
      scenario: scenario(),
      filters: filters(),
      workCenterId: 'WC-1',
    })
    const rejection = older.catch((error: unknown) => error)

    const newer = client.requestLatest({
      type: 'relief',
      scenario: scenario(),
      filters: filters(),
      workCenterId: 'WC-2',
    })
    await client.ready()

    const error = await rejection
    expect(error).toBeInstanceOf(SupersededError)
    expect(isSuperseded(error)).toBe(true)
    expect(isSuperseded(new WorkerError('boom'))).toBe(false)

    // Superseded before it ever reached the wire, so it was never posted: the
    // model is not asked for an answer nobody is waiting for.
    expect(worker.sent).toHaveLength(1)
    expect(at(worker.sent, 0, 'posted request')).toMatchObject({ workCenterId: 'WC-2' })

    // A late answer to the superseded id changes nothing either.
    worker.respond({ id: 1, type: 'relief', workCenterId: 'WC-1', candidates: [] })
    worker.respond({ id: worker.idAt(0), type: 'relief', workCenterId: 'WC-2', candidates: [] })

    const envelope = await newer
    expect(envelope.response.workCenterId).toBe('WC-2')
    expect(envelope.stale).toBe(false)
  })

  it('supersedes per request TYPE, never across types', async () => {
    const { client, worker } = await attached()

    const slice = client.requestLatest({
      type: 'materialSlice',
      scenario: scenario(),
      filters: filters(),
      offset: 0,
      limit: 50,
      sortBy: 'hours',
    })
    const relief = client.requestLatest({
      type: 'relief',
      scenario: scenario(),
      filters: filters(),
      workCenterId: 'WC-1',
    })
    await client.ready()

    worker.respond({ id: worker.idAt(0), type: 'materialSlice', rows: [], total: 0 })
    worker.respond({ id: worker.idAt(1), type: 'relief', workCenterId: 'WC-1', candidates: [] })

    expect((await slice).stale).toBe(false)
    expect((await relief).stale).toBe(false)
  })
})

describe('init idempotency', () => {
  it('shares one init promise and posts exactly one init request', async () => {
    const { client, worker } = await attached()
    const source = { kind: 'factory', profile: 'demo', seed: 7 } as const

    const first = client.init(source)
    const second = client.init(source)
    await client.ready()

    expect(worker.sent).toHaveLength(1)
    expect(at(worker.sent, 0, 'init request').type).toBe('init')

    worker.respond({
      id: worker.idAt(0),
      type: 'ready',
      catalog: catalog(),
      timings: { generateMs: 5 },
    })

    const a = await first
    const b = await second
    expect(a.catalog).toBe(b.catalog)
    expect(a.timings.generateMs).toBe(5)
    expect(a.usingFallback).toBe(false)

    // A third caller after the fact still does not re-initialise.
    await expect(client.init(source)).resolves.toBe(a)
    expect(worker.sent).toHaveLength(1)
  })

  it('lets init be retried after a failure', async () => {
    const { client, worker } = await attached()
    const source = { kind: 'factory', profile: 'demo', seed: 7 } as const

    const failing = client.init(source)
    await client.ready()
    worker.respond({ id: worker.idAt(0), type: 'error', message: 'seed out of range' })
    await expect(failing).rejects.toThrow(/seed out of range/)

    const retry = client.init(source)
    await client.ready()
    expect(worker.sent).toHaveLength(2)
    worker.respond({ id: worker.idAt(1), type: 'ready', catalog: catalog(), timings: {} })
    await expect(retry).resolves.toMatchObject({ usingFallback: false })
  })
})

describe('lifecycle', () => {
  it('terminates the worker and rejects everything outstanding', async () => {
    const { client, worker } = await attached()
    const pending = client.request({ type: 'exportCsv', scenario: scenario(), table: 'MARA' })
    await client.ready()

    client.terminate()

    await expect(pending).rejects.toBeInstanceOf(WorkerError)
    expect(worker.terminated).toBe(true)
  })
})
