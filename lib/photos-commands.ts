import type Api from "../Google-Photos-Toolkit/src/api/api"
import { loadPhotoDetails, PHOTO_DETAILS_BATCH_SIZE } from "./photo-details"
import { MAX_RESULT_BYTES, PHOTOS_ORIGIN, serializedSize } from "./photos-protocol"
import type { PhotosCommand, PhotosReply } from "./photos-protocol"
import { APP_ID, type GpdMediaItem } from "./types"

export type PhotosApi = Pick<Api, "getItemsByTakenDate" | "getItemInfoExt" | "moveItemsToTrash" | "restoreFromTrash">
type Emit = (reply: PhotosReply) => void | Promise<void>

const BATCH_SIZE = 250
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
    const isTrash = command === "trashItems"
    for (let offset = 0; offset < dedupKeys.length; offset += BATCH_SIZE) {
      const batch = dedupKeys.slice(offset, offset + BATCH_SIZE)
      if (isTrash) await api.moveItemsToTrash(batch)
      else await api.restoreFromTrash(batch)
      const itemsProcessed = offset + batch.length
      await emit({
        ...reply, action: "gptkProgress", itemsProcessed,
        message: isTrash
          ? `Moved ${itemsProcessed} of ${dedupKeys.length} items to trash`
          : `Restored ${itemsProcessed} of ${dedupKeys.length} items`,
      })
    }
    await emit({
      ...reply, action: "gptkResult", success: true,
      data: isTrash
        ? { trashedCount: dedupKeys.length, trashedKeys: request.mediaKeysToTrash }
        : { restoredCount: dedupKeys.length },
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
