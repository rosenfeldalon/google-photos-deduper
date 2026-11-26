import { useCallback, useEffect, useMemo, useReducer } from "react"
import type { PhotoDetailsEntry, PhotoDetailsRow } from "./photo-details"
import { createDetailsCache, reduceDetailsCache } from "./photo-details-cache"
import { createRequestId, MAX_DETAIL_KEYS } from "./photos-protocol"
import { APP_ID, type AppMessage, type DuplicateGroup } from "./types"

const AUTO_GROUPS = 6
const REQUEST_SILENCE_MS = 95_000
const EMPTY: ReadonlyMap<string, PhotoDetailsEntry> = new Map()

function isDetailRow(value: unknown): value is PhotoDetailsRow {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<PhotoDetailsRow>
  return typeof row.mediaKey === "string" && !!row.details && typeof row.details === "object" &&
    ("unavailable" in row.details ? row.details.unavailable === true && typeof row.details.reason === "string" :
      Array.isArray(row.details.albums))
}

export function usePhotoDetails(account: string | null, groups: DuplicateGroup[], enabled: boolean) {
  const [cache, dispatch] = useReducer(reduceDetailsCache, account, createDetailsCache)
  const available = enabled && account !== null && account === cache.account
  const entries = cache.account === account ? cache.entries : EMPTY
  const request = available ? cache.request : null

  const allKeys = useMemo(() => [...new Set(groups.flatMap(group => group.mediaKeys))], [groups])
  const autoKeys = useMemo(() => [...new Set(groups.slice(0, AUTO_GROUPS).flatMap(group => group.mediaKeys))], [groups])
  const loadAll = useCallback(() => dispatch({ type: "loadAll" }), [])

  useEffect(() => {
    dispatch({ type: "account", account })
  }, [account])

  useEffect(() => {
    if (!available) {
      dispatch({ type: "cancel" })
      return
    }
    if (request) return
    const keys = (cache.loadAll ? allKeys : autoKeys).filter(key => !entries.has(key)).slice(0, MAX_DETAIL_KEYS)
    if (keys.length) dispatch({ type: "start", request: { id: createRequestId(), keys } })
  }, [allKeys, autoKeys, available, cache.loadAll, entries, request])

  useEffect(() => {
    if (!request) return
    const { id, keys } = request
    const chunks = new Set<number>()
    const finish = () => dispatch({ type: "finish", id })
    let timeout: ReturnType<typeof setTimeout>
    const arm = () => {
      clearTimeout(timeout)
      timeout = setTimeout(finish, REQUEST_SILENCE_MS)
    }
    let settled = false
    const listener = (message: AppMessage, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab !== undefined || message?.app !== APP_ID) return
      if (message.action !== "gptkResultChunk" && message.action !== "gptkResult" && message.action !== "gptkProgress") return
      if (message.command !== "getItemDetails" || message.requestId !== id) return

      arm()
      if (message.action === "gptkProgress") return
      if (message.action === "gptkResultChunk") {
        if (chunks.has(message.chunkIndex)) return
        chunks.add(message.chunkIndex)
        dispatch({ type: "rows", id, rows: message.data.filter(isDetailRow) })
        if (chunks.size < message.totalChunks) return
      }
      settled = true
      finish()
    }
    chrome.runtime.onMessage.addListener(listener)
    arm()
    void chrome.runtime.sendMessage({
      app: APP_ID, action: "gptkCommand", command: "getItemDetails", requestId: id, args: { mediaKeys: keys },
    }).catch(finish)

    return () => {
      clearTimeout(timeout)
      chrome.runtime.onMessage.removeListener(listener)
      if (!settled) void chrome.runtime.sendMessage({ app: APP_ID, action: "gptkCancel", requestId: id }).catch(() => {})
    }
  }, [request])

  return {
    entries,
    requestAll: loadAll,
    canLoadMore: available && !cache.loadAll && allKeys.length > autoKeys.length,
    progress: request ? {
      done: request.keys.filter(key => entries.get(key)?.status !== "loading").length,
      total: request.keys.length,
    } : null,
  }
}
