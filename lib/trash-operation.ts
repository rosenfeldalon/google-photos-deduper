import { planTrashResume, TRASH_WATCHDOG_MS, type TrashBatchState } from "./trash-batches"
import { APP_ID, type DuplicateGroup, type GpdMediaItem, type GptkCommandMessage } from "./types"

interface ScanSnapshot {
  mediaItems: Record<string, GpdMediaItem>
  groups: DuplicateGroup[]
  totalItems: number
}

export interface TrashOperation {
  account: string
  guardedKeys: string[]
  photosByKey: ReadonlyMap<string, string[]>
  snapshot: ScanSnapshot
  acknowledged: Set<string>
  active: { id: string; keys: string[]; acknowledgedCount: number } | null
  uncertain: boolean
  stopRequested: boolean
}

export function createTrashOperation(
  account: string,
  dedupKeys: string[],
  mediaKeys: string[],
  snapshot: ScanSnapshot
): TrashOperation {
  const photosByKey = new Map<string, string[]>()
  for (const mediaKey of mediaKeys) {
    const key = snapshot.mediaItems[mediaKey].dedupKey
    const photos = photosByKey.get(key) ?? []
    photos.push(mediaKey)
    photosByKey.set(key, photos)
  }
  return {
    account, guardedKeys: dedupKeys, photosByKey, snapshot,
    acknowledged: new Set(), active: null, uncertain: false, stopRequested: false,
  }
}

export function nextTrashRequest(operation: TrashOperation, id: string): GptkCommandMessage | null {
  if (operation.active) return null
  const dedupKeys = planTrashResume(operation.guardedKeys, operation.acknowledged)
  if (!dedupKeys.length) return null
  operation.active = { id, keys: dedupKeys, acknowledgedCount: 0 }
  const mediaGroups = dedupKeys.map(key => operation.photosByKey.get(key) ?? [])
  return {
    app: APP_ID, action: "gptkCommand", command: "trashItems", requestId: id, accountEmail: operation.account,
    args: {
      dedupKeys,
      mediaKeysToTrash: mediaGroups.flat(),
      mediaKeysPerDedup: mediaGroups.map(group => group.length),
    },
  }
}

function validateBatch(value: unknown, active: NonNullable<TrashOperation["active"]>): value is TrashBatchState {
  if (!value || typeof value !== "object") return false
  const batch = value as Partial<TrashBatchState>
  const { acknowledgedKeys: moved, remainingKeys: remaining } = batch
  if (!Array.isArray(moved) || !Array.isArray(remaining) ||
      active.keys.length !== moved.length + remaining.length ||
      moved.length < active.acknowledgedCount ||
      typeof batch.uncertain !== "boolean" ||
      !["running", "retrying", "complete", "partial", "stopped"].includes(batch.outcome ?? "") ||
      (batch.failedBatchIndex !== null && (
        typeof batch.failedBatchIndex !== "number" || !Number.isSafeInteger(batch.failedBatchIndex) || batch.failedBatchIndex < 0
      )) ||
      (batch.error !== undefined && typeof batch.error !== "string")) return false
  return active.keys.every((key, index) => index < moved.length
    ? key === moved[index]
    : key === remaining[index - moved.length])
}

export function applyTrashBatchState(operation: TrashOperation, batch: unknown): batch is TrashBatchState {
  if (!operation.active || !validateBatch(batch, operation.active)) return false
  for (const key of batch.acknowledgedKeys) operation.acknowledged.add(key)
  operation.active.acknowledgedCount = batch.acknowledgedKeys.length
  operation.uncertain = batch.uncertain
  return true
}

export function trashAcknowledged(operation: TrashOperation) {
  const dedupKeys = operation.guardedKeys.filter(key => operation.acknowledged.has(key))
  return { dedupKeys, mediaKeys: dedupKeys.flatMap(key => operation.photosByKey.get(key) ?? []) }
}

export function trashWatchdog(onStall: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => clearTimeout(timer)
  return {
    clear,
    arm() {
      clear()
      timer = setTimeout(onStall, TRASH_WATCHDOG_MS)
    },
  }
}
