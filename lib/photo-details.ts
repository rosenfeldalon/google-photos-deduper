export interface PhotoAlbum {
  mediaKey: string
  title: string
  isShared: boolean
}

export type PhotoDetails =
  | { albums: readonly PhotoAlbum[] }
  | { unavailable: true; reason: string }

export interface PhotoDetailsRow {
  mediaKey: string
  details: PhotoDetails
}

export type PhotoDetailsEntry =
  | { status: "loading" }
  | { status: "loaded"; details: Extract<PhotoDetails, { albums: readonly PhotoAlbum[] }> }
  | { status: "unavailable"; reason: string }

export const PHOTO_DETAILS_BATCH_SIZE = 3
const ATTEMPTS = 3

export function projectAlbums(albums: unknown): PhotoDetails {
  if (!Array.isArray(albums) || albums.length > 200) {
    return { unavailable: true, reason: "Photos did not provide a complete album list." }
  }

  const projected: PhotoAlbum[] = []
  const seen = new Set<string>()
  for (const album of albums) {
    if (!album || typeof album !== "object" ||
        typeof album.mediaKey !== "string" || !album.mediaKey || album.mediaKey.length > 1024 ||
        typeof album.title !== "string" || !album.title.trim() || album.title.length > 500 ||
        typeof album.isShared !== "boolean" || seen.has(album.mediaKey)) {
      return { unavailable: true, reason: "Photos returned incomplete album information." }
    }
    seen.add(album.mediaKey)
    projected.push({ mediaKey: album.mediaKey, title: album.title, isShared: album.isShared })
  }
  return { albums: projected }
}

async function fetchPhotoDetails(
  key: string,
  getDetails: (mediaKey: string) => Promise<{ albums?: unknown }>,
  signal: AbortSignal
): Promise<PhotoDetailsRow> {
  for (let attempt = 0; attempt < ATTEMPTS && !signal.aborted; attempt++) {
    try {
      const item = await getDetails(key)
      return { mediaKey: key, details: projectAlbums(item?.albums) }
    } catch (error) {
      // The pinned parser throws a TypeError when required fields are absent.
      if (error instanceof TypeError || attempt + 1 === ATTEMPTS || signal.aborted) break
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
  return { mediaKey: key, details: { unavailable: true, reason: "Photos could not load album information for this item." } }
}

export async function loadPhotoDetails(
  keys: string[],
  getDetails: (mediaKey: string) => Promise<{ albums?: unknown }>,
  emit: (rows: PhotoDetailsRow[], done: number, total: number, index: number) => void | Promise<void>,
  signal: AbortSignal
): Promise<void> {
  for (let offset = 0; offset < keys.length && !signal.aborted; offset += PHOTO_DETAILS_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + PHOTO_DETAILS_BATCH_SIZE)
    const rows = await Promise.all(batch.map(key => fetchPhotoDetails(key, getDetails, signal)))
    if (signal.aborted) return
    await emit(rows, offset + rows.length, keys.length, offset / PHOTO_DETAILS_BATCH_SIZE)
  }
}
