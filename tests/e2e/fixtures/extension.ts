/**
 * Shared helpers for all E2E tests.
 * Handles extension launch, storage injection, and GP auth cookie injection.
 */
import { chromium, type BrowserContext, type Page } from "@playwright/test"
import path from "path"
import fs from "fs"
import type { DuplicateGroup, GpdMediaItem } from "../../../lib/types"

export const extensionPath = path.resolve(__dirname, "../../../build/chrome-mv3-dev")

// ============================================================
// Connect to an already-running Chrome (full E2E only)
// ============================================================

/**
 * Connect to an existing Chrome instance via CDP instead of launching a new one.
 * Used for full E2E tests: avoids Google session invalidation that occurs when
 * cookies are transferred to a new browser (Google binds sessions to device fingerprint).
 *
 * Prerequisites:
 *   Chrome must be running with --remote-debugging-port=9222 AND the extension
 *   loaded (build/chrome-mv3-dev/). The user must be logged into Google Photos.
 *
 *   WSL launch:
 *     "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
 *       --remote-debugging-port=9222
 *       --user-data-dir="C:\Users\mackt\Chrome Profiles\chrome-debug"
 *
 * After tests, browser.close() only disconnects Playwright — Chrome stays open.
 */
export async function connectToChrome(
  cdpUrl = process.env.CDP_URL || "http://localhost:9222"
): Promise<{ browser: import("@playwright/test").Browser; context: BrowserContext; extensionId: string }> {
  let browser: import("@playwright/test").Browser
  try {
    browser = await chromium.connectOverCDP(cdpUrl)
  } catch {
    throw new Error(
      `Could not connect to Chrome at ${cdpUrl}.\n` +
      `Start Chrome with remote debugging:\n` +
      `  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \\\n` +
      `    --remote-debugging-port=9222 \\\n` +
      `    --user-data-dir="C:\\\\Users\\\\mackt\\\\Chrome Profiles\\\\chrome-debug"`
    )
  }

  const context = browser.contexts()[0]
  if (!context) throw new Error("No browser context found in connected Chrome.")

  // Discover extension ID from service workers.
  // Try SW first (fastest and most reliable), then fall back to open extension pages.
  let extensionId = ""

  const sws = context.serviceWorkers()
  const gpdSw = sws.find((sw) => sw.url().includes("background"))
  if (gpdSw) {
    extensionId = new URL(gpdSw.url()).hostname
  }

  // Fallback: scan already-open extension pages (app tab may be open from prior run)
  if (!extensionId) {
    for (const page of context.pages()) {
      const url = page.url()
      // Must be a chrome-extension:// URL with a proper 32-char extension ID
      if (url.startsWith("chrome-extension://") && new URL(url).hostname.length === 32) {
        extensionId = new URL(url).hostname
        break
      }
    }
  }

  if (!extensionId) {
    throw new Error(
      "Could not find the extension ID.\n" +
      "Make sure the extension is loaded in Chrome (build/chrome-mv3-dev/)."
    )
  }

  return { browser, context, extensionId }
}

// ============================================================
// Extension launch
// ============================================================

export async function launchExtension(): Promise<{
  context: BrowserContext
  extensionId: string
}> {
  const context = await chromium.launchPersistentContext("", {
    headless: Boolean(process.env.GPD_TEST_CHROMIUM),
    executablePath: process.env.GPD_TEST_CHROMIUM || undefined,
    args: [
      "--disable-background-networking",
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
    ],
  })

  await context.route(/^https?:\/\//, route => route.abort("blockedbyclient"))
  let sw = context.serviceWorkers()[0]
  if (!sw) sw = await context.waitForEvent("serviceworker")
  const extensionId = new URL(sw.url()).hostname

  return { context, extensionId }
}

export function openAppTab(context: BrowserContext, extensionId: string): Promise<Page> {
  return context.newPage().then((page) => {
    return page
      .goto(`chrome-extension://${extensionId}/tabs/app.html`)
      .then(() => page)
  })
}

// ============================================================
// Storage helpers (via service worker)
// ============================================================

export async function injectScanResults(
  context: BrowserContext,
  groups: object[],
  mediaItems: Record<string, object>,
  totalItems: number
): Promise<void> {
  const sw = context.serviceWorkers()[0]
  await sw.evaluate(
    ({ groups, mediaItems, totalItems }) =>
      new Promise<void>((resolve) => {
        chrome.storage.local.set(
          {
            scanResults: { groups, mediaItems, totalItems, scanDate: Date.now(), accountEmail: "test@example.com" },
            "photosOwner:test@example.com": { actorId: "fixture-owner" },
          },
          resolve
        )
      }),
    { groups, mediaItems, totalItems }
  )
}

export async function injectSelections(
  context: BrowserContext,
  selectedGroupIds: string[],
  keptOverrides: Record<string, string[]> = {}
): Promise<void> {
  const sw = context.serviceWorkers()[0]
  await sw.evaluate(
    ({ selectedGroupIds, keptOverrides }) =>
      new Promise<void>((resolve) => {
        chrome.storage.local.set({ selections: { selectedGroupIds, keptOverrides } }, resolve)
      }),
    { selectedGroupIds, keptOverrides }
  )
}

export async function clearStorage(context: BrowserContext): Promise<void> {
  let sw = context.serviceWorkers()[0]
  if (!sw) {
    try {
      sw = await context.waitForEvent("serviceworker", { timeout: 5_000 })
    } catch {
      // No service worker available (e.g. CDP context without extension SW registered yet)
      // Skip storage clear — tests must handle stale state themselves
      return
    }
  }
  await sw.evaluate(() => new Promise<void>((resolve) => chrome.storage.local.clear(resolve)))
}

// ============================================================
// Google Photos auth (full E2E only)
// ============================================================

/**
 * Inject Google Photos auth cookies into the browser context.
 * Reads from GP_AUTH_COOKIES env var (base64 JSON, for CI) or
 * .gp-auth.json file (for local dev).
 *
 * To generate .gp-auth.json: npm run auth:export
 * To set up CI: base64 -w0 .gp-auth.json → paste as GP_AUTH_COOKIES secret
 */
export async function injectGpAuth(context: BrowserContext): Promise<void> {
  const cookies = loadGpCookies()
  await context.addCookies(cookies)
}

// ============================================================
// GPTK stub helpers (integration tests)
// ============================================================

interface GptkOverrides {
  healthCheck?: { data: { accountEmail: string } }
  getAllMediaItems?: { itemCount: number }
  trashItems?: { success: false; error: string }
  restoreItems?: { success: false; error: string }
}

/** Serve synthetic Photos HTML and replies for the pinned toolkit's API parser. */
export async function openGptkStubPage(
  context: BrowserContext,
  overrides: GptkOverrides = {}
): Promise<Page> {
  const account = overrides.healthCheck?.data.accountEmail ?? "test@example.com"
  const wiz = {
    oPEP7c: account, FdrFJe: "100", cfb2h: "fixture-version",
    eptZe: "/", SNlM0e: "fixture-only",
  }
  const page = await context.newPage()
  await page.route("https://photos.google.com/**", async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname !== "/data/batchexecute") {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Photos fixture</title>
          <script>window.WIZ_global_data = ${JSON.stringify(wiz)}</script>`,
      })
      return
    }

    const rpc = url.searchParams.get("rpcids")
    const form = new URLSearchParams(request.postData() ?? "")
    const requestData = JSON.parse(JSON.parse(form.get("f.req") ?? "[]")[0][0][1])
    let payload: unknown
    if (rpc === "lcxiM") {
      const count = overrides.getAllMediaItems?.itemCount ?? 0
      const cursor = Number(requestData[0] ?? 0)
      const end = Math.min(count, cursor + 500)
      const items = Array.from({ length: end - cursor }, (_, i) => {
        const n = cursor + i
        const timestamp = 1_600_000_000_000 - n
        return [`mk${n}`, ["https://fixture.invalid/thumb", 100, 100], timestamp, `dk${n}`, 0, timestamp, null, []]
      })
      payload = [items, end < count ? String(end) : null, null]
    } else if (rpc === "fDcn4b") {
      const row: unknown[] = []
      row[0] = requestData[0]
      row[12] = []
      row[19] = []
      row[27] = [2]
      const owner: unknown[] = ["fixture-owner"]
      owner[11] = ["Fixture Owner"]
      row[28] = owner
      payload = [row]
    } else if (rpc === "XwAOJf") {
      const failure = requestData[1] === 1 ? overrides.trashItems : overrides.restoreItems
      if (failure) {
        await route.fulfill({ status: Number(/HTTP (\d{3})/.exec(failure.error)?.[1]) || 500 })
        return
      }
      payload = [true]
    } else {
      await route.fulfill({ status: 400 })
      return
    }
    await route.fulfill({ json: [["wrb.fr", rpc, JSON.stringify(payload)]] })
  })
  await page.goto("https://photos.google.com/")
  return page
}

/**
 * Wait for a given text or pattern to become visible on the app tab.
 * Reloads the page once if not visible within `timeout / 2` ms, then waits again.
 * This handles the case where the app tab loads before the stub page is ready.
 */
export async function waitForAppState(
  page: Page,
  matcher: string | RegExp,
  timeout = 10_000
): Promise<void> {
  await page.waitForSelector(
    typeof matcher === "string"
      ? `text=${matcher}`
      : `:text-matches(${matcher.source}, ${matcher.flags || "i"})`,
    { timeout }
  )
}

/**
 * Build N duplicate groups where each group has `itemsPerGroup` items.
 * Returns both the groups array and a matching mediaItems record.
 *
 * Total dedupKeys = N * itemsPerGroup — useful for constructing payloads
 * that span multiple 250-item trash batches.
 */
export function makeGroups(
  groupCount: number,
  itemsPerGroup: number
): { groups: DuplicateGroup[]; mediaItems: Record<string, GpdMediaItem> } {
  const groups: DuplicateGroup[] = []
  const mediaItems: Record<string, GpdMediaItem> = {}

  for (let g = 0; g < groupCount; g++) {
    const mediaKeys: string[] = []
    for (let i = 0; i < itemsPerGroup; i++) {
      const key = `group${g}-item${i}`
      mediaKeys.push(key)
      mediaItems[key] = {
        mediaKey: key,
        dedupKey: `dedup-${key}`,
        thumb: "",
        productUrl: `https://photos.google.com/photo/${key}`,
        timestamp: 1_600_000_000_000 + g * 1000 + i,
        creationTimestamp: 1_700_000_000_000 + g * 1000 + i,
        resWidth: 1920,
        resHeight: 1080,
        fileName: `photo-${key}.jpg`,
        isOwned: true,
      }
    }
    groups.push({
      id: `group-${g}`,
      mediaKeys,
      originalMediaKey: mediaKeys[0],
      similarity: 0.95,
    })
  }

  return { groups, mediaItems }
}

// ============================================================
// Google Photos auth (full E2E only)
// ============================================================

function loadGpCookies() {
  if (process.env.GP_AUTH_COOKIES) {
    return JSON.parse(Buffer.from(process.env.GP_AUTH_COOKIES, "base64").toString("utf-8"))
  }
  const authFile = path.resolve(__dirname, "../../../.gp-auth.json")
  if (fs.existsSync(authFile)) {
    return JSON.parse(fs.readFileSync(authFile, "utf-8"))
  }
  throw new Error(
    "No GP auth cookies found.\n" +
    "  Local dev: run `npm run auth:export` to generate .gp-auth.json\n" +
    "  CI: set the GP_AUTH_COOKIES secret (see scripts/auth-export.mjs)"
  )
}
