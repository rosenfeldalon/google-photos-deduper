import type { ItemInfoExt, LibraryTimelinePage } from "../Google-Photos-Toolkit/src/types"
import { loadPhotoDetails, PHOTO_DETAILS_BATCH_SIZE } from "./photo-details"
import { MAX_RESULT_BYTES, PHOTOS_ORIGIN, serializedSize } from "./photos-protocol"
import type { PhotosCommand, PhotosReply } from "./photos-protocol"
import { runTrashBatches, TRASH_BATCH_SIZE } from "./trash-batches"
import { APP_ID, type GpdMediaItem } from "./types"

export interface PhotosApi {
  getItemsByTakenDate(timestamp: number | null, source: string | null, pageId: string | null): Promise<LibraryTimelinePage>
  getItemInfoExt(mediaKey: string): Promise<ItemInfoExt>
  moveItemsToTrash(dedupKeys: string[]): Promise<unknown>
  restoreFromTrash(dedupKeys: string[]): Promise<unknown>
}

type Emit = (reply: PhotosReply) => void | Promise<void>

const RESULT_CHUNK_SIZE = 10_000
const PAGE_TIMEOUT_MS = 60_000

class PhotosCommandError extends Error {}

async function withPageTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PhotosCommandError(
          "Fetching a page from Google Photos timed out. Please re-scan."
        )), PAGE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function splitMedia(items: GpdMediaItem[]): GpdMediaItem[][] {
  const chunks: GpdMediaItem[][] = [[]]
  let chunk = chunks[0]
  let bytes = 1024 // Reserve space for the message envelope and array punctuation.
  for (const item of items) {
    const size = serializedSize(item) + 1
    if (size + 1024 > MAX_RESULT_BYTES) throw new PhotosCommandError("A Photos result exceeds the bridge size limit.")
    if (chunk.length === RESULT_CHUNK_SIZE || bytes + size > MAX_RESULT_BYTES) {
      chunk = []
      chunks.push(chunk)
      bytes = 1024
    }
    chunk.push(item)
    bytes += size
  }
  return chunks
}

async function scanLibrary(api: PhotosApi, accountPath: string, requestId: string, emit: Emit): Promise<void> {
  const command = "getAllMediaItems"
  const items: GpdMediaItem[] = []
  const pageIds = new Set<string>()
  let nextPageId: string | null = null

  // The taken-date timeline works where Google's upload-date listing fails.
  do {
    const page = await withPageTimeout(api.getItemsByTakenDate(null, null, nextPageId))
    if (!page) throw new PhotosCommandError("Google Photos returned an empty page. Please re-scan.")
    for (const item of page.items ?? []) {
      items.push({
        mediaKey: item.mediaKey,
        dedupKey: item.dedupKey,
        thumb: item.thumb ?? "",
        timestamp: item.timestamp,
        creationTimestamp: item.creationTimestamp,
        resWidth: item.resWidth,
        resHeight: item.resHeight,
        duration: item.duration,
        isOwned: item.isOwned,
        isOriginalQuality: item.isOriginalQuality ?? null,
        isFavorite: item.isFavorite === true,
        fileName: item.descriptionShort || null,
        productUrl: PHOTOS_ORIGIN + accountPath + "photo/" + encodeURIComponent(item.mediaKey),
      })
    }
    nextPageId = page.nextPageId || null
    if (nextPageId) {
      if (pageIds.has(nextPageId)) throw new PhotosCommandError("Google Photos repeated a page. Please re-scan.")
      pageIds.add(nextPageId)
    }
    const oldest = items.at(-1)?.timestamp
    await emit({
      app: APP_ID, action: "gptkProgress", command, requestId,
      itemsProcessed: items.length, message: `Fetched ${items.length} items`,
      ...(oldest !== undefined && Number.isFinite(oldest) && oldest > 0 ? { oldestTakenAt: oldest } : {}),
    })
  } while (nextPageId)

  const chunks = splitMedia(items)
  for (const [chunkIndex, data] of chunks.entries()) {
    await emit({
      app: APP_ID, action: "gptkResultChunk", command, requestId,
      chunkIndex, totalChunks: chunks.length, data,
    })
  }
}

export async function executePhotosCommand(
  request: PhotosCommand,
  requestId: string,
  accountPath: string,
  api: PhotosApi,
  emit: Emit,
  signal = new AbortController().signal,
): Promise<void> {
  const { command } = request
  const reply = { app: APP_ID, command, requestId }
  try {
    if (command === "getAllMediaItems") {
      await scanLibrary(api, accountPath, requestId, emit)
      return
    }
    if (command === "getItemDetails") {
      const totalChunks = Math.ceil(request.mediaKeys.length / PHOTO_DETAILS_BATCH_SIZE)
      await loadPhotoDetails(request.mediaKeys, key => api.getItemInfoExt(key), async (rows, done, total, index) => {
        await emit({ ...reply, action: "gptkProgress", itemsProcessed: done, totalItems: total })
        await emit({
          ...reply, action: "gptkResultChunk", chunkIndex: index, totalChunks, data: rows,
        })
      }, signal)
      return
    }
    if (command === "healthCheck") return

    const { dedupKeys } = request
    if (command === "trashItems") {
      const { mediaKeysPerDedup, mediaKeysToTrash } = request
      function mediaAcknowledged(count: number): string[] {
        if (count === dedupKeys.length) return mediaKeysToTrash
        if (mediaKeysPerDedup) {
          const total = mediaKeysPerDedup.slice(0, count).reduce((sum, size) => sum + size, 0)
          return mediaKeysToTrash.slice(0, total)
        }
        return mediaKeysToTrash.length === dedupKeys.length ? mediaKeysToTrash.slice(0, count) : []
      }
      const batch = await runTrashBatches(dedupKeys, keys => api.moveItemsToTrash(keys), state => emit({
        ...reply, action: "gptkProgress", itemsProcessed: state.acknowledgedKeys.length,
        trashState: { ...state, trashedKeys: mediaAcknowledged(state.acknowledgedKeys.length) },
      }), signal)
      await emit({
        ...reply, action: "gptkResult", success: batch.outcome === "complete", error: batch.error,
        data: {
          ...batch,
          trashedCount: batch.acknowledgedKeys.length,
          trashedKeys: mediaAcknowledged(batch.acknowledgedKeys.length),
        },
      })
      return
    }
    for (let offset = 0; offset < dedupKeys.length; offset += TRASH_BATCH_SIZE) {
      const batch = dedupKeys.slice(offset, offset + TRASH_BATCH_SIZE)
      await api.restoreFromTrash(batch)
      const itemsProcessed = offset + batch.length
      await emit({
        ...reply, action: "gptkProgress", itemsProcessed,
        message: `Restored ${itemsProcessed} of ${dedupKeys.length} items`,
      })
    }
    await emit({
      ...reply, action: "gptkResult", success: true, data: { restoredCount: dedupKeys.length },
    })
  } catch (failure) {
    if (signal.aborted) return
    const httpStatus = failure instanceof Error ? /^HTTP \d{3}\b/.exec(failure.message)?.[0] : undefined
    const error = failure instanceof PhotosCommandError
      ? failure.message
      : httpStatus ?? "The Photos request did not complete. Check the connection and try again."
    await emit({ ...reply, action: "gptkResult", success: false, error })
  }
}
