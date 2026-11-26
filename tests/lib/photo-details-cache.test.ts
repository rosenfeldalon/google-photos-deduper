import { describe, expect, it } from "vitest"
import { createDetailsCache, reduceDetailsCache } from "../../lib/photo-details-cache"

describe("album detail cache", () => {
  const loaded = { albums: [{ mediaKey: "album", title: "Weekend", isShared: false }] }

  it("keeps loaded values while marking any missing rows unavailable", () => {
    const empty = createDetailsCache("one@example.test")
    const started = reduceDetailsCache(empty, { type: "start", request: { id: "one", keys: ["a", "b"] } })
    expect(started.entries.get("a")).toEqual({ status: "loading" })
    const received = reduceDetailsCache(started, { type: "rows", id: "one", rows: [{ mediaKey: "a", details: loaded }] })
    const finished = reduceDetailsCache(received, { type: "finish", id: "one" })
    expect(finished.entries.get("a")).toEqual({ status: "loaded", details: loaded })
    expect(finished.entries.get("b")).toMatchObject({ status: "unavailable" })
    expect(finished.request).toBeNull()
  })

  it("ignores stale messages and rows that were never requested", () => {
    const empty = createDetailsCache("one@example.test")
    const started = reduceDetailsCache(empty, { type: "start", request: { id: "two", keys: ["a"] } })
    expect(reduceDetailsCache(started, { type: "rows", id: "old", rows: [{ mediaKey: "a", details: loaded }] })).toBe(started)
    expect(reduceDetailsCache(started, { type: "rows", id: "two", rows: [{ mediaKey: "other", details: loaded }] }).entries.has("other")).toBe(false)
  })

  it("cancels unfinished rows and discards the other account's detail cache", () => {
    const started = reduceDetailsCache(createDetailsCache("one@example.test"), {
      type: "start", request: { id: "one", keys: ["a", "b"] },
    })
    const received = reduceDetailsCache(started, { type: "rows", id: "one", rows: [{ mediaKey: "a", details: loaded }] })
    const cancelled = reduceDetailsCache(received, { type: "cancel" })
    expect(cancelled.entries.get("a")?.status).toBe("loaded")
    expect(cancelled.entries.has("b")).toBe(false)
    expect(reduceDetailsCache(cancelled, { type: "account", account: "two@example.test" }).entries.size).toBe(0)
  })
})
