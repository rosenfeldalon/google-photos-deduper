export const TRASH_BATCH_SIZE = 250
export const TRASH_WATCHDOG_MS = 90_000
const DEFAULT_CONFIG = {
  timeoutMs: 60_000,
  paceMs: 250,
  retries: 3,
  backoffMs: 1_000,
  jitter: Math.random,
}

type TrashOutcome = "running" | "retrying" | "complete" | "partial" | "stopped"

export interface TrashBatchState {
  outcome: TrashOutcome
  acknowledgedKeys: string[]
  remainingKeys: string[]
  failedBatchIndex: number | null
  error?: string
  uncertain: boolean
}

class UncertainBatch extends Error {}
class BatchRejected extends Error {}

async function awaitBatch(
  keys: string[],
  move: (keys: string[]) => Promise<unknown>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new UncertainBatch("Stopped while a Photos batch was in flight."))
    signal.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => reject(new UncertainBatch("A batch timed out waiting for Google Photos.")), timeoutMs)
  })
  try {
    const reply = await Promise.race([move(keys), deadline])
    if (reply === false) throw new BatchRejected("Google Photos rejected a trash batch.")
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

function describe(error: unknown): string {
  if (error instanceof UncertainBatch || error instanceof BatchRejected) return error.message
  const status = error instanceof Error ? /^HTTP \d{3}\b/.exec(error.message)?.[0] : undefined
  return status ?? "Google Photos did not acknowledge the trash batch."
}

export function planTrashResume(originalKeys: readonly string[], acknowledgedKeys: ReadonlySet<string>): string[] {
  return originalKeys.filter(key => !acknowledgedKeys.has(key))
}

export async function runTrashBatches(
  keys: string[],
  move: (keys: string[]) => Promise<unknown>,
  report: (state: TrashBatchState) => void | Promise<void>,
  signal: AbortSignal,
  config = DEFAULT_CONFIG
): Promise<TrashBatchState> {
  let acknowledged = 0
  let failedBatchIndex: number | null = null
  let lastError: string | undefined
  let uncertain = false

  const state = (outcome: TrashOutcome): TrashBatchState => ({
    outcome,
    acknowledgedKeys: keys.slice(0, acknowledged),
    remainingKeys: keys.slice(acknowledged),
    failedBatchIndex,
    ...(lastError ? { error: lastError } : {}),
    uncertain,
  })

  while (acknowledged < keys.length && !signal.aborted) {
    const batch = keys.slice(acknowledged, acknowledged + TRASH_BATCH_SIZE)
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        await awaitBatch(batch, move, config.timeoutMs, signal)
        acknowledged += batch.length
        failedBatchIndex = null
        lastError = undefined
        uncertain = false
        break
      } catch (error) {
        failedBatchIndex = Math.floor(acknowledged / TRASH_BATCH_SIZE)
        lastError = describe(error)
        // Transport errors can arrive after Google received a request.
        uncertain ||= !(error instanceof BatchRejected)
        if (signal.aborted) return state("stopped")
        if (attempt === config.retries) return state("partial")
        await report(state("retrying"))
        const delay = config.backoffMs * 2 ** attempt
        await pause(delay + Math.floor(delay * config.jitter() / 4), signal)
      }
    }

    if (signal.aborted) break
    await report(state("running"))
    if (acknowledged < keys.length) await pause(config.paceMs, signal)
  }
  return state(acknowledged === keys.length ? "complete" : "stopped")
}
