export interface PhotoAlbum {
  mediaKey: string
  title: string
  isShared: boolean
}

export interface LoadedPhotoDetails {
  albums: readonly PhotoAlbum[]
  source?: string | null
  ownerActorId?: string | null
  ownerName?: string | null
  ownerPhotoUrl?: string | null
  savedToYourPhotos?: boolean | null
}

interface PhotoItemInfo {
  mediaKey?: string
  albums?: unknown
  source?: readonly (string | null)[]
  owner?: { actorId?: string; name?: string; profilePhotoUrl?: string } | null
  savedToYourPhotos?: boolean
}

export type PhotoDetails =
  | LoadedPhotoDetails
  | { unavailable: true; reason: string }

export interface PhotoDetailsRow {
  mediaKey: string
  details: PhotoDetails
}

export type PhotoDetailsEntry =
  | { status: "loading" }
  | { status: "loaded"; details: LoadedPhotoDetails }
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

function boundedText(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length <= limit && value.trim() ? value : null
}

function ownerImage(value: unknown): string | null {
  const candidate = boundedText(value, 2048)
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null
    if (!/(^|\.)(googleusercontent\.com|usercontent\.google\.com)$/.test(url.hostname)) return null
    return url.href
  } catch {
    return null
  }
}

export function projectPhotoDetails(mediaKey: string, item?: PhotoItemInfo): PhotoDetails {
  if (item?.mediaKey !== undefined && item.mediaKey !== mediaKey) {
    return { unavailable: true, reason: "Photos returned information for a different item." }
  }
  const projected = projectAlbums(item?.albums)
  if ("unavailable" in projected || item?.mediaKey !== mediaKey) return projected

  return {
    ...projected,
    source: boundedText(item.source?.[0], 32),
    ownerActorId: boundedText(item.owner?.actorId, 256),
    ownerName: boundedText(item.owner?.name, 256),
    ownerPhotoUrl: ownerImage(item.owner?.profilePhotoUrl),
    savedToYourPhotos: typeof item.savedToYourPhotos === "boolean" ? item.savedToYourPhotos : null,
  }
}

async function fetchPhotoDetails(
  key: string,
  getDetails: (mediaKey: string) => Promise<PhotoItemInfo>,
  signal: AbortSignal
): Promise<PhotoDetailsRow> {
  for (let attempt = 0; attempt < ATTEMPTS && !signal.aborted; attempt++) {
    try {
      const item = await getDetails(key)
      return { mediaKey: key, details: projectPhotoDetails(key, item) }
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
  getDetails: (mediaKey: string) => Promise<PhotoItemInfo>,
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
