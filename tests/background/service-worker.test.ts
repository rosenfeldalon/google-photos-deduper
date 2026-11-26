import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { APP_ID } from "../../lib/types"

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (value?: unknown) => void,
) => void | boolean

const id = "test"
const appUrl = "chrome-extension://test/tabs/app.html"
const photosUrl = "https://photos.google.com/"
const session = { account: "fixture@example.test", "f.sid": "100", bl: "version", path: "/", at: "token" }
const app = { id, url: appUrl, tab: { id: 20 }, documentId: "app-doc", frameId: 0 }
const bridge = { id, url: photosUrl, tab: { id: 10 }, documentId: "photos-doc", frameId: 0 }
const appTarget = { documentId: "app-doc" }
const photosTarget = { documentId: "photos-doc" }
let listener: Listener
let clicked: (tab: chrome.tabs.Tab) => void
let tabRemoved: (tabId: number) => void
let stored: Record<string, unknown>

const chromeMock = {
  runtime: {
    id,
    getURL: (path: string) => `chrome-extension://test/${path}`,
    onMessage: { addListener: (fn: Listener) => { listener = fn } },
  },
  scripting: { executeScript: vi.fn() },
  action: { onClicked: { addListener: (fn: typeof clicked) => { clicked = fn } } },
  tabs: {
    create: vi.fn(),
    query: vi.fn(),
    sendMessage: vi.fn(),
    onRemoved: { addListener: (fn: typeof tabRemoved) => { tabRemoved = fn } },
  },
  storage: {
    session: {
      get: vi.fn(async (key?: string) => key === undefined ? stored : { [key]: stored[key] }),
      set: vi.fn(async (value: object) => { Object.assign(stored, value) }),
      remove: vi.fn(async (key: string) => { delete stored[key] }),
    },
  },
}

function send(message: object, sender: object = app) {
  return new Promise(resolve => {
    if (listener({ app: APP_ID, ...message }, sender as chrome.runtime.MessageSender, resolve) !== true) resolve(undefined)
  })
}

async function healthCheck() {
  await send({ action: "healthCheck" })
}

async function scan() {
  await send({ action: "gptkCommand", command: "getAllMediaItems", requestId: "app-scan", args: {} })
  const sent = chromeMock.tabs.sendMessage.mock.calls.find(([, message]) =>
    message.action === "gptkCommand"
  )
  const requestId = sent?.[1].requestId
  expect(requestId).toMatch(/^[\da-f]{32}$/)
  return requestId as string
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal("chrome", chromeMock)
  stored = {}
  chromeMock.tabs.create.mockResolvedValue({})
  chromeMock.tabs.query.mockResolvedValue([{ id: 10, url: photosUrl }])
  chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) =>
    message.action === "photosProbe" ? true : undefined
  )
  chromeMock.scripting.executeScript.mockResolvedValue([{ frameId: 0, documentId: "photos-doc", result: session }])
  await import("../../background/index")
})

afterEach(() => {
  tabRemoved(20)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("Photos service worker", () => {
  it("opens the toolbar app with the Photos opener when available", () => {
    clicked({ id: 10, url: photosUrl } as chrome.tabs.Tab)
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: appUrl, openerTabId: 10 })
  })

  it("reports disconnected without a reachable Photos tab", async () => {
    chromeMock.tabs.query.mockResolvedValue([])
    await healthCheck()
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      20, expect.objectContaining({ action: "healthCheck.result", success: false }), appTarget
    )
  })

  it("probes the verified top document before returning account information", async () => {
    await healthCheck()
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 10, frameIds: [0] }, world: "MAIN",
    }))
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      10, expect.objectContaining({ action: "photosProbe" }), photosTarget
    )
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(20, {
      app: APP_ID, action: "healthCheck.result", success: true, hasGptk: true,
      accountEmail: session.account,
    }, appTarget)
    expect(JSON.stringify(stored)).not.toContain(session.at)
  })

  it("prefers the active tab, then skips to a reachable Photos tab", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      { id: 10, url: photosUrl, lastAccessed: 9 },
      { id: 11, url: photosUrl, active: true },
    ])
    chromeMock.scripting.executeScript.mockRejectedValueOnce(new Error("unavailable"))
    await healthCheck()
    expect(chromeMock.scripting.executeScript.mock.calls.map(([arg]) => arg.target.tabId)).toEqual([11, 10])
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      20, expect.objectContaining({ success: true }), appTarget
    )
  })

  it("does not pair a child frame or a missing isolated bridge", async () => {
    chromeMock.scripting.executeScript.mockResolvedValueOnce([{ frameId: 2, documentId: "child", result: session }])
    await healthCheck()
    chromeMock.tabs.sendMessage.mockResolvedValueOnce(undefined)
    await healthCheck()
    expect(chromeMock.storage.session.set).not.toHaveBeenCalled()
  })

  it.each([
    ["another extension", { ...app, id: "other" }],
    ["a Photos bridge", bridge],
    ["an app subframe", { ...app, frameId: 1 }],
    ["a look-alike path", { ...app, url: appUrl + "2" }],
    ["a missing app document", { ...app, documentId: undefined }],
  ])("rejects commands from %s", async (_role, sender) => {
    await send({ action: "healthCheck" }, sender)
    await send({ action: "gptkCommand", command: "trashItems", args: { dedupKeys: ["a"] }, requestId: "x" }, sender)
    expect(chromeMock.tabs.query).not.toHaveBeenCalled()
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it("requires health pairing before sending a command", async () => {
    await send({ action: "gptkCommand", command: "trashItems", requestId: "x", args: { dedupKeys: ["a"] } })
    expect(chromeMock.tabs.query).not.toHaveBeenCalled()
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(20, expect.objectContaining({ success: false }), appTarget)
  })

  it("requires the same account and document when sending a command", async () => {
    await healthCheck()
    chromeMock.scripting.executeScript.mockResolvedValue([{
      frameId: 0, documentId: "photos-doc", result: { ...session, account: "changed@example.test" },
    }])
    await send({ action: "gptkCommand", command: "getAllMediaItems", requestId: "x" })
    expect(chromeMock.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { tabId: 10, documentIds: ["photos-doc"] },
    }))
    expect(chromeMock.tabs.sendMessage).toHaveBeenLastCalledWith(20, expect.objectContaining({ success: false }), appTarget)
  })

  it("validates command arguments before reading the session", async () => {
    await healthCheck()
    chromeMock.scripting.executeScript.mockClear()
    await send({ action: "gptkCommand", command: "trashItems", requestId: "x", args: { dedupKeys: ["a", "a"] } })
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled()
    expect(chromeMock.tabs.sendMessage).toHaveBeenLastCalledWith(20, expect.objectContaining({ success: false }), appTarget)
  })

  it("rejects mutations and details associated with a different account", async () => {
    await healthCheck()
    chromeMock.scripting.executeScript.mockClear()
    await send({ action: "gptkCommand", command: "trashItems", requestId: "old", args: { dedupKeys: ["a"] } })
    await send({ action: "gptkCommand", command: "getItemDetails", requestId: "old",
      accountEmail: "previous@example.test", args: { mediaKeys: ["a"] } })
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled()
    expect(chromeMock.tabs.sendMessage).toHaveBeenLastCalledWith(
      20, expect.objectContaining({ requestId: "old", success: false }), appTarget
    )
  })

  it("routes authenticated results only once and restores the app request ID", async () => {
    await healthCheck()
    const requestId = await scan()
    const reply = { action: "gptkResult", command: "getAllMediaItems", requestId, success: false, error: "fixture" }
    chromeMock.tabs.sendMessage.mockClear()
    await send(reply, app)
    await send(reply, { ...bridge, id: "other" })
    await send(reply, { ...bridge, frameId: 1 })
    await send(reply, { ...bridge, url: "https://example.test/" })
    await send(reply, { ...bridge, tab: { id: 99 } })
    await send(reply, { ...bridge, documentId: "wrong" })
    await send({ ...reply, command: "trashItems" }, bridge)
    await send({ ...reply, requestId: "f".repeat(32) }, bridge)
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled()
    await send(reply, bridge)
    await send(reply, bridge)
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(
      20, { app: APP_ID, ...reply, requestId: "app-scan" }, appTarget
    )
  })

  it("relays unique chunks and progress before completing the pending request", async () => {
    await healthCheck()
    const requestId = await scan()
    chromeMock.tabs.sendMessage.mockClear()
    const partial = { command: "getAllMediaItems", requestId }
    const chunk = { action: "gptkResultChunk", ...partial, totalChunks: 2, chunkIndex: 1, data: [] }
    await send(chunk, bridge)
    await send(chunk, bridge)
    await send({ action: "gptkProgress", ...partial, itemsProcessed: 10 }, bridge)
    await send({ ...chunk, chunkIndex: 0 }, bridge)
    await send({ ...chunk, chunkIndex: 0 }, bridge)
    expect(chromeMock.tabs.sendMessage.mock.calls.map(([, m]) => m.action)).toEqual([
      "gptkResultChunk", "gptkProgress", "gptkResultChunk",
    ])
  })

  it("expires a silent request", async () => {
    vi.useFakeTimers()
    await healthCheck()
    const requestId = await scan()
    chromeMock.tabs.sendMessage.mockClear()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(chromeMock.tabs.sendMessage).toHaveBeenLastCalledWith(
      20, expect.objectContaining({ requestId: "app-scan", success: false }), appTarget
    )
    const count = chromeMock.tabs.sendMessage.mock.calls.length
    await send({ action: "gptkProgress", command: "getAllMediaItems", requestId, itemsProcessed: 1 }, bridge)
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(count)
  })

  it("stops a mutation when the account changes during a batch", async () => {
    await healthCheck()
    await send({ action: "gptkCommand", command: "trashItems", requestId: "move", args: { dedupKeys: ["a"] }, accountEmail: session.account })
    const requestId = chromeMock.tabs.sendMessage.mock.calls.find(([, m]) =>
      m.action === "gptkCommand"
    )?.[1].requestId
    chromeMock.scripting.executeScript.mockResolvedValue([{
      frameId: 0, documentId: "photos-doc", result: { ...session, account: "changed@example.test" },
    }])
    const acknowledged = await send({ action: "gptkProgress", command: "trashItems", requestId, itemsProcessed: 1 }, bridge)
    expect(acknowledged).toBe(false)
    expect(chromeMock.tabs.sendMessage).toHaveBeenLastCalledWith(
      20, expect.objectContaining({ requestId: "move", success: false }), appTarget
    )
  })

  it("cancels album details while the document check is still in flight", async () => {
    await healthCheck()
    let continueProbe: (value: unknown) => void = () => {}
    chromeMock.scripting.executeScript.mockImplementationOnce(() => new Promise(resolve => {
      continueProbe = resolve
    }))
    const requestId = "cancelled-details"
    const started = send({ action: "gptkCommand", command: "getItemDetails", requestId, args: { mediaKeys: ["a"] } })
    await vi.waitFor(() => expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(2))
    await send({ action: "gptkCancel", requestId })
    continueProbe([{ frameId: 0, documentId: "photos-doc", result: session }])
    await started
    expect(chromeMock.tabs.sendMessage.mock.calls.some(([, message]) => message.action === "gptkCommand")).toBe(false)
  })
})
