import { afterEach, expect, it, vi } from "vitest"
import { applyTrashBatchState, createTrashOperation, nextTrashRequest, trashAcknowledged, trashWatchdog } from "../../lib/trash-operation"
import type { GpdMediaItem } from "../../lib/types"

const row = (mediaKey: string, dedupKey: string): GpdMediaItem => ({
  mediaKey, dedupKey, thumb: "", timestamp: 0, creationTimestamp: 0,
})

function fixture() {
  return createTrashOperation("fixture@example.test", ["first", "second"], ["a", "b", "c"], {
    mediaItems: { a: row("a", "first"), b: row("b", "first"), c: row("c", "second") }, groups: [], totalItems: 3,
  })
}

afterEach(() => vi.useRealTimers())

it("resumes with only unacknowledged guarded keys and can undo an acknowledged subset", () => {
  const operation = fixture()
  expect(nextTrashRequest(operation, "run-one")?.args).toEqual({ dedupKeys: ["first", "second"], mediaKeysToTrash: ["a", "b", "c"], mediaKeysPerDedup: [2, 1] })
  expect(applyTrashBatchState(operation, {
    outcome: "partial", acknowledgedKeys: ["first"], remainingKeys: ["second"], failedBatchIndex: 1, uncertain: true,
  })).toBe(true)
  expect(trashAcknowledged(operation)).toEqual({ dedupKeys: ["first"], mediaKeys: ["a", "b"] })
  expect(nextTrashRequest(operation, "run-two")).toBeNull()
  operation.active = null
  expect(nextTrashRequest(operation, "run-two")?.args).toEqual({ dedupKeys: ["second"], mediaKeysToTrash: ["c"], mediaKeysPerDedup: [1] })
  expect(trashAcknowledged(operation)).toEqual({ dedupKeys: ["first"], mediaKeys: ["a", "b"] })
})

it("rejects inconsistent or out-of-scope acknowledgements", () => {
  const operation = fixture()
  nextTrashRequest(operation, "run-one")
  const batch = { outcome: "partial", failedBatchIndex: 1, uncertain: false }
  expect(applyTrashBatchState(operation, { ...batch, acknowledgedKeys: ["second"], remainingKeys: ["first"] })).toBe(false)
  expect(applyTrashBatchState(operation, { ...batch, acknowledgedKeys: ["other"], remainingKeys: ["second"] })).toBe(false)
  expect(trashAcknowledged(operation).mediaKeys).toHaveLength(0)
})

it("rearms the watchdog on confirmed movement and cancels it on a terminal reply", () => {
  vi.useFakeTimers()
  const stalled = vi.fn()
  const watchdog = trashWatchdog(stalled)
  watchdog.arm()
  vi.advanceTimersByTime(80_000)
  watchdog.arm()
  vi.advanceTimersByTime(80_000)
  expect(stalled).not.toHaveBeenCalled()
  vi.advanceTimersByTime(10_000)
  expect(stalled).toHaveBeenCalledOnce()
  watchdog.arm()
  watchdog.clear()
  vi.runAllTimers()
  expect(stalled).toHaveBeenCalledOnce()
})
