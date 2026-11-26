import { describe, expect, it, vi } from "vitest"
import { loadPhotoDetails, projectAlbums, projectPhotoDetails } from "../../lib/photo-details"
import { parsePhotosCommand } from "../../lib/photos-protocol"

describe("album details", () => {
  it("validates the closed command payload", () => {
    expect(parsePhotosCommand("getItemDetails", { mediaKeys: ["a", "c"] })).toEqual({
      command: "getItemDetails", mediaKeys: ["a", "c"],
    })
    expect(parsePhotosCommand("getItemDetails", { mediaKeys: ["a", "a"] })).toBeNull()
    expect(parsePhotosCommand("getItemDetails", { mediaKeys: new Array(1) })).toBeNull()
    expect(parsePhotosCommand("getItemDetails", { mediaKeys: ["a"], another: 1 })).toBeNull()
    expect(parsePhotosCommand("getItemDetails", { mediaKeys: Array.from({ length: 101 }, (_, i) => String(i)) })).toBeNull()
  })

  it("projects only album identity, name and sharing status", () => {
    const album = { mediaKey: "album-a", title: "Holiday", isShared: true, ownerActorId: "private" }
    expect(projectAlbums([album])).toEqual({ albums: [{ mediaKey: "album-a", title: "Holiday", isShared: true }] })
    expect(projectAlbums([])).toEqual({ albums: [] })
    expect(projectAlbums(undefined)).toMatchObject({ unavailable: true })
    expect(projectAlbums([{ mediaKey: "album-b", title: "Missing sharing status" }])).toMatchObject({ unavailable: true })
  })

  it("binds ownership to the requested media key and limits the owner image host", () => {
    const row = {
      mediaKey: "a", albums: [], source: ["mobile", "android"],
      owner: { actorId: "fixture-owner", name: "Fixture", profilePhotoUrl: "https://lh3.googleusercontent.com/a" },
      savedToYourPhotos: true,
    }
    expect(projectPhotoDetails("a", row)).toEqual({
      albums: [], source: "mobile", ownerActorId: "fixture-owner", ownerName: "Fixture",
      ownerPhotoUrl: row.owner.profilePhotoUrl, savedToYourPhotos: true,
    })
    expect(projectPhotoDetails("b", row)).toMatchObject({ unavailable: true })
    expect(projectPhotoDetails("a", { ...row, mediaKey: undefined })).toEqual({ albums: [] })
    expect(projectPhotoDetails("a", {
      ...row, owner: { ...row.owner, profilePhotoUrl: "https://googleusercontent.com.example.test/a" },
    })).toMatchObject({ ownerPhotoUrl: null })
  })

  it("limits concurrency to three and streams partial batches", async () => {
    let active = 0
    let maximum = 0
    const getDetails = vi.fn(async (key: string) => {
      active++
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active--
      return { albums: [{ mediaKey: key, title: key, isShared: false }] }
    })
    const emit = vi.fn()
    await loadPhotoDetails(["a", "b", "c", "d", "e", "f", "g"], getDetails, emit, new AbortController().signal)
    expect(maximum).toBe(3)
    expect(getDetails).toHaveBeenCalledTimes(7)
    expect(emit.mock.calls.map(([rows, done, total]) => [rows.length, done, total])).toEqual([
      [3, 3, 7], [3, 6, 7], [1, 7, 7],
    ])
  })

  it("isolates rejected requests and parser errors, with bounded backoff", async () => {
    vi.useFakeTimers()
    try {
      const getDetails = vi.fn((key: string) => {
        if (key === "parse") throw new TypeError("malformed response")
        if (key === "reject") return Promise.reject(new Error("temporary response failure"))
        return Promise.resolve({ albums: [] })
      })
      const emit = vi.fn()
      const load = loadPhotoDetails(["ok", "parse", "reject"], getDetails, emit, new AbortController().signal)
      await vi.runAllTimersAsync()
      await load
      expect(getDetails.mock.calls.filter(([key]) => key === "reject")).toHaveLength(3)
      expect(emit.mock.calls[0][0]).toEqual([
        { mediaKey: "ok", details: { albums: [] } },
        { mediaKey: "parse", details: expect.objectContaining({ unavailable: true }) },
        { mediaKey: "reject", details: expect.objectContaining({ unavailable: true }) },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not start more requests after cancellation", async () => {
    const controller = new AbortController()
    const getDetails = vi.fn(async () => ({ albums: [] }))
    const emit = vi.fn(() => controller.abort())
    await loadPhotoDetails(["a", "b", "c", "d"], getDetails, emit, controller.signal)
    expect(getDetails).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
