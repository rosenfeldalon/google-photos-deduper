import type { GptkCommandMessage, GptkProgressMessage, GptkResultChunkMessage, GptkResultMessage } from "./types"

export const PHOTOS_ORIGIN = "https://photos.google.com"
export const MAX_RESULT_BYTES = 8 * 1024 * 1024
const MAX_KEYS = 10_000
export const MAX_DETAIL_KEYS = 100
const MAX_KEY_LENGTH = 1024
const MAX_SESSION_FIELD_LENGTH = 16_384

export interface PhotosSession {
  account: string
  "f.sid": string
  bl: string
  path: string
  at: string
}

export type PhotosCommand =
  | { command: "getAllMediaItems" }
  | { command: "healthCheck" }
  | { command: "getItemDetails"; mediaKeys: string[] }
  | { command: "trashItems"; dedupKeys: string[]; mediaKeysToTrash: string[]; mediaKeysPerDedup?: number[] }
  | { command: "restoreItems"; dedupKeys: string[] }

export interface IsolatedPhotosCommand extends GptkCommandMessage {
  session: PhotosSession
}

export type PhotosReply = GptkResultMessage | GptkResultChunkMessage | GptkProgressMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value.trim().length > 0
}

export function parsePhotosSession(value: unknown): PhotosSession | null {
  if (!isRecord(value)) return null
  const { account, "f.sid": sid, bl, path, at } = value
  if (
    !isBoundedString(account, 320) || !/^[^\s@]+@[^\s@]+$/.test(account) ||
    !isBoundedString(sid, MAX_SESSION_FIELD_LENGTH) ||
    !isBoundedString(bl, MAX_SESSION_FIELD_LENGTH) ||
    !isBoundedString(at, MAX_SESSION_FIELD_LENGTH) ||
    typeof path !== "string" || !/^\/(?:u\/\d{1,8}\/)?$/.test(path)
  ) return null

  return { account, "f.sid": sid, bl, path, at }
}

function parseKeys(keys: unknown, allowEmpty = false): string[] | null {
  if (!Array.isArray(keys) || keys.length > MAX_KEYS || (!allowEmpty && keys.length === 0)) return null
  const unique = new Set<string>()
  for (const key of keys) {
    if (!isBoundedString(key, MAX_KEY_LENGTH) || unique.has(key)) return null
    unique.add(key)
  }
  return keys
}

export function parsePhotosCommand(command: unknown, args: unknown): PhotosCommand | null {
  const options = args === undefined ? {} : args
  if (!isRecord(options)) return null
  const keys = Object.keys(options)

  switch (command) {
    case "healthCheck":
      return keys.length === 0 ? { command } : null
    case "getAllMediaItems": {
      if (keys.some(key => key !== "dateRange" && key !== "sinceTimestamp")) return null
      if (options.sinceTimestamp !== undefined && (
        typeof options.sinceTimestamp !== "number" || !Number.isFinite(options.sinceTimestamp)
      )) return null
      const range = options.dateRange
      if (range !== undefined && (
        !isRecord(range) ||
        Object.entries(range).some(([key, value]) =>
          (key !== "from" && key !== "to") ||
          (value !== undefined && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)))
        )
      )) return null

      // The existing scan still covers the library; date-range filtering is a separate feature.
      return { command }
    }
    case "getItemDetails": {
      if (keys.length !== 1 || keys[0] !== "mediaKeys" ||
          !Array.isArray(options.mediaKeys) || options.mediaKeys.length > MAX_DETAIL_KEYS) return null
      const mediaKeys = parseKeys(options.mediaKeys)
      return mediaKeys ? { command, mediaKeys } : null
    }
    case "restoreItems": {
      if (keys.some(key => key !== "dedupKeys")) return null
      const dedupKeys = parseKeys(options.dedupKeys)
      return dedupKeys ? { command, dedupKeys } : null
    }
    case "trashItems": {
      if (keys.some(key => key !== "dedupKeys" && key !== "mediaKeysToTrash" && key !== "mediaKeysPerDedup")) return null
      const dedupKeys = parseKeys(options.dedupKeys)
      const mediaKeysToTrash = parseKeys(options.mediaKeysToTrash ?? [], true)
      if (!dedupKeys || !mediaKeysToTrash || serializedSize(options) >= MAX_RESULT_BYTES / 2) return null
      const mediaKeysPerDedup = options.mediaKeysPerDedup
      if (mediaKeysPerDedup !== undefined) {
        if (!Array.isArray(mediaKeysPerDedup) || mediaKeysPerDedup.length !== dedupKeys.length ||
            !Array.from(mediaKeysPerDedup).every(count => Number.isSafeInteger(count) && count > 0) ||
            mediaKeysPerDedup.reduce((total, count) => total + count, 0) !== mediaKeysToTrash.length) return null
        return { command, dedupKeys, mediaKeysToTrash, mediaKeysPerDedup }
      }
      return { command, dedupKeys, mediaKeysToTrash }
    }
    default:
      return null
  }
}

export function createRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("")
}

export function isInternalRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value)
}

export function serializedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
