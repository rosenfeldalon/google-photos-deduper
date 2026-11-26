import { selectDefaultKeep } from "./duplicate-detector"
import type { PhotoDetailsEntry } from "./photo-details"
import type { GpdMediaItem } from "./types"

export const PROVENANCE_LABELS = {
  mine: "Mine",
  "mine-in-shared-album": "Mine, in shared album",
  partner: "Partner",
  shared: "Shared",
  unknown: "Unknown",
} as const

export type Provenance = keyof typeof PROVENANCE_LABELS
export type PhotoDetailsByKey = ReadonlyMap<string, PhotoDetailsEntry>
export const MIN_OWNER_SAMPLES = 20
export const MIN_OWNER_AGREEMENT_PERCENT = 95

export function classifyProvenance(
  item: GpdMediaItem | undefined,
  entry: PhotoDetailsEntry | undefined,
  selfActorId?: string
): Provenance {
  if (!item || entry?.status !== "loaded" || !selfActorId) return "unknown"
  const { details } = entry
  if (details.source === "partnerShared" || details.savedToYourPhotos === false) return "partner"
  if (item.isOwned === true && details.ownerActorId === selfActorId) {
    return details.albums.some(album => album.isShared) ? "mine-in-shared-album" : "mine"
  }
  if (details.source === "shared" || (details.ownerActorId && details.ownerActorId !== selfActorId)) return "shared"
  return "unknown"
}

export function mayManuallyTrash(kind: Provenance): boolean {
  return kind === "mine" || kind === "mine-in-shared-album"
}

export interface OwnerCandidate {
  actorId: string
  name?: string | null
  photoUrl?: string | null
  count: number
  samples: number
}

export function inferOwner(items: GpdMediaItem[], detailsByKey: PhotoDetailsByKey): OwnerCandidate | undefined {
  const owners = new Map<string, OwnerCandidate>()
  const seen = new Set<string>()
  let samples = 0
  for (const item of items) {
    if (item.isOwned !== true || seen.has(item.mediaKey)) continue
    seen.add(item.mediaKey)
    samples++
    const entry = detailsByKey.get(item.mediaKey)
    if (entry?.status !== "loaded") continue
    const { ownerActorId, ownerName, ownerPhotoUrl, source, savedToYourPhotos } = entry.details
    if (!ownerActorId || source === "partnerShared" || savedToYourPhotos === false) continue
    const previous = owners.get(ownerActorId)
    owners.set(ownerActorId, {
      actorId: ownerActorId,
      count: (previous?.count ?? 0) + 1,
      samples: 0,
      name: previous?.name ?? ownerName,
      photoUrl: previous?.photoUrl ?? ownerPhotoUrl,
    })
  }
  if (samples < MIN_OWNER_SAMPLES) return
  for (const candidate of owners.values()) {
    if (candidate.count * 100 >= MIN_OWNER_AGREEMENT_PERCENT * samples) return { ...candidate, samples }
  }
}

export function defaultProvenanceKeeps(items: GpdMediaItem[], classify: (key: string) => Provenance): Set<string> {
  const personal = items.filter(item => classify(item.mediaKey) === "mine")
  const kept = new Set(items.filter(item => classify(item.mediaKey) !== "mine").map(item => item.mediaKey))
  if (personal.length > 0) kept.add(selectDefaultKeep(personal))
  return kept
}

export interface GuardedTrash {
  dedupKeys: string[]
  mediaKeysToTrash: string[]
  sharedAlbumCount: number
  skipped: { protected: number; shared: number; ambiguous: number }
}

// Treat a dedup key as ambiguous whenever it also matches an ineligible or
// unselected item in the entire scan, including items outside duplicate groups.
export function guardTrashSelection(
  requested: Iterable<string>,
  items: Record<string, GpdMediaItem>,
  details: PhotoDetailsByKey,
  selfActorId: string | undefined,
  manuallySelectedShared: ReadonlySet<string>
): GuardedTrash {
  const result: GuardedTrash = {
    dedupKeys: [], mediaKeysToTrash: [], sharedAlbumCount: 0,
    skipped: { protected: 0, shared: 0, ambiguous: 0 },
  }
  const requestedByDedup = new Map<string, string[]>()
  for (const key of new Set(requested)) {
    const item = items[key]
    if (!item?.dedupKey || item.mediaKey !== key) {
      result.skipped.protected++
      continue
    }
    const matches = requestedByDedup.get(item.dedupKey) ?? []
    matches.push(key)
    requestedByDedup.set(item.dedupKey, matches)
  }
  if (!requestedByDedup.size) return result

  const matchesByDedup = new Map<string, GpdMediaItem[]>()
  for (const item of Object.values(items)) {
    if (!requestedByDedup.has(item.dedupKey)) continue
    const matches = matchesByDedup.get(item.dedupKey) ?? []
    matches.push(item)
    matchesByDedup.set(item.dedupKey, matches)
  }

  for (const [dedupKey, selected] of requestedByDedup) {
    const matches = matchesByDedup.get(dedupKey) ?? []
    const kinds = selected.map(key => classifyProvenance(items[key], details.get(key), selfActorId))
    const eligible = kinds.every((kind, index) =>
      kind === "mine" || (kind === "mine-in-shared-album" && manuallySelectedShared.has(selected[index]))
    )
    if (matches.length !== selected.length || (matches.length > 1 && !eligible)) {
      result.skipped.ambiguous += selected.length
      continue
    }
    if (!eligible) {
      if (kinds[0] === "mine-in-shared-album") result.skipped.shared++
      else result.skipped.protected++
      continue
    }
    result.dedupKeys.push(dedupKey)
    result.mediaKeysToTrash.push(...selected)
    result.sharedAlbumCount += kinds.filter(kind => kind === "mine-in-shared-album").length
  }
  return result
}

export function describeSkippedTrash(skipped: GuardedTrash["skipped"]): string {
  return [
    skipped.protected && `${skipped.protected} with unverified ownership`,
    skipped.shared && `${skipped.shared} in shared albums without individual selection`,
    skipped.ambiguous && `${skipped.ambiguous} with ambiguous dedup keys`,
  ].filter(Boolean).join(", ")
}
