import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { APP_ID } from "../../lib/types"

const api = vi.hoisted(() => ({
  getItemsByTakenDate: vi.fn(),
  moveItemsToTrash: vi.fn(),
  restoreFromTrash: vi.fn(),
}))
const createApi = vi.hoisted(() => vi.fn(() => api))
vi.mock("../../scripts/photos-api.generated.mjs", () => ({ createPhotosApi: createApi }))

let listener: (message: unknown, sender: chrome.runtime.MessageSender, respond: (value?: unknown) => void) => boolean | void
const worker = { id: "test", url: "chrome-extension://test/background.worker.js" }
const sendMessage = vi.fn()
const session = { account: "fixture@example.test", "f.sid": "123", bl: "version", path: "/", at: "test-data" }
const request = {
  app: APP_ID,
  action: "gptkCommand",
  command: "trashItems",
  args: { dedupKeys: ["fixture-key"] },
  requestId: "f".repeat(32),
  session,
}

function receive(message: unknown, sender: chrome.runtime.MessageSender = worker) {
  return new Promise(resolve => {
    if (listener(message, sender, resolve) !== true) resolve(undefined)
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  sendMessage.mockResolvedValue(true)
  api.moveItemsToTrash.mockResolvedValue(undefined)
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getManifest: () => ({ background: { service_worker: "background.worker.js" } }),
      sendMessage,
      onMessage: {
        addListener: (callback: typeof listener) => { listener = callback },
      },
    },
  })
  await import("../../contents/google-photos-bridge")
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("isolated Photos bridge", () => {
  it("responds to an authenticated reachability probe", async () => {
    expect(await receive({ app: APP_ID, action: "photosProbe" })).toBe(true)
  })

  it.each([
    { ...worker, id: "different-extension" },
    { ...worker, tab: { id: 10 } as chrome.tabs.Tab },
    { ...worker, url: "chrome-extension://test/tabs/app.html" },
  ])("rejects a command from an untrusted sender (%j)", async sender => {
    await receive(request, sender)
    expect(createApi).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("ignores every page-window message and leaves no API globals", async () => {
    const postMessage = vi.spyOn(window, "postMessage")
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { ...request, session: undefined } }))
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { ...request, action: "gptkResult" } }))
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { ...request, action: "gptkProgress" } }))
    for (const key of ["gptkApi", "gptkCore", "gptkApiUtils", "unsafeWindow"]) {
      expect(Object.hasOwn(window, key)).toBe(false)
    }
    expect(postMessage).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(createApi).not.toHaveBeenCalled()
  })

  it("requires a valid request ID, session and command payload", async () => {
    await receive({ ...request, requestId: "bad" })
    await receive({ ...request, session: undefined })
    await receive({ ...request, args: { dedupKeys: ["fixture-key", "fixture-key"] } })
    await receive({ ...request, command: "unknown" })
    expect(createApi).not.toHaveBeenCalled()
    expect(sendMessage.mock.calls.map(([reply]) => reply.success)).toEqual([false, false, false])
  })

  it("executes with a request-local session and replies directly to the worker", async () => {
    const postMessage = vi.spyOn(window, "postMessage")
    await receive(request)
    expect(createApi).toHaveBeenCalledExactlyOnceWith(session)
    expect(api.moveItemsToTrash).toHaveBeenCalledExactlyOnceWith(["fixture-key"])
    expect(sendMessage.mock.calls.map(([reply]) => [reply.action, reply.requestId])).toEqual([
      ["gptkProgress", request.requestId], ["gptkResult", request.requestId],
    ])
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain(session.at)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it.each(["rejected", "thrown", "stale"])("halts remaining batches after a %s acknowledgement", async failure => {
    if (failure === "rejected") sendMessage.mockRejectedValueOnce(new Error("send failed"))
    else if (failure === "thrown") sendMessage.mockImplementationOnce(() => { throw new Error("send failed") })
    else sendMessage.mockResolvedValueOnce(false)

    await receive({
      ...request, args: { dedupKeys: Array.from({ length: 252 }, (_, index) => "fixture-key-" + index) },
    })
    expect(api.moveItemsToTrash).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "gptkResult", requestId: request.requestId, success: false,
    }))
  })
})
