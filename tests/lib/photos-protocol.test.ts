import { describe, expect, it } from "vitest"
import { parsePhotosCommand, parsePhotosSession, createRequestId } from "../../lib/photos-protocol"

const session = {
  account: "fixture@example.test",
  "f.sid": "1234",
  bl: "fixture-version",
  path: "/u/1/",
  at: "fixture-token",
}

describe("Photos bridge protocol", () => {
  it("bounds and allowlists session fields", () => {
    expect(parsePhotosSession({ ...session, extra: true })).toEqual(session)
    expect(parsePhotosSession({ ...session, path: "/u/1/../" })).toBeNull()
    expect(parsePhotosSession({ ...session, at: "" })).toBeNull()
    expect(parsePhotosSession({ ...session, account: 42 })).toBeNull()
    expect(parsePhotosSession({ ...session, bl: "x".repeat(16385) })).toBeNull()
  })

  it("preserves the existing closed scan options", () => {
    expect(parsePhotosCommand("getAllMediaItems", { dateRange: { from: "2020-02-01" } }))
      .toEqual({ command: "getAllMediaItems" })
    expect(parsePhotosCommand("getAllMediaItems", { dateRange: { surprise: true } })).toBeNull()
    expect(parsePhotosCommand("getAllMediaItems", { unrelated: true })).toBeNull()
  })

  it("rejects malformed or oversized key lists", () => {
    for (const dedupKeys of [[], [" "], ["k", "k"], [42], ["x".repeat(1025)], new Array(10001).fill("x")]) {
      expect(parsePhotosCommand("restoreItems", { dedupKeys })).toBeNull()
    }
    expect(parsePhotosCommand("trashItems", { dedupKeys: ["a"], mediaKeysToTrash: ["b", "b"] })).toBeNull()
    expect(parsePhotosCommand("trashItems", { dedupKeys: ["a"], mediaKeysToTrash: ["b"] })).toEqual({
      command: "trashItems",
      dedupKeys: ["a"],
      mediaKeysToTrash: ["b"],
    })
  })

  it("rejects unknown commands and health check arguments", () => {
    expect(parsePhotosCommand("unknown", undefined)).toBeNull()
    expect(parsePhotosCommand("healthCheck", { unexpected: 1 })).toBeNull()
    expect(parsePhotosCommand("healthCheck", undefined)).toEqual({ command: "healthCheck" })
  })

  it("generates distinct 128-bit internal request IDs", () => {
    const ids = Array.from({ length: 1000 }, createRequestId)
    expect(ids.every(id => /^[a-f0-9]{32}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
