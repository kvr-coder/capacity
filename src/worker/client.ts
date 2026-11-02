/**
 * The main-thread half of the worker protocol.
 *
 * Three problems this file exists to solve, in order of how much time they
 * cost when they are not solved:
 *
 * 1. **A promise per request.** Every request carries an `id`; every response
 *    echoes it. `request()` resolves the promise registered under that id, and
 *    `progress` responses are routed to the caller's callback without settling
 *    anything. A response for an unknown id is dropped rather than thrown.
 *
 * 2. **Supersession.** Dragging load between work centers fires runs faster
 *    than the model can answer them. The latest id per request TYPE is
 *    remembered; a response that is no longer the latest of its type still
 *    resolves, but is marked `stale` so a hook can drop it. `requestLatest()`
 *    goes further and rejects superseded requests with {@link SupersededError},
 *    which is a sentinel — a superseded request is not a failure and must never
 *    reach an error toast.
 *
 * 3. **No white screen.** If the worker cannot be constructed — an old browser,
 *    a blocked `blob:`/`worker-src` CSP, a corporate proxy that mangles module
 *    workers — the engine is loaded into the main thread behind the *same*
 *    promise API and {@link EngineClient.usingFallback} is set so the UI can
 *    say "running on the main thread; expect it to be less smooth" instead of
 *    showing nothing at all.
 *
 * Nothing here interprets the model. This is transport.
 */

import type { EngineOptions, Filters, ModelResult, Scenario } from '@/domain/types'
import type { CatalogPayload, RateQuote, WorkerRequest, WorkerResponse } from '@/worker/protocol'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RequestType = WorkerRequest['type']

/** The union of requests as callers write them — the client assigns the id. */
type StripId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type OutboundRequest = StripId<WorkerRequest>

interface ResponseByRequest {
  init: Extract<WorkerResponse, { type: 'ready' }>
  run: Extract<WorkerResponse, { type: 'result' }>
  rollup: Extract<WorkerResponse, { type: 'rollup' }>
  workCenterDetail: Extract<WorkerResponse, { type: 'workCenterDetail' }>
  relief: Extract<WorkerResponse, { type: 'relief' }>
  materialSlice: Extract<WorkerResponse, { type: 'materialSlice' }>
  resolveRate: Extract<WorkerResponse, { type: 'resolvedRate' }>
  exportCsv: Extract<WorkerResponse, { type: 'csv' }>
}

/** The terminal response a given request type produces. */
export type ResponseFor<K extends RequestType> = ResponseByRequest[K]

export interface Envelope<R> {
  response: R
  /**
   * True when a newer request of the same type was sent before this answer
   * arrived. The value is correct — it is simply no longer the one on screen.
   */
  stale: boolean
  /** Round trip in milliseconds, including queueing behind an in-flight run. */
  elapsedMs: number
}

export type ProgressHandler = (phase: string, pct: number) => void

export interface RequestOptions {
  onProgress?: ProgressHandler
  timeoutMs?: number
}

/** The minimum a worker must look like. The tests supply one of these. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: WorkerEventLike) => void,
  ): void
  terminate?(): void
}

export interface WorkerEventLike {
  readonly data?: unknown
  readonly message?: string
}

export interface EngineClientOptions {
  /** Per-request timeout. Init gets {@link EngineClientOptions.initTimeoutMs}. */
  timeoutMs?: number
  /** Generating 15,000 SKUs is seconds, not milliseconds. */
  initTimeoutMs?: number
  /** Injected by the tests, and by anything that wants to host the engine itself. */
  createWorker?: () => WorkerLike
  /** Skip the `new Worker` attempt entirely and run on the main thread. */
  forceFallback?: boolean
}

export interface InitResult {
  catalog: CatalogPayload
  timings: Record<string, number>
  /** True when the model is running on the main thread. Surface it. */
  usingFallback: boolean
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A failure the worker reported, carrying the stack from the other thread. */
export class WorkerError extends Error {
  readonly workerStack: string | undefined

  constructor(message: string, workerStack?: string) {
    super(message)
    this.name = 'WorkerError'
    this.workerStack = workerStack
  }
}

export class WorkerTimeoutError extends WorkerError {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerTimeoutError'
  }
}

/**
 * Not an error the user should ever see.
 *
 * A superseded request is one the interaction itself replaced — the planner
 * dragged again before the previous answer came back. Hooks catch this, ignore
 * it, and keep whatever is on screen.
 */
export class SupersededError extends Error {
  readonly superseded = true

  constructor(type: RequestType, id: number) {
    super(`Request ${type}#${id} was superseded by a newer one.`)
    this.name = 'SupersededError'
  }
}

/** The check every hook's `catch` should start with. */
export function isSuperseded(error: unknown): boolean {
  return error instanceof SupersededError
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_INIT_TIMEOUT_MS = 120_000

interface Pending {
  id: number
  type: RequestType
  latestOnly: boolean
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  onProgress: ProgressHandler | undefined
  resolve: (envelope: Envelope<WorkerResponse>) => void
  reject: (error: Error) => void
}

function nowMs(): number {
  return typeof performance === 'object' ? performance.now() : 0
}

function asResponse(value: unknown): WorkerResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate: { id?: unknown; type?: unknown } = value
  if (typeof candidate.id !== 'number' || typeof candidate.type !== 'string') return null
  return value as WorkerResponse
}

export class EngineClient {
  private readonly options: EngineClientOptions
  private worker: WorkerLike | null = null
  private starting: Promise<WorkerLike> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly latestByType = new Map<RequestType, number>()
  /** Ids already settled as superseded; their eventual response is discarded. */
  private readonly abandoned = new Set<number>()
  private initPromise: Promise<InitResult> | null = null
  private fallback = false
  private fallbackReason: string | null = null

  constructor(options: EngineClientOptions = {}) {
    this.options = options
  }

  /** True once the engine is running on the main thread instead of a worker. */
  get usingFallback(): boolean {
    return this.fallback
  }

  /** Why the worker could not be used, for the banner that says so. */
  get fallbackMessage(): string | null {
    return this.fallbackReason
  }

  get inFlight(): number {
    return this.pending.size
  }

  /** Resolves once the worker (or the fallback) is attached and messages flow. */
  async ready(): Promise<void> {
    await this.ensureWorker()
  }

  /**
   * Build or load the dataset. Idempotent: concurrent callers share one promise
   * and one `init` message, and a failed init clears the promise so a retry is
   * possible.
   */
  init(source: Extract<WorkerRequest, { type: 'init' }>['source'], onProgress?: ProgressHandler): Promise<InitResult> {
    const existing = this.initPromise
    if (existing !== null) return existing
    const promise = this.request(
      { type: 'init', source },
      { onProgress, timeoutMs: this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS },
    )
      .then((envelope) => ({
        catalog: envelope.response.catalog,
        timings: envelope.response.timings,
        usingFallback: this.fallback,
      }))
      .catch((error: unknown) => {
        this.initPromise = null
        throw error
      })
    this.initPromise = promise
    return promise
  }

  /**
   * Send a request and resolve when its answer arrives.
   *
   * The answer is delivered even if a newer request of the same type overtook
   * it; `envelope.stale` says so. Use {@link EngineClient.requestLatest} when a
   * stale answer is worthless.
   */
  request<Req extends OutboundRequest>(
    req: Req,
    options: RequestOptions = {},
  ): Promise<Envelope<ResponseFor<Req['type']>>> {
    return this.send(req, options, false) as Promise<Envelope<ResponseFor<Req['type']>>>
  }

  /**
   * Send a request, rejecting it with {@link SupersededError} the moment a
   * newer request of the same type is sent. This is the one drag interactions
   * want: the promise for the answer nobody is waiting for any more settles
   * immediately instead of resolving into a render nobody wants.
   */
  requestLatest<Req extends OutboundRequest>(
    req: Req,
    options: RequestOptions = {},
  ): Promise<Envelope<ResponseFor<Req['type']>>> {
    return this.send(req, options, true) as Promise<Envelope<ResponseFor<Req['type']>>>
  }

  // ---- convenience wrappers ------------------------------------------------

  /** The authoritative run. Superseded runs settle silently. */
  async run(
    scenario: Scenario,
    filters: Filters,
    options?: EngineOptions,
  ): Promise<ModelResult> {
    const envelope = await this.requestLatest({ type: 'run', scenario, filters, options })
    return envelope.response.result
  }

  async rollup(
    scenario: Scenario,
    filters: Filters,
    level: Extract<WorkerRequest, { type: 'rollup' }>['level'],
    parentKey?: string,
  ): Promise<Extract<WorkerResponse, { type: 'rollup' }>> {
    const envelope = await this.requestLatest({
      type: 'rollup',
      scenario,
      filters,
      level,
      parentKey,
    })
    return envelope.response
  }

  async workCenterDetail(
    scenario: Scenario,
    filters: Filters,
    workCenterId: string,
  ): Promise<Extract<WorkerResponse, { type: 'workCenterDetail' }>['detail']> {
    const envelope = await this.requestLatest({
      type: 'workCenterDetail',
      scenario,
      filters,
      workCenterId,
    })
    return envelope.response.detail
  }

  async relief(
    scenario: Scenario,
    filters: Filters,
    workCenterId: string,
    maxCandidates?: number,
  ): Promise<Extract<WorkerResponse, { type: 'relief' }>['candidates']> {
    const envelope = await this.requestLatest({
      type: 'relief',
      scenario,
      filters,
      workCenterId,
      maxCandidates,
    })
    return envelope.response.candidates
  }

  async materialSlice(
    args: Omit<Extract<WorkerRequest, { type: 'materialSlice' }>, 'id' | 'type'>,
  ): Promise<Extract<WorkerResponse, { type: 'materialSlice' }>> {
    const envelope = await this.requestLatest({ type: 'materialSlice', ...args })
    return envelope.response
  }

  /**
   * What one (material, work center, operation) runs at TODAY, nominal and
   * effective. The move editor starts a `rateSet` from this rather than from a
   * constant that belongs to no machine.
   */
  async resolveRate(
    args: Omit<Extract<WorkerRequest, { type: 'resolveRate' }>, 'id' | 'type'>,
  ): Promise<RateQuote> {
    const envelope = await this.requestLatest({ type: 'resolveRate', ...args })
    return envelope.response.quote
  }

  async exportCsv(
    scenario: Scenario,
    table: Extract<WorkerRequest, { type: 'exportCsv' }>['table'],
  ): Promise<string> {
    const envelope = await this.request({ type: 'exportCsv', scenario, table })
    return envelope.response.content
  }

  /** Drop the worker and reject everything outstanding. */
  terminate(reason = 'The engine was terminated.'): void {
    const worker = this.worker
    this.worker = null
    this.starting = null
    this.initPromise = null
    this.failAll(new WorkerError(reason))
    if (worker?.terminate !== undefined) worker.terminate()
  }

  // ---- internals -----------------------------------------------------------

  private send(
    req: OutboundRequest,
    options: RequestOptions,
    latestOnly: boolean,
  ): Promise<Envelope<WorkerResponse>> {
    const id = this.nextId
    this.nextId += 1
    const type: RequestType = req.type

    // Anything of this type that was waiting is now the previous answer.
    const previousId = this.latestByType.get(type)
    this.latestByType.set(type, id)
    if (previousId !== undefined) this.supersede(previousId)

    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const startedAt = nowMs()

    const promise = new Promise<Envelope<WorkerResponse>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.abandon(id)
        reject(
          new WorkerTimeoutError(
            `The engine did not answer ${type}#${id} within ${Math.round(timeoutMs)}ms. ` +
              'It may still be running; the request was abandoned.',
          ),
        )
      }, timeoutMs)
      this.pending.set(id, {
        id,
        type,
        latestOnly,
        startedAt,
        timer,
        onProgress: options.onProgress,
        resolve,
        reject,
      })
    })

    const message = { ...req, id } as unknown as WorkerRequest
    // The posts are chained off one shared start promise, so `.then` callbacks
    // run in the order the requests were made — a later request can never
    // overtake an earlier one on the wire.
    void this.ensureWorker().then(
      (worker) => {
        // Superseded or timed out before the worker was even ready.
        if (!this.pending.has(id)) return
        try {
          worker.postMessage(message)
        } catch (error) {
          this.settleError(id, error)
        }
      },
      (error: unknown) => {
        this.settleError(id, error)
      },
    )

    return promise
  }

  /**
   * Remember that an id was settled without its response, so the answer — if it
   * ever arrives — is discarded rather than mistaken for an unattributable
   * worker failure. Bounded, because a timed-out request may never answer.
   */
  private abandon(id: number): void {
    this.abandoned.add(id)
    while (this.abandoned.size > 256) {
      const oldest = this.abandoned.values().next()
      if (oldest.done === true) break
      this.abandoned.delete(oldest.value)
    }
  }

  /** Settle a latest-only request that a newer one of its type replaced. */
  private supersede(id: number): void {
    const entry = this.pending.get(id)
    if (entry === undefined || !entry.latestOnly) return
    this.pending.delete(id)
    this.abandon(id)
    clearTimeout(entry.timer)
    entry.reject(new SupersededError(entry.type, entry.id))
  }

  private settleError(id: number, error: unknown): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.reject(
      error instanceof Error ? error : new WorkerError(String(error)),
    )
  }

  private failAll(error: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  private handleMessage(data: unknown): void {
    const response = asResponse(data)
    if (response === null) return

    if (response.type === 'progress') {
      this.pending.get(response.id)?.onProgress?.(response.phase, response.pct)
      return
    }

    if (this.abandoned.has(response.id)) {
      this.abandoned.delete(response.id)
      return
    }

    const entry = this.pending.get(response.id)
    if (entry === undefined) {
      // An error with no request to blame is a worker-level failure: the
      // bootstrap could not decode a message, or a post itself threw. Nothing
      // in flight can be trusted after that.
      if (response.type === 'error') {
        this.failAll(new WorkerError(response.message, response.stack))
      }
      return
    }

    this.pending.delete(entry.id)
    clearTimeout(entry.timer)

    if (response.type === 'error') {
      entry.reject(new WorkerError(response.message, response.stack))
      return
    }

    const stale = this.latestByType.get(entry.type) !== entry.id
    if (stale && entry.latestOnly) {
      entry.reject(new SupersededError(entry.type, entry.id))
      return
    }
    entry.resolve({ response, stale, elapsedMs: nowMs() - entry.startedAt })
  }

  private ensureWorker(): Promise<WorkerLike> {
    const attached = this.worker
    if (attached !== null) return Promise.resolve(attached)
    const starting = this.starting
    if (starting !== null) return starting

    const promise = this.spawn().then((worker) => {
      worker.addEventListener('message', (event: WorkerEventLike) => {
        this.handleMessage(event.data)
      })
      worker.addEventListener('error', (event: WorkerEventLike) => {
        this.failAll(
          new WorkerError(
            typeof event.message === 'string' && event.message !== ''
              ? `The engine worker failed: ${event.message}`
              : 'The engine worker failed.',
          ),
        )
      })
      worker.addEventListener('messageerror', () => {
        this.failAll(new WorkerError('The engine sent a message that could not be decoded.'))
      })
      this.worker = worker
      return worker
    })
    this.starting = promise
    return promise
  }

  private async spawn(): Promise<WorkerLike> {
    const injected = this.options.createWorker
    if (injected !== undefined) return injected()

    if (this.options.forceFallback !== true) {
      try {
        return spawnModuleWorker()
      } catch (error) {
        this.fallback = true
        this.fallbackReason =
          `This browser would not start the model in a background thread (${messageOf(error)}). ` +
          'It is running on the main thread instead, so the interface may stutter while the model runs.'
      }
    } else {
      this.fallback = true
      this.fallbackReason = 'The model is running on the main thread by request.'
    }
    return createMainThreadWorker()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Worker construction
// ---------------------------------------------------------------------------

/**
 * The `new URL(..., import.meta.url)` form is what lets Vite find, bundle and
 * fingerprint the worker. It must stay literal — a variable in the first
 * argument silently produces a request for a file that was never emitted.
 */
function spawnModuleWorker(): WorkerLike {
  if (typeof Worker === 'undefined') throw new Error('Web Workers are not available')
  const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
  return {
    postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
      if (transfer !== undefined && transfer.length > 0) worker.postMessage(message, transfer)
      else worker.postMessage(message)
    },
    addEventListener(type, listener): void {
      worker.addEventListener(type, (event: Event) => {
        listener(toEventLike(event))
      })
    },
    terminate(): void {
      worker.terminate()
    },
  }
}

function toEventLike(event: Event): WorkerEventLike {
  // `MessageEvent` carries `data`, `ErrorEvent` carries `message`; the base
  // `Event` type promises neither, so the read is widened rather than asserted.
  const candidate = event as unknown as { data?: unknown; message?: unknown }
  return {
    data: candidate.data,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
  }
}

/**
 * The engine, hosted on the main thread, wearing a worker's clothes.
 *
 * The module is loaded dynamically so that the code only reaches a browser that
 * actually needs it — in the normal case this chunk is never fetched. Each
 * request is dispatched through a macrotask so the browser gets at least one
 * chance to paint the "working…" state before the model blocks the thread.
 */
function createMainThreadWorker(): WorkerLike {
  type Listener = (event: WorkerEventLike) => void
  const listeners = new Map<string, Listener[]>()
  const queue: WorkerRequest[] = []
  let session: { handle(request: WorkerRequest, emit: (r: WorkerResponse) => void): void } | null =
    null

  const fire = (type: string, event: WorkerEventLike): void => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  const emit = (response: WorkerResponse): void => {
    fire('message', { data: response })
  }
  const dispatch = (request: WorkerRequest): void => {
    setTimeout(() => {
      const active = session
      if (active === null) return
      active.handle(request, emit)
    }, 0)
  }

  const loading = import('./engine.worker')
    .then((module) => {
      session = module.createEngineSession()
      for (const request of queue) dispatch(request)
      queue.length = 0
    })
    .catch((error: unknown) => {
      fire('error', { message: `The engine could not be loaded: ${messageOf(error)}` })
    })
  void loading

  return {
    postMessage(message: WorkerRequest): void {
      if (session === null) queue.push(message)
      else dispatch(message)
    },
    addEventListener(type, listener): void {
      const bucket = listeners.get(type)
      if (bucket === undefined) listeners.set(type, [listener])
      else bucket.push(listener)
    },
    terminate(): void {
      queue.length = 0
      listeners.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// The session-wide client
// ---------------------------------------------------------------------------

let singleton: EngineClient | null = null

/** The one client the app talks to. Created on first use. */
export function getEngineClient(): EngineClient {
  const existing = singleton
  if (existing !== null) return existing
  const created = new EngineClient()
  singleton = created
  return created
}

/**
 * Initialise the shared client. Idempotent — every caller during startup gets
 * the same promise and the worker builds the dataset exactly once.
 */
export function initWorker(
  source: Extract<WorkerRequest, { type: 'init' }>['source'],
  onProgress?: ProgressHandler,
): Promise<InitResult> {
  return getEngineClient().init(source, onProgress)
}

/** Tear the shared client down. Tests and hot-reload use this; the app does not. */
export function resetEngineClient(): void {
  singleton?.terminate('The engine client was reset.')
  singleton = null
}
