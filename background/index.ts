import {
  createRequestId, isInternalRequestId, MAX_RESULT_BYTES, PHOTOS_ORIGIN,
  parsePhotosCommand, parsePhotosSession, serializedSize,
} from "../lib/photos-protocol"
import type { IsolatedPhotosCommand, PhotosReply, PhotosSession } from "../lib/photos-protocol"
import { APP_ID } from "../lib/types"
import type { AppMessage, GptkCommandMessage, GptkLogMessage } from "../lib/types"

interface DocumentTarget {
  tabId: number
  documentId: string
}

interface AppTarget extends DocumentTarget {
  openerTabId?: number
}

interface VerifiedPhotos extends DocumentTarget {
  session: PhotosSession
}

interface Pairing {
  app: AppTarget
  photos: DocumentTarget
  account: string
  path: string
}

interface PendingCommand {
  pairing: Pairing
  appRequestId: string
  command: string
  timeout?: ReturnType<typeof setTimeout>
  chunks?: { total: number; received: Set<number> }
}

const appUrl = chrome.runtime.getURL("tabs/app.html")
const pending = new Map<string, PendingCommand>()
const detailRequests = new Map<string, { tabId: number; controller: AbortController }>()
const PAIR_PREFIX = "photosPair:"
const REQUEST_IDLE_MS = 90_000
const CONNECT_ERROR = "Google Photos is disconnected. Reconnect and re-scan before continuing."

function isPhotosUrl(url?: string): boolean {
  try {
    return url !== undefined && new URL(url).origin === PHOTOS_ORIGIN
  } catch {
    return false
  }
}

function senderDocument(sender: chrome.runtime.MessageSender): DocumentTarget | null {
  const tabId = sender.tab?.id
  if (sender.id !== chrome.runtime.id || tabId === undefined || sender.frameId !== 0 || !sender.documentId) return null
  if (sender.documentLifecycle && sender.documentLifecycle !== "active") return null
  return { tabId, documentId: sender.documentId }
}

// This function is serialized by Chrome. Keep it self-contained and return only
// bounded primitive fields. No operation, request argument, or listener enters MAIN.
function readPageSession() {
  if (location.origin !== "https://photos.google.com") return null
  const wiz = (window as Window & { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data
  if (!wiz) return null
  function text(value: unknown) {
    return typeof value === "string" && value.length <= 16_384 ? value : null
  }
  return {
    account: text(wiz.oPEP7c),
    "f.sid": text(wiz.FdrFJe),
    bl: text(wiz.cfb2h),
    path: text(wiz.eptZe),
    at: text(wiz.SNlM0e),
  }
}

async function readPhotos(tabId: number, documentId?: string): Promise<VerifiedPhotos | null> {
  try {
    // The pinned Chrome type package omits scripting's documentId fields.
    const target: chrome.scripting.InjectionTarget & { documentIds?: string[] } =
      documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] }
    const results: (chrome.scripting.InjectionResult<unknown> & { documentId?: string })[] =
      await chrome.scripting.executeScript({ target, world: "MAIN", func: readPageSession })
    const [result] = results
    if (
      results.length !== 1 || result?.frameId !== 0 || !result.documentId ||
      (documentId && result.documentId !== documentId)
    ) return null
    const session = parsePhotosSession(result.result)
    return session ? { tabId, documentId: result.documentId, session } : null
  } catch {
    return null
  }
}

async function findPhotos(openerTabId?: number): Promise<VerifiedPhotos | null> {
  // Keep the toolbar's source tab first. A directly opened app uses the active
  // or most recently accessed Photos tab that passes both browser probes.
  type TabWithAccess = chrome.tabs.Tab & { lastAccessed?: number }
  const tabs = await chrome.tabs.query({ url: PHOTOS_ORIGIN + "/*" }) as TabWithAccess[]
  tabs.sort((a, b) => {
    if (openerTabId !== undefined && a.id === openerTabId) return -1
    if (openerTabId !== undefined && b.id === openerTabId) return 1
    return Number(Boolean(b.active)) - Number(Boolean(a.active)) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
  })
  for (const tab of tabs) {
    if (tab.id === undefined || !isPhotosUrl(tab.url)) continue
    const photos = await readPhotos(tab.id)
    if (!photos) continue
    try {
      const ready = await sendToDocument(photos, { app: APP_ID, action: "photosProbe" })
      if (ready === true) return photos
    } catch {
      // This document has no isolated bridge. Continue to the next candidate.
    }
  }
  return null
}

function sendToDocument(target: DocumentTarget, message: object) {
  return chrome.tabs.sendMessage(target.tabId, message, { documentId: target.documentId })
}

function sameAccount(photos: VerifiedPhotos | null, pairing: Pairing): photos is VerifiedPhotos {
  return photos !== null && photos.session.account === pairing.account && photos.session.path === pairing.path
}

async function replyToApp(app: DocumentTarget, message: AppMessage): Promise<boolean> {
  try {
    await sendToDocument(app, message)
    return true
  } catch {
    // The app may have closed or navigated.
    return false
  }
}

function finish(id: string): void {
  clearTimeout(pending.get(id)?.timeout)
  pending.delete(id)
}

function fail(id: string, error: string): void {
  const entry = pending.get(id)
  if (!entry) return
  finish(id)
  void replyToApp(entry.pairing.app, {
    app: APP_ID, action: "gptkResult", command: entry.command,
    requestId: entry.appRequestId, success: false, error,
  })
}

function arm(id: string, entry: PendingCommand): void {
  clearTimeout(entry.timeout)
  entry.timeout = setTimeout(() => fail(id,
    "Google Photos stopped responding. Check Photos before retrying the operation."
  ), REQUEST_IDLE_MS)
}

async function connect(app: AppTarget): Promise<void> {
  let photos: VerifiedPhotos | null = null
  const key = PAIR_PREFIX + app.documentId
  try {
    await chrome.storage.session.remove(key)
    photos = await findPhotos(app.openerTabId)
    if (photos) {
      const { tabId, documentId, session } = photos
      const pairing: Pairing = { app, photos: { tabId, documentId }, account: session.account, path: session.path }
      // Session storage survives MV3 suspension. RPC tokens never enter storage.
      await chrome.storage.session.set({ [key]: pairing })
    }
  } catch {
    photos = null
  }
  await replyToApp(app, {
    app: APP_ID, action: "healthCheck.result", success: photos !== null, hasGptk: photos !== null,
    ...(photos ? { accountEmail: photos.session.account } : {}),
  })
}

async function start(app: AppTarget, message: GptkCommandMessage, signal?: AbortSignal): Promise<void> {
  if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 128 ||
      typeof message.command !== "string" || message.command.length > 64) return
  const errorReply = (error: string) => replyToApp(app, {
    app: APP_ID, action: "gptkResult", command: message.command,
    requestId: message.requestId, success: false, error,
  })

  const command = parsePhotosCommand(message.command, message.args)
  if (!command) {
    await errorReply("Invalid Photos command or arguments.")
    return
  }
  const key = PAIR_PREFIX + app.documentId
  const pairing = (await chrome.storage.session.get(key))[key] as Pairing | undefined
  if (signal?.aborted) return
  if (!pairing || pairing.app.tabId !== app.tabId) {
    await errorReply(CONNECT_ERROR)
    return
  }

  const photos = await readPhotos(pairing.photos.tabId, pairing.photos.documentId)
  if (signal?.aborted) return
  if (!sameAccount(photos, pairing)) {
    await errorReply(CONNECT_ERROR)
    return
  }
  if (command.command === "healthCheck") {
    await replyToApp(app, {
      app: APP_ID, action: "gptkResult", command: "healthCheck", requestId: message.requestId,
      success: true, data: { hasGptk: true, hasWizData: true, accountEmail: pairing.account },
    })
    return
  }

  if (Array.from(pending.values()).some(entry =>
    entry.pairing.app.documentId === app.documentId && entry.appRequestId === message.requestId
  )) return
  const id = createRequestId()
  const entry: PendingCommand = { pairing, appRequestId: message.requestId, command: command.command }
  const isolated: IsolatedPhotosCommand = {
    app: APP_ID, action: "gptkCommand", command: command.command, args: message.args,
    requestId: id, session: photos.session,
  }
  pending.set(id, entry)
  arm(id, entry)
  try {
    await sendToDocument(photos, isolated)
  } catch {
    fail(id, CONNECT_ERROR)
  }
}

async function relay(message: PhotosReply, source: DocumentTarget): Promise<boolean> {
  if (!isInternalRequestId(message.requestId)) return false
  const entry = pending.get(message.requestId)
  if (!entry || entry.command !== message.command ||
      entry.pairing.photos.tabId !== source.tabId ||
      entry.pairing.photos.documentId !== source.documentId) return false

  if (serializedSize(message) > MAX_RESULT_BYTES) {
    fail(message.requestId, "A Photos response exceeded the bridge size limit.")
    return false
  }

  if (message.action === "gptkProgress") {
    if (!Number.isSafeInteger(message.itemsProcessed) || message.itemsProcessed < 0) return false
    if (entry.command === "trashItems" || entry.command === "restoreItems") {
      const photos = await readPhotos(source.tabId, source.documentId)
      if (pending.get(message.requestId) !== entry) return false
      if (!sameAccount(photos, entry.pairing)) {
        fail(message.requestId, CONNECT_ERROR)
        return false
      }
    }
    arm(message.requestId, entry)
  } else if (message.action === "gptkResultChunk") {
    if (!Array.isArray(message.data) || !Number.isSafeInteger(message.chunkIndex) ||
        !Number.isSafeInteger(message.totalChunks) || message.totalChunks > 10_000 ||
        message.chunkIndex < 0 || message.chunkIndex >= message.totalChunks) return false
    const chunks = entry.chunks ??= { total: message.totalChunks, received: new Set() }
    if (chunks.total !== message.totalChunks || chunks.received.has(message.chunkIndex)) return false
    chunks.received.add(message.chunkIndex)
    if (chunks.received.size === chunks.total) finish(message.requestId)
    else arm(message.requestId, entry)
  } else {
    if (typeof message.success !== "boolean") return false
    finish(message.requestId)
  }

  const delivered = await replyToApp(entry.pairing.app, { ...message, requestId: entry.appRequestId })
  if (!delivered) finish(message.requestId)
  return delivered
}

function cancelDetails(app: AppTarget, appRequestId: string): void {
  detailRequests.get(app.documentId + ":" + appRequestId)?.controller.abort()
  for (const [id, entry] of pending) {
    if (entry.command !== "getItemDetails" || entry.pairing.app.documentId !== app.documentId ||
        entry.pairing.app.tabId !== app.tabId || entry.appRequestId !== appRequestId) continue
    finish(id)
    void sendToDocument(entry.pairing.photos, { app: APP_ID, action: "gptkCancel", requestId: id }).catch(() => {})
    return
  }
}

chrome.runtime.onMessage.addListener((message: AppMessage, sender, respond) => {
  if (message?.app !== APP_ID) return
  const source = senderDocument(sender)
  if (!source) return
  if (sender.url === appUrl) {
    const app = { ...source, openerTabId: sender.tab?.openerTabId }
    if (message.action === "healthCheck") {
      void connect(app).then(() => respond(), () => respond())
      return true
    }
    if (message.action === "gptkCancel") {
      cancelDetails(app, message.requestId)
      return
    }
    if (message.action === "gptkCommand") {
      if (message.command === "getItemDetails" && typeof message.requestId === "string" &&
          message.requestId.length <= 128) {
        const key = app.documentId + ":" + message.requestId
        if (detailRequests.has(key)) return
        const controller = new AbortController()
        detailRequests.set(key, { tabId: app.tabId, controller })
        void start(app, message, controller.signal).catch(() => {}).finally(() => {
          detailRequests.delete(key)
          respond()
        })
      } else {
        void start(app, message).then(() => respond(), () => respond())
      }
      return true
    }
  } else if (isPhotosUrl(sender.url)) {
    if (message.action === "gptkResult" || message.action === "gptkResultChunk" || message.action === "gptkProgress") {
      void relay(message, source).then(respond, () => respond(false))
      return true
    }
  }
})

async function forgetTab(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get()
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PAIR_PREFIX)) continue
    const pairing = value as Pairing
    if (pairing.app.tabId !== tabId && pairing.photos.tabId !== tabId) continue
    await chrome.storage.session.remove(key)
    if (pairing.photos.tabId === tabId && pairing.app.tabId !== tabId) {
      const message: GptkLogMessage = {
        app: APP_ID, action: "gptkLog", level: "error", message: "Google Photos tab was closed.",
      }
      await replyToApp(pairing.app, message)
    }
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  for (const { tabId: appTabId, controller } of detailRequests.values()) {
    if (appTabId === tabId) controller.abort()
  }
  for (const [id, entry] of pending) {
    if (entry.pairing.app.tabId === tabId) {
      if (entry.command === "getItemDetails") cancelDetails(entry.pairing.app, entry.appRequestId)
      else finish(id)
    }
    else if (entry.pairing.photos.tabId === tabId) fail(id, CONNECT_ERROR)
  }
  void forgetTab(tabId).catch(() => {})
})

chrome.action.onClicked.addListener(tab => {
  const openerTabId = isPhotosUrl(tab.url) ? tab.id : undefined
  void chrome.tabs.create({ url: appUrl, ...(openerTabId === undefined ? {} : { openerTabId }) }).catch(() => {})
})
