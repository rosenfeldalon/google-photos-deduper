import type { PhotoDetailsEntry, PhotoDetailsRow } from "./photo-details"

interface DetailRequest {
  id: string
  keys: string[]
}

export interface DetailsCache {
  account: string | null
  entries: ReadonlyMap<string, PhotoDetailsEntry>
  request: DetailRequest | null
  loadAll: boolean
}

export type DetailsAction =
  | { type: "account"; account: string | null }
  | { type: "start"; request: DetailRequest }
  | { type: "rows"; id: string; rows: PhotoDetailsRow[] }
  | { type: "finish"; id: string }
  | { type: "cancel" }
  | { type: "loadAll" }

export function createDetailsCache(account: string | null): DetailsCache {
  return { account, entries: new Map(), request: null, loadAll: false }
}

export function reduceDetailsCache(cache: DetailsCache, action: DetailsAction): DetailsCache {
  switch (action.type) {
    case "account":
      return action.account === cache.account ? cache : createDetailsCache(action.account)
    case "loadAll":
      return cache.loadAll ? cache : { ...cache, loadAll: true }
    case "start": {
      if (cache.request) return cache
      const entries = new Map(cache.entries)
      for (const key of action.request.keys) entries.set(key, { status: "loading" })
      return { ...cache, request: action.request, entries }
    }
    case "rows": {
      if (cache.request?.id !== action.id) return cache
      const entries = new Map(cache.entries)
      for (const { mediaKey, details } of action.rows) {
        if (entries.get(mediaKey)?.status !== "loading") continue
        entries.set(mediaKey, "unavailable" in details
          ? { status: "unavailable", reason: details.reason }
          : { status: "loaded", details })
      }
      return { ...cache, entries }
    }
    case "finish":
    case "cancel": {
      const request = cache.request
      if (!request || (action.type === "finish" && request.id !== action.id)) return cache
      const entries = new Map(cache.entries)
      for (const key of request.keys) {
        if (entries.get(key)?.status !== "loading") continue
        if (action.type === "cancel") entries.delete(key)
        else entries.set(key, { status: "unavailable", reason: "Photos did not return album information." })
      }
      return { ...cache, request: null, entries }
    }
  }
}
