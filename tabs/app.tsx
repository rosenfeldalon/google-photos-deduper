import CloseIcon from "@mui/icons-material/Close"
import Alert from "@mui/material/Alert"
import AppBar from "@mui/material/AppBar"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import CircularProgress from "@mui/material/CircularProgress"
import LinearProgress from "@mui/material/LinearProgress"
import CssBaseline from "@mui/material/CssBaseline"
import IconButton from "@mui/material/IconButton"
import Snackbar from "@mui/material/Snackbar"
import { ThemeProvider } from "@mui/material/styles"
import Toolbar from "@mui/material/Toolbar"
import Typography from "@mui/material/Typography"
import confetti from "canvas-confetti"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"

import { ActionBar } from "../components/ActionBar"
import { DuplicateGroups } from "../components/DuplicateGroups"
import { OwnerConfirmation, ProvenanceSummary } from "../components/PhotoProvenance"
import { ScanConfig } from "../components/ScanConfig"
import { ScanProgress } from "../components/ScanProgress"
import { TrashConfirmation, type TrashPlan } from "../components/TrashConfirmation"
import { appReducer } from "../lib/app-reducer"
import type { AppAction, AppState } from "../lib/app-reducer"
import { debug } from "../lib/debug"
import {
  fullDetectDuplicates,
  smartDetectDuplicates
} from "../lib/duplicate-detector"
import type { DetectionProgress } from "../lib/duplicate-detector"
import {
  classifyProvenance, defaultProvenanceKeeps, describeSkippedTrash, guardTrashSelection, inferOwner, mayManuallyTrash
} from "../lib/photo-provenance"
import type { Provenance } from "../lib/photo-provenance"
import { createRequestId } from "../lib/photos-protocol"
import { ScanLogger } from "../lib/scan-log"
import theme from "../lib/theme"
import { APP_ID, DEFAULT_SETTINGS } from "../lib/types"
import { usePhotoDetails } from "../lib/use-photo-details"
import { usePhotoOwner } from "../lib/use-photo-owner"
import type {
  AppMessage,
  DuplicateGroup,
  GpdMediaItem,
  GptkProgressMessage,
  GptkResultChunkMessage,
  GptkResultMessage,
  HealthCheckResultMessage,
  ScanSettings,
  StoredState
} from "../lib/types"

// ============================================================
// Helpers
// ============================================================

// Initial healthCheck retries. The first probe often fails on a freshly
// opened app tab because the bridge content script on photos.google.com has
// not finished loading yet, or because the MV3 service worker is still
// spinning up from idle. Backoff: 400ms, 800ms, 1600ms, 3200ms (5 attempts).
const HEALTH_CHECK_MAX_ATTEMPTS = 5

// How long the fetch phase may go without any sign of life before the app
// gives up. The page script times each pagination request out after 60s, so
// silence well past that means the result was lost in transit rather than
// merely slow — most often a message that never arrived (#147). Without this
// the app waits forever and the scan looks frozen mid-count.
const FETCH_WATCHDOG_MS = 150_000

function sendToServiceWorker(message: AppMessage): void {
  chrome.runtime.sendMessage(message)
}

// ============================================================
// App component
// ============================================================

export default function App() {
  const [state, dispatch] = useReducer(appReducer, { status: "connecting" })
  const [storageChecked, setStorageChecked] = useState(false)
  const [photosAccount, setPhotosAccount] = useState<string | null>(null)
  const photosConnected = photosAccount !== null
  const [settings, setSettings] = useReducer(
    (prev: ScanSettings, next: Partial<ScanSettings>) => ({ ...prev, ...next }),
    DEFAULT_SETTINGS
  )

  // Selection state: which groups are selected for trash
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    new Set()
  )

  // Kept overrides: groupId -> Set of mediaKeys the user marked as "Keep"
  const [keptOverrides, setKeptOverrides] = useState<
    Record<string, Set<string>>
  >({})

  // Confirm dialog state
  const [trashConfirm, setTrashConfirm] = useState<TrashPlan | null>(null)
  const [manualShared, setManualShared] = useState<Set<string>>(new Set())
  const [trashNotice, setTrashNotice] = useState<string>()

  type Snapshot = {
    mediaItems: Record<string, GpdMediaItem>
    groups: DuplicateGroup[]
    totalItems: number
  }
  type TrashOperation = {
    requestId: string
    account: string
    dedupKeys: string[]
    count: number
    snapshot: Snapshot
    progressCounts: number[]
  }
  const [undoData, setUndoData] = useState<TrashOperation | null>(null)
  const pendingTrashRef = useRef<TrashOperation | null>(null)

  // AbortController for the current scan (cancelled on user request or new scan)
  const scanAbortRef = useRef<AbortController | null>(null)

  // Persisted scan performance logger — survives page reloads via chrome.storage.local
  const scanLoggerRef = useRef(new ScanLogger())

  // Tracks the requestId of the active scan so stale results from previous
  // scans killed by reload can be dropped (they arrive late from the GP tab)
  const currentScanRequestIdRef = useRef<string | null>(null)

  // Reassembly buffer for chunked getAllMediaItems results, keyed by requestId.
  // Chunks are stored by index because relaying through the service worker does
  // not guarantee arrival order.
  const resultChunksRef = useRef<
    Record<string, { chunks: GpdMediaItem[][]; received: number; total: number }>
  >({})

  // Watchdog for the fetch phase — see FETCH_WATCHDOG_MS.
  const fetchWatchdogRef = useRef<number | null>(null)

  const clearFetchWatchdog = useCallback(() => {
    if (fetchWatchdogRef.current !== null) {
      window.clearTimeout(fetchWatchdogRef.current)
      fetchWatchdogRef.current = null
    }
  }, [])

  // (Re)starts the watchdog. Called on every sign of progress, so the timer
  // measures silence rather than total fetch duration — a slow scan of a huge
  // library keeps running as long as it keeps reporting.
  const armFetchWatchdog = useCallback(() => {
    clearFetchWatchdog()
    fetchWatchdogRef.current = window.setTimeout(() => {
      fetchWatchdogRef.current = null
      if (currentScanRequestIdRef.current === null) return
      console.error("[GPD] fetch watchdog fired — no progress from the Google Photos tab")
      currentScanRequestIdRef.current = null
      resultChunksRef.current = {}
      scanAbortRef.current?.abort()
      dispatch({
        type: "SCAN_ERROR",
        error:
          "Stopped hearing from the Google Photos tab while fetching your library. " +
          "Reload the Google Photos tab and try scanning again."
      })
    }, FETCH_WATCHDOG_MS)
  }, [clearFetchWatchdog])

  // Counts failed healthCheck attempts during initial connect so we can retry
  // silently before showing a disconnected error.
  const healthCheckAttemptsRef = useRef(0)

  // Holds selections loaded from storage; applied once when groups first load
  const pendingSelectionsRef = useRef<{
    selectedGroupIds: Set<string>
    keptOverrides: Record<string, Set<string>>
  } | null>(null)

  // Sync selectedGroupIds when groups change (e.g. after scan or trash)
  const stateGroups =
    state.status === "results" || state.status === "trashing"
      ? state.groups
      : null
  const groups = useMemo(() => stateGroups ?? [], [stateGroups])
  const resultsAccount = state.status === "results" && state.accountEmail === photosAccount ? photosAccount : null
  const photoDetails = usePhotoDetails(resultsAccount, groups, state.status === "results", true)
  const photoOwner = usePhotoOwner(resultsAccount)
  const selfActorId = photoOwner.decision?.actorId
  const selectionReady = photoDetails.allResolved && !!selfActorId

  useEffect(() => {
    setManualShared(new Set())
    setTrashConfirm(null)
    setTrashNotice(undefined)
  }, [resultsAccount, groups])
  useEffect(() => {
    if (pendingSelectionsRef.current) {
      const saved = pendingSelectionsRef.current
      pendingSelectionsRef.current = null
      const validIds = new Set(groups.map((g) => g.id))
      // Restore saved selection, filtered to groups that still exist
      const next = new Set([...saved.selectedGroupIds].filter((id) => validIds.has(id)))
      setSelectedGroupIds(next)
      // Restore kept overrides, filtered to valid groups
      const filteredKept: Record<string, Set<string>> = {}
      for (const [id, keys] of Object.entries(saved.keptOverrides)) {
        if (validIds.has(id)) filteredKept[id] = keys
      }
      setKeptOverrides(filteredKept)
    } else {
      setSelectedGroupIds(new Set(groups.map((g) => g.id)))
      setKeptOverrides({})
    }
  }, [groups])


  // Listen for messages from service worker
  useEffect(() => {
    // Shared tail of a completed getAllMediaItems fetch, however it arrived
    // (chunked, or as a single legacy gptkResult).
    const completeMediaFetch = (fetched: GpdMediaItem[]) => {
      // Fetching is done; detection reports progress through its own path.
      clearFetchWatchdog()
      const items = fetched
      dispatch({
        type: "SCAN_MEDIA_FETCHED",
        mediaItems: items
      })
      runDuplicateDetection(
        items,
        scanAbortRef.current?.signal ?? new AbortController().signal
      )
    }

    const listener = (message: AppMessage, sender: chrome.runtime.MessageSender) => {
      if (message?.app !== APP_ID) return
      // runtime.sendMessage also reaches extension pages directly from content scripts.
      if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return

      switch (message.action) {
        case "healthCheck.result": {
          const msg = message as HealthCheckResultMessage
          setPhotosAccount(msg.success && msg.hasGptk ? msg.accountEmail ?? null : null)
          // Swallow early "failed" results and retry — when the app tab opens
          // before the bridge content script has fully loaded on a fresh
          // photos.google.com tab, or when the service worker has just woken
          // up from MV3 idle, the first probe often misses. Without this the
          // user sees a spurious "disconnected" flash and has to manually hit
          // Retry. We give up after a few attempts and let the reducer show
          // the error.
          if (
            !msg.success &&
            healthCheckAttemptsRef.current < HEALTH_CHECK_MAX_ATTEMPTS - 1
          ) {
            healthCheckAttemptsRef.current++
            const delay = 400 * Math.pow(2, healthCheckAttemptsRef.current - 1)
            window.setTimeout(() => {
              sendToServiceWorker({ app: APP_ID, action: "healthCheck" })
            }, delay)
            return
          }
          if (msg.success) healthCheckAttemptsRef.current = 0
          dispatch({
            type: "HEALTH_CHECK_RESULT",
            payload: msg
          })
          break
        }
        case "gptkResultChunk": {
          const chunk = message as GptkResultChunkMessage
          if (chunk.command !== "getAllMediaItems") break
          // Drop stale chunks from scans that were killed/cancelled
          if (chunk.requestId !== currentScanRequestIdRef.current) {
            console.warn(
              `[GPD] Dropping stale result chunk for requestId ${chunk.requestId} (active: ${currentScanRequestIdRef.current})`
            )
            break
          }
          const buffers = resultChunksRef.current
          let buf = buffers[chunk.requestId]
          if (!buf) {
            buf = {
              chunks: new Array(chunk.totalChunks),
              received: 0,
              total: chunk.totalChunks
            }
            buffers[chunk.requestId] = buf
          }
          armFetchWatchdog()
          // Ignore a duplicate delivery of the same index
          if (buf.chunks[chunk.chunkIndex] !== undefined) break
          buf.chunks[chunk.chunkIndex] = chunk.data as GpdMediaItem[]
          buf.received++
          if (buf.received < buf.total) break

          delete buffers[chunk.requestId]
          const items = buf.chunks.flat()
          console.log(
            `[GPD] reassembled ${items.length} media items from ${buf.total} chunk(s)`
          )
          completeMediaFetch(items)
          break
        }
        case "gptkResult": {
          const result = message as GptkResultMessage
          if (result.command === "getAllMediaItems") {
            // Drop stale results from scans that were killed/cancelled — their
            // GPTK request may have still been in-flight and arrives late
            if (result.requestId !== currentScanRequestIdRef.current) {
              console.warn(
                `[GPD] Dropping stale getAllMediaItems result for requestId ${result.requestId} (active: ${currentScanRequestIdRef.current})`
              )
              break
            }
            if (result.success) {
              completeMediaFetch(result.data as GpdMediaItem[])
            } else {
              clearFetchWatchdog()
              dispatch({
                type: "SCAN_ERROR",
                error: result.error || "Scan failed"
              })
            }
          } else if (result.command === "trashItems") {
            const operation = pendingTrashRef.current
            if (!operation || operation.requestId !== result.requestId) break
            pendingTrashRef.current = null
            if (result.success) {
              const data = result.data as { trashedKeys: string[] }
              dispatch({ type: "TRASH_COMPLETE", trashedKeys: data.trashedKeys || [] })
              setUndoData(operation)
            } else {
              dispatch({
                type: "TRASH_ERROR",
                error: result.error || "Trash failed"
              })
            }
          } else if (result.command === "restoreItems") {
            if (!result.success) {
              // Optimistic restore already happened in UI; show a non-blocking alert
              console.error("GPD: Restore failed:", result.error)
            }
          }
          break
        }
        case "gptkLog":
          if ((message as { level?: string }).level === "error") {
            setPhotosAccount(null)
            dispatch({ type: "GP_TAB_CLOSED" })
          }
          break
        case "gptkProgress": {
          const progress = message as GptkProgressMessage
          if (progress.command === "getItemDetails") break
          // Any fetch progress means the GP tab is still alive — reset the
          // silence timer.
          if (
            progress.command === "getAllMediaItems" &&
            progress.requestId === currentScanRequestIdRef.current
          ) {
            armFetchWatchdog()
          }
          if (progress.command === "getAllMediaItems" && progress.requestId !== currentScanRequestIdRef.current) break
          if (progress.command === "trashItems") {
            const operation = pendingTrashRef.current
            if (!operation || operation.requestId !== progress.requestId) break
            const trashedSoFar = operation.progressCounts[progress.itemsProcessed - 1]
            if (trashedSoFar !== undefined) dispatch({ type: "TRASH_PROGRESS", trashedSoFar })
          } else if (progress.command === "restoreItems") {
            console.log(`[GPD] restore progress: ${progress.itemsProcessed}`)
          } else {
            dispatch({ type: "SCAN_PROGRESS", payload: progress })
          }
          break
        }
      }
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [armFetchWatchdog, clearFetchWatchdog])

  // Keep refs so async callbacks always see latest values
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const stateRef = useRef(state)
  stateRef.current = state

  // Run MediaPipe duplicate detection on fetched media items
  const runDuplicateDetection = useCallback(
    async (items: GpdMediaItem[], signal: AbortSignal) => {
      const logger = scanLoggerRef.current
      await logger.start(items.length)
      try {
        const onProgressCallback = (progress: DetectionProgress) => {
          dispatch({
            type: "SCAN_PROGRESS",
            phase: progress.phase,
            totalItems: progress.total,
            payload: {
              app: APP_ID,
              action: "gptkProgress",
              requestId: "",
              itemsProcessed: progress.current,
              message: `${progress.phase}: ${progress.current}/${progress.total}`
            }
          })
        }

        // Smart mode reports how many timestamp buckets it had to split to
        // keep pairwise comparison bounded; full mode never splits.
        const { groups, bucketsSplit } =
          settingsRef.current.scanMode === "smart"
            ? await smartDetectDuplicates(
                items,
                settingsRef.current.similarityThreshold,
                (settingsRef.current.smartWindowSec ?? 1) * 1000,
                onProgressCallback,
                signal,
                logger
              )
            : await (async () => {
                const result = await fullDetectDuplicates(
                  items,
                  settingsRef.current.similarityThreshold,
                  onProgressCallback,
                  signal,
                  logger
                )
                return { groups: result.groups, bucketsSplit: 0 }
              })()

        await logger.finalize("complete", { groupsFound: groups.length })
        currentScanRequestIdRef.current = null

        const mediaItemMap: Record<string, GpdMediaItem> = {}
        for (const item of items) {
          mediaItemMap[item.mediaKey] = item
        }

        dispatch({
          type: "SCAN_COMPLETE",
          mediaItems: mediaItemMap,
          groups,
          bucketsSplit
        })
        // Refresh account email after scan — the email in state may be stale
        // if the user switched accounts since the last health check.
        sendToServiceWorker({ app: APP_ID, action: "healthCheck" })
      } catch (error) {
        currentScanRequestIdRef.current = null
        if (error instanceof DOMException && error.name === "AbortError") {
          await logger.finalize("cancelled")
          dispatch({ type: "SCAN_CANCELLED" })
        } else {
          await logger.finalize("error", { error: String(error) })
          dispatch({
            type: "SCAN_ERROR",
            error: `Duplicate detection failed: ${error}`
          })
        }
      }
    },
    []
  )

  // Stop the fetch watchdog if the app tab goes away mid-scan
  useEffect(() => clearFetchWatchdog, [clearFetchWatchdog])

  // Health check on mount + recover any scan log entry orphaned by a page reload
  useEffect(() => {
    sendToServiceWorker({ app: APP_ID, action: "healthCheck" })
    scanLoggerRef.current.recoverStale()
  }, [])

  // Load saved settings and results on mount
  useEffect(() => {
    chrome.storage.local.get(
      ["settings", "scanResults", "selections"],
      (result: Partial<StoredState>) => {
        if (result.settings) {
          setSettings(result.settings)
        }
        if (result.selections) {
          // Store deserialized selections before dispatching LOAD_SAVED_RESULTS so
          // the groups-change effect can apply them when groups first appear
          pendingSelectionsRef.current = {
            selectedGroupIds: new Set(result.selections.selectedGroupIds),
            keptOverrides: Object.fromEntries(
              Object.entries(result.selections.keptOverrides).map(([k, v]) => [k, new Set(v)])
            ),
          }
        }
        if (result.scanResults?.totalItems && Array.isArray(result.scanResults.groups)) {
          dispatch({
            type: "LOAD_SAVED_RESULTS",
            mediaItems: result.scanResults.mediaItems,
            groups: result.scanResults.groups,
            totalItems: result.scanResults.totalItems,
            bucketsSplit: result.scanResults.bucketsSplit,
            accountEmail: result.scanResults.accountEmail
          })
        }
        setStorageChecked(true)
      }
    )
  }, [])

  // Persist scan results when they change (after scan or trash)
  const mediaItems = state.status === "results" ? state.mediaItems : null

  const scanItems = useMemo(() => mediaItems ? Object.values(mediaItems) : [], [mediaItems])
  const groupItems = useMemo(() => mediaItems
    ? [...new Set(groups.flatMap(group => group.mediaKeys))].map(key => mediaItems[key]).filter(Boolean)
    : [], [groups, mediaItems])
  const candidate = useMemo(() => photoDetails.allResolved && !selfActorId
    ? inferOwner(groupItems, photoDetails.entries)
    : undefined, [groupItems, photoDetails.allResolved, photoDetails.entries, selfActorId])
  const ownerCandidate = photoOwner.ready && candidate?.actorId !== photoOwner.decision?.rejectedActorId ? candidate : undefined

  const provenanceByKey = useMemo(() => new Map<string, Provenance>(
    groupItems.map(item => [item.mediaKey, classifyProvenance(item, photoDetails.entries.get(item.mediaKey), selfActorId)])
  ), [groupItems, photoDetails.entries, selfActorId])
  const kindOf = useCallback((key: string) => provenanceByKey.get(key) ?? "unknown", [provenanceByKey])

  const keptByGroupId = useMemo(() => {
    const next = new Map<string, Set<string>>()
    for (const group of groups) {
      const items = group.mediaKeys.map(key => mediaItems?.[key]).filter((item): item is GpdMediaItem => !!item)
      const kept = new Set(keptOverrides[group.id] ?? defaultProvenanceKeeps(items, kindOf))
      for (const key of group.mediaKeys) {
        const kind = kindOf(key)
        if (!selectionReady || !mayManuallyTrash(kind) || (kind === "mine-in-shared-album" && !manualShared.has(key))) kept.add(key)
      }
      next.set(group.id, kept)
    }
    return next
  }, [groups, keptOverrides, kindOf, manualShared, mediaItems, selectionReady])

  const selectedGroups = useMemo(() => new Set(groups
    .filter(group => selectedGroupIds.has(group.id) && group.mediaKeys.some(key => !keptByGroupId.get(group.id)?.has(key)))
    .map(group => group.id)), [groups, keptByGroupId, selectedGroupIds])

  const handleToggleGroup = useCallback((groupId: string) => {
    const group = groups.find(item => item.id === groupId)
    const kept = keptByGroupId.get(groupId)
    if (!selectionReady || !group || !kept || group.mediaKeys.every(key => kept.has(key))) return
    if (selectedGroups.has(groupId)) {
      setManualShared(previous => new Set([...previous].filter(key => !group.mediaKeys.includes(key))))
    }
    setSelectedGroupIds(previous => {
      const next = new Set(previous)
      if (selectedGroups.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [groups, keptByGroupId, selectedGroups, selectionReady])

  const handleSelectAll = useCallback(() => {
    if (!selectionReady) return
    setManualShared(new Set())
    setSelectedGroupIds(new Set(groups.map(group => group.id)))
  }, [groups, selectionReady])

  const handleDeselectAll = useCallback(() => {
    setManualShared(new Set())
    setSelectedGroupIds(new Set())
  }, [])

  const handleToggleKept = useCallback((group: DuplicateGroup, key: string) => {
    const kind = kindOf(key)
    const current = keptByGroupId.get(group.id)
    if (!selectionReady || !mayManuallyTrash(kind) || !current) return
    // When the group was unchecked, checking a photo selects the group and
    // leaves its existing per-photo choices intact.
    const markForTrash = !selectedGroups.has(group.id) || current.has(key)
    if (markForTrash && current.has(key) && current.size === 1) {
      setTrashNotice("To move every eligible photo in a group, use the group trash button.")
      return
    }
    const next = new Set(current)
    if (markForTrash) next.delete(key)
    else next.add(key)
    setKeptOverrides(previous => ({ ...previous, [group.id]: next }))
    if (kind === "mine-in-shared-album") {
      setManualShared(previous => {
        const chosen = new Set(previous)
        if (markForTrash) chosen.add(key)
        else chosen.delete(key)
        return chosen
      })
    }
    if (markForTrash) setSelectedGroupIds(previous => new Set([...previous, group.id]))
    setTrashNotice(undefined)
  }, [keptByGroupId, kindOf, selectedGroups, selectionReady])

  const handleTrashWholeGroup = useCallback((group: DuplicateGroup) => {
    if (!selectionReady) return
    const mine = group.mediaKeys.filter(key => kindOf(key) === "mine")
    const current = keptByGroupId.get(group.id)
    if (!mine.length || !current) return
    const allMarked = selectedGroups.has(group.id) && mine.every(key => !current.has(key))
    setManualShared(previous => new Set([...previous].filter(key => !group.mediaKeys.includes(key))))
    setKeptOverrides(previous => {
      const next = { ...previous }
      if (allMarked) delete next[group.id]
      else next[group.id] = new Set(group.mediaKeys.filter(key => kindOf(key) !== "mine"))
      return next
    })
    if (!allMarked) setSelectedGroupIds(previous => new Set([...previous, group.id]))
    setTrashNotice(undefined)
  }, [keptByGroupId, kindOf, selectedGroups, selectionReady])

  const requestedTrashKeys = useMemo(() => groups.flatMap(group =>
    selectedGroups.has(group.id)
      ? group.mediaKeys.filter(key => !keptByGroupId.get(group.id)?.has(key))
      : []
  ), [groups, keptByGroupId, selectedGroups])

  const buildTrashPlan = useCallback(() => {
    if (!selectionReady || !resultsAccount || state.status !== "results") return null
    const guarded = guardTrashSelection(
      requestedTrashKeys, state.mediaItems, photoDetails.entries, selfActorId, manualShared
    )
    const affected = new Set(guarded.mediaKeysToTrash)
    const fullyTrashedGroups = groups.filter(group => group.mediaKeys.every(key => affected.has(key))).length
    return { ...guarded, account: resultsAccount, fullyTrashedGroups }
  }, [groups, manualShared, photoDetails.entries, requestedTrashKeys, resultsAccount, selectionReady, selfActorId, state])

  const totalItems = state.status === "results" ? state.totalItems : 0
  const accountEmailForStorage = state.status === "results" ? state.accountEmail : undefined
  const bucketsSplit =
    state.status === "results" || state.status === "trashing"
      ? state.bucketsSplit
      : 0
  useEffect(() => {
    if (!mediaItems) return
    if (groups.length > 0) {
      chrome.storage.local.set({
        scanResults: {
          mediaItems,
          groups,
          scanDate: Date.now(),
          totalItems,
          bucketsSplit,
          accountEmail: accountEmailForStorage
        }
      })
    } else {
      // All duplicates removed — clear saved results so next open starts fresh
      chrome.storage.local.remove("scanResults")
    }
  }, [groups, mediaItems, totalItems, bucketsSplit, accountEmailForStorage])

  // Persist selections when they change (only while results are showing)
  useEffect(() => {
    if (state.status !== "results") return
    if (groups.length === 0) {
      chrome.storage.local.remove("selections")
      return
    }
    chrome.storage.local.set({
      selections: {
        selectedGroupIds: [...selectedGroupIds],
        keptOverrides: Object.fromEntries(
          Object.entries(keptOverrides).map(([k, v]) => [k, [...v]])
        ),
      },
    })
  }, [selectedGroupIds, keptOverrides, state.status, groups.length])

  // Save settings on change
  useEffect(() => {
    chrome.storage.local.set({ settings })
  }, [settings])

  const handleStartScan = useCallback(async () => {
    // Cancel any in-progress scan
    scanAbortRef.current?.abort()
    scanAbortRef.current = new AbortController()

    const requestId = createRequestId()
    currentScanRequestIdRef.current = requestId
    // Drop any partially reassembled result from a previous scan
    resultChunksRef.current = {}
    const currentState = stateRef.current
    const hasGptk = currentState.status === "connected" ? currentState.hasGptk : true
    const accountEmail =
      currentState.status === "connected" || currentState.status === "results"
        ? currentState.accountEmail
        : undefined
    dispatch({ type: "SCAN_STARTED", requestId, hasGptk, accountEmail })

    console.log(
      `[GPD] starting scan: mode=${settings.scanMode}, threshold=${settings.similarityThreshold}`
    )

    armFetchWatchdog()
    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "getAllMediaItems",
      requestId,
      accountEmail,
      args: {
        dateRange: settings.dateRange
      }
    })
  }, [settings, armFetchWatchdog])

  const handleTrash = useCallback(() => {
    const plan = buildTrashPlan()
    if (!plan) return
    if (!plan.dedupKeys.length) {
      const skipped = describeSkippedTrash(plan.skipped)
      if (skipped) setTrashNotice("Skipped: " + skipped + ".")
      return
    }
    setTrashNotice(undefined)
    setTrashConfirm(plan)
  }, [buildTrashPlan])

  const handleTrashConfirmed = useCallback(() => {
    if (!trashConfirm || state.status !== "results") return
    const checked = buildTrashPlan()
    if (!checked || !checked.dedupKeys.length) {
      setTrashConfirm(null)
      setTrashNotice("The selection is no longer eligible. Check the Photos connection and ownership details.")
      return
    }
    if (JSON.stringify(checked) !== JSON.stringify(trashConfirm)) {
      setTrashConfirm(checked)
      setTrashNotice("The selection changed. Review it again before confirming.")
      return
    }
    const { dedupKeys, mediaKeysToTrash } = checked
    setTrashConfirm(null)

    const requestId = createRequestId()

    const copiesByDedup = new Map<string, number>()
    for (const key of mediaKeysToTrash) {
      const id = state.mediaItems[key].dedupKey
      copiesByDedup.set(id, (copiesByDedup.get(id) ?? 0) + 1)
    }
    let movedSoFar = 0
    pendingTrashRef.current = {
      requestId,
      account: checked.account,
      dedupKeys,
      count: mediaKeysToTrash.length,
      progressCounts: dedupKeys.map(id => movedSoFar += copiesByDedup.get(id) ?? 0),
      snapshot: { mediaItems: state.mediaItems, groups: state.groups, totalItems: state.totalItems },
    }

    dispatch({
      type: "TRASH_STARTED",
      totalToTrash: mediaKeysToTrash.length,
      mediaItems: state.mediaItems,
      groups: state.groups,
      totalItems: state.totalItems
    })

    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "trashItems",
      requestId,
      args: { dedupKeys, mediaKeysToTrash },
      accountEmail: checked.account
    })
  }, [buildTrashPlan, trashConfirm, state])

  const handleCancelScan = useCallback(() => {
    scanAbortRef.current?.abort()
    clearFetchWatchdog()
    currentScanRequestIdRef.current = null
    resultChunksRef.current = {}
    dispatch({ type: "SCAN_CANCELLED" })
  }, [clearFetchWatchdog])

  const handleReset = useCallback(() => {
    clearFetchWatchdog()
    currentScanRequestIdRef.current = null
    resultChunksRef.current = {}
    dispatch({ type: "RESET" })
    setPhotosAccount(null)
    healthCheckAttemptsRef.current = 0
    sendToServiceWorker({ app: APP_ID, action: "healthCheck" })
  }, [clearFetchWatchdog])

  const handleUndo = useCallback(() => {
    if (!undoData || undoData.account !== photosAccount) return
    // Optimistically restore the UI to the pre-trash state
    dispatch({
      type: "RESTORE_SNAPSHOT",
      mediaItems: undoData.snapshot.mediaItems,
      groups: undoData.snapshot.groups,
      totalItems: undoData.snapshot.totalItems
    })
    // Call GPTK to restore from trash
    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "restoreItems",
      requestId: createRequestId(),
      args: { dedupKeys: undoData.dedupKeys },
      accountEmail: undoData.account
    })
    setUndoData(null)
  }, [photosAccount, undoData])

  const handleUndoClose = useCallback(() => {
    setUndoData(null)
  }, [])

  // Fire confetti when trash completes
  useEffect(() => {
    if (!undoData) return
    confetti({
      particleCount: 200,
      spread: 100,
      origin: { y: 0.7 }
    })
  }, [undoData])

  const guardedPlan = useMemo(buildTrashPlan, [buildTrashPlan])
  const duplicateCount = guardedPlan?.mediaKeysToTrash.length ?? 0
  const skippedSelection = guardedPlan ? describeSkippedTrash(guardedPlan.skipped) : ""
  const ownerReason = !photosConnected
    ? "Connect to Google Photos to check ownership."
    : !resultsAccount
      ? "Re-scan the connected account to confirm that these results belong to it."
      : !photoDetails.allResolved || !photoOwner.ready
        ? "Checking ownership for every photo in duplicate groups before trash is available."
        : ownerCandidate
          ? "Confirm this is your Google Photos owner before selecting photos for trash."
          : "Ownership is unconfirmed. Photos stay protected until a matching owner can be confirmed."

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />

      {/* Sticky header */}
      <AppBar position="sticky">
        <Toolbar>
          <Typography variant="h6" fontWeight={600} sx={{ flexGrow: 1 }}>
            Google Photos Deduper
          </Typography>
          {"accountEmail" in state && state.accountEmail && (
            <Typography variant="body2" sx={{ opacity: 0.8 }}>
              Signed in as {state.accountEmail}
            </Typography>
          )}
        </Toolbar>
      </AppBar>

      {/* Main content */}
      <Box
        component="main"
        sx={{ maxWidth: 1200, mx: "auto", px: 3, minHeight: "60vh" }}>
        {state.status === "connecting" && (
          <Box sx={{ display: "flex", justifyContent: "center", pt: 10 }}>
            <CircularProgress disableShrink />
          </Box>
        )}

        {state.status === "disconnected" && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              pt: 8,
              gap: 2
            }}>
            <Alert severity="error" sx={{ maxWidth: 480, width: "100%" }}>
              {state.error}
            </Alert>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                variant="contained"
                href="https://photos.google.com/login"
                target="_blank"
                rel="noopener noreferrer">
                Open Google Photos
              </Button>
              <Button variant="outlined" onClick={handleReset}>
                Retry Connection
              </Button>
            </Box>
            <Typography variant="caption" color="text.secondary">
              Return here once Google Photos is open and you're signed in.
            </Typography>
          </Box>
        )}

        {state.status === "connected" && (
          <ScanConfig
            settings={settings}
            onSettingsChange={setSettings}
            onStartScan={handleStartScan}
            hasGptk={state.hasGptk}
          />
        )}

        {state.status === "scanning" && (
          <ScanProgress
            phase={state.phase}
            itemsProcessed={state.itemsProcessed}
            totalEstimate={state.totalEstimate}
            message={state.message}
            onCancel={handleCancelScan}
            oldestTakenAt={state.oldestTakenAt}
          />
        )}

        {state.status === "results" && groups.length === 0 && storageChecked && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              pt: 8,
              gap: 2
            }}>
            <Typography variant="h6" color="text.secondary">
              No duplicates found in your library.
            </Typography>
            <Button variant="contained" onClick={handleReset}>
              Back to Scan
            </Button>
          </Box>
        )}

        {state.status === "results" && groups.length > 0 && (
          <>
            <ActionBar
              totalItems={state.totalItems}
              groupCount={groups.length}
              duplicateCount={duplicateCount}
              trashDisabled={!selectionReady}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
              onTrash={handleTrash}
              onRescan={handleReset}
            />
            {!selectionReady && (
              <OwnerConfirmation
                candidate={ownerCandidate}
                reason={ownerReason}
                onConfirm={() => { if (ownerCandidate) photoOwner.choose(ownerCandidate.actorId, true) }}
                onReject={() => { if (ownerCandidate) photoOwner.choose(ownerCandidate.actorId, false) }}
              />
            )}
            {(trashNotice || skippedSelection) && (
              <Alert severity="info" sx={{ mb: 2 }}>{trashNotice || "Skipped: " + skippedSelection + "."}</Alert>
            )}
            <ProvenanceSummary items={scanItems} kinds={provenanceByKey} details={photoDetails.entries} />
            <DuplicateGroups
              groups={state.groups}
              mediaItems={state.mediaItems}
              selectedGroupIds={selectedGroups}
              provenanceByKey={provenanceByKey}
              selectionReady={selectionReady}
              onToggleGroup={handleToggleGroup}
              keptByGroupId={keptByGroupId}
              onToggleKept={handleToggleKept}
              onTrashWholeGroup={handleTrashWholeGroup}
              bucketsSplit={state.bucketsSplit}
              photoDetails={photoDetails.entries}
              onLoadAlbumInfo={photoDetails.canLoadMore ? photoDetails.requestAll : undefined}
              albumProgress={photoDetails.progress}
            />
          </>
        )}

        {state.status === "trashing" && (
          <Box sx={{ maxWidth: 480, mx: "auto", p: 4 }}>
            <Typography variant="h5" fontWeight={600} gutterBottom>
              Moving to Trash
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
              <CircularProgress size={14} thickness={5} />
              <Typography variant="body2" color="text.secondary">
                {state.trashedSoFar > 0
                  ? `${state.trashedSoFar.toLocaleString()} of ${state.totalToTrash.toLocaleString()} moved`
                  : "Starting…"}
              </Typography>
            </Box>
            <LinearProgress
              variant={state.trashedSoFar > 0 ? "determinate" : "indeterminate"}
              value={Math.round((state.trashedSoFar / state.totalToTrash) * 100)}
            />
          </Box>
        )}
      </Box>

      <TrashConfirmation
        plan={trashConfirm}
        ready={selectionReady}
        onConfirm={handleTrashConfirmed}
        onClose={() => setTrashConfirm(null)}
      />

      {/* Undo trash snackbar */}
      <Snackbar
        open={!!undoData}
        autoHideDuration={null}
        onClose={handleUndoClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        message={
          undoData
            ? `${undoData.count} item${undoData.count !== 1 ? "s" : ""} moved to trash`
            : ""
        }
        action={
          <>
            <Button color="secondary" size="small" onClick={handleUndo} disabled={undoData?.account !== photosAccount}>
              Undo
            </Button>
            <IconButton size="small" color="inherit" onClick={handleUndoClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      />
    </ThemeProvider>
  )
}
