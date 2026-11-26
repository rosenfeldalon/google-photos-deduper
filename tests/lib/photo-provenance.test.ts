import { describe, expect, it } from "vitest"
import { classifyProvenance, inferOwner, defaultProvenanceKeeps, guardTrashSelection } from "../../lib/photo-provenance"
import type { PhotoDetailsEntry } from "../../lib/photo-details"
import type { GpdMediaItem } from "../../lib/types"

function photo(mediaKey: string, data: Partial<GpdMediaItem> = {}): GpdMediaItem {
  return { mediaKey, dedupKey: mediaKey, thumb: "", timestamp: 0, creationTimestamp: 0, isOwned: true, ...data }
}

const mine = { status: "loaded", details: { albums: [], ownerActorId: "self", ownerName: "Sample Owner", savedToYourPhotos: true } } as const
const inSharedAlbum = { ...mine, details: { ...mine.details, albums: [{ title: "Shared", mediaKey: "album", isShared: true }] } } as const
const partner = { ...mine, details: { ...mine.details, source: "partnerShared" } } as const
const shared = { ...mine, details: { ...mine.details, ownerActorId: "other", source: "shared" } } as const
const unavailable = { status: "unavailable", reason: "No detail" } as const

describe("Photos ownership", () => {
  it.each([
    [photo("a"), mine, "self", "mine"],
    [photo("a"), inSharedAlbum, "self", "mine-in-shared-album"],
    [photo("a"), partner, "self", "partner"],
    [photo("a"), shared, "self", "shared"],
    [photo("a"), { ...mine, details: { ...mine.details, savedToYourPhotos: false } }, "self", "partner"],
    [photo("a", { isOwned: false }), mine, "self", "unknown"],
    [photo("a", { isOwned: undefined }), mine, "self", "unknown"],
    [photo("a"), { ...mine, details: { albums: [] } }, "self", "unknown"],
    [photo("a"), undefined, "self", "unknown"],
    [photo("a"), unavailable, "self", "unknown"],
    [photo("a"), mine, undefined, "unknown"],
  ] as const)("classifies evidence case %#", (item, details, actor, expected) => {
    expect(classifyProvenance(item, details, actor)).toBe(expected)
  })

  it.each([[19, 0, false], [20, 1, true], [20, 2, false], [20, 10, false], [25, 0, true]])(
    "infers only with enough owned samples and agreement (%i samples, %i other)",
    (count, other, accepted) => {
      const items = Array.from({ length: count }, (_, i) => photo(String(i)))
      const details = new Map(items.map((item, index) => [item.mediaKey, index < other ? shared : mine]))
      expect(inferOwner(items, details)?.actorId).toBe(accepted ? "self" : undefined)
    }
  )

  it("keeps protected copies as well as a personal copy in mixed groups", () => {
    const items = [photo("mine-a", { resWidth: 300, resHeight: 300 }), photo("mine-b"), photo("partner"), photo("shared-own"), photo("unknown")]
    const entries = new Map<string, PhotoDetailsEntry>([["mine-a", mine], ["mine-b", mine], ["partner", partner], ["shared-own", inSharedAlbum]] as const)
    const kind = (key: string) => classifyProvenance(items.find(item => item.mediaKey === key), entries.get(key), "self")
    expect(defaultProvenanceKeeps(items, kind)).toEqual(new Set(["mine-a", "partner", "shared-own", "unknown"]))
    expect(defaultProvenanceKeeps(items, () => "unknown")).toEqual(new Set(items.map(item => item.mediaKey)))
  })

  it("drops non-owned, unconfirmed shared-album and ambiguous dedup keys", () => {
    const items = [
      photo("ordinary"), photo("manual"), photo("automatic"), photo("partner"), photo("unknown"),
      photo("mixed", { dedupKey: "collision" }), photo("outside", { dedupKey: "collision" }),
      photo("one", { dedupKey: "paired" }), photo("two", { dedupKey: "paired" }),
    ]
    const entries = new Map<string, PhotoDetailsEntry>([
      ["ordinary", mine], ["manual", inSharedAlbum], ["automatic", inSharedAlbum],
      ["partner", partner], ["mixed", mine], ["outside", shared], ["one", mine], ["two", mine],
    ] as const)
    const byKey = Object.fromEntries(items.map(item => [item.mediaKey, item]))
    const result = guardTrashSelection(
      ["ordinary", "manual", "automatic", "partner", "unknown", "mixed", "one"],
      byKey, entries, "self", new Set(["manual", "partner"])
    )
    expect(result).toEqual({
      dedupKeys: ["ordinary", "manual"], mediaKeysToTrash: ["ordinary", "manual"],
      sharedAlbumCount: 1, skipped: { protected: 2, shared: 1, ambiguous: 2 },
    })
  })

  it("sends one dedup key when every matching item was confirmed and selected", () => {
    const rows = { a: photo("a", { dedupKey: "one" }), b: photo("b", { dedupKey: "one" }) }
    expect(guardTrashSelection(["a", "b", "a"], rows, new Map([["a", mine], ["b", mine]]), "self", new Set())).toMatchObject({
      dedupKeys: ["one"], mediaKeysToTrash: ["a", "b"],
    })
    expect(guardTrashSelection(["a", "b"], rows, new Map(), "self", new Set()).dedupKeys).toEqual([])
  })
})
