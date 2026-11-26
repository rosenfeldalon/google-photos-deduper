import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { planTrashResume, runTrashBatches, type TrashBatchState } from "../../lib/trash-batches"

const makeKeys = (count: number) => Array.from({ length: count }, (_, index) => "key-" + index)
const config = { timeoutMs: 60_000, paceMs: 250, retries: 3, backoffMs: 100, jitter: () => 0 }

describe("resumable trash batches", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("times out a hung batch, backs off and retries the same keys", async () => {
    const keys = ["key"]
    const attempts = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(true)
    const updates: TrashBatchState[] = []
    const running = runTrashBatches(keys, attempts, state => { updates.push(state) }, new AbortController().signal, config)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toHaveBeenCalledOnce()
    expect(updates[0]).toMatchObject({ outcome: "retrying", acknowledgedKeys: [], remainingKeys: keys, uncertain: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(attempts.mock.calls).toEqual([[keys], [keys]])
    expect(await running).toMatchObject({ outcome: "complete", acknowledgedKeys: keys, remainingKeys: [] })
  })

  it("reports exact acknowledged and remaining keys after a permanent failure", async () => {
    const keys = makeKeys(255)
    const attempts = vi.fn().mockResolvedValueOnce(true).mockRejectedValue(new Error("HTTP 504"))
    const running = runTrashBatches(keys, attempts, vi.fn(), new AbortController().signal, config)
    await vi.runAllTimersAsync()
    expect(attempts).toHaveBeenCalledTimes(5)
    expect(await running).toMatchObject({
      outcome: "partial", failedBatchIndex: 1, error: "HTTP 504",
      acknowledgedKeys: keys.slice(0, 250), remainingKeys: keys.slice(250),
    })
  })

  it("stops pending retries during backoff", async () => {
    const controller = new AbortController()
    const attempts = vi.fn().mockRejectedValue(new Error("HTTP 503"))
    const running = runTrashBatches(["key"], attempts, () => controller.abort(), controller.signal, config)
    await vi.runAllTimersAsync()
    expect(attempts).toHaveBeenCalledOnce()
    expect(await running).toMatchObject({ outcome: "stopped", remainingKeys: ["key"] })
  })

  it("stops between confirmed batches and retains their acknowledged keys", async () => {
    const controller = new AbortController()
    const keys = makeKeys(251)
    const attempts = vi.fn().mockResolvedValue(true)
    const running = runTrashBatches(keys, attempts, () => controller.abort(), controller.signal, config)
    await vi.runAllTimersAsync()
    expect(attempts).toHaveBeenCalledOnce()
    expect(await running).toMatchObject({
      outcome: "stopped", acknowledgedKeys: keys.slice(0, 250), remainingKeys: keys.slice(250),
    })
  })

  it("stops waiting on an in-flight request and records the uncertainty", async () => {
    const controller = new AbortController()
    const attempts = vi.fn(() => new Promise<never>(() => {}))
    const running = runTrashBatches(["key"], attempts, vi.fn(), controller.signal, config)
    controller.abort()
    expect(await running).toMatchObject({
      outcome: "stopped", acknowledgedKeys: [], remainingKeys: ["key"], failedBatchIndex: 0, uncertain: true,
    })
    await vi.runAllTimersAsync()
    expect(attempts).toHaveBeenCalledOnce()
  })

  it("paces an 11-batch 2,600-key run and reports exact progress", async () => {
    const keys = makeKeys(2600)
    const batches: { time: number; keys: string[] }[] = []
    const updates: TrashBatchState[] = []
    const running = runTrashBatches(keys, async keys => {
      batches.push({ time: Date.now(), keys })
      return true
    }, state => { updates.push(state) }, new AbortController().signal, config)
    await vi.runAllTimersAsync()
    expect(batches).toHaveLength(11)
    expect(batches[10].time - batches[0].time).toBe(2500)
    expect(batches[10].keys).toHaveLength(100)
    expect(updates.map(state => state.acknowledgedKeys.length)).toEqual([250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2600])
    expect(await running).toMatchObject({ outcome: "complete", remainingKeys: [] })
  })

  it("derives resume only from the original guarded selection and acknowledged keys", () => {
    expect(planTrashResume(["a", "b", "c"], new Set(["a", "c", "unsafe"]))).toEqual(["b"])
  })
})
