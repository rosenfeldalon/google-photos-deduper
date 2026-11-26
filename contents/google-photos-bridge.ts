import type { PlasmoCSConfig } from "plasmo"
import { executePhotosCommand } from "../lib/photos-commands"
import { isInternalRequestId, parsePhotosCommand, parsePhotosSession } from "../lib/photos-protocol"
import type { IsolatedPhotosCommand, PhotosReply } from "../lib/photos-protocol"
import { APP_ID } from "../lib/types"
import { createPhotosApi } from "../scripts/photos-api.generated.mjs"

export const config: PlasmoCSConfig = {
  matches: ["https://photos.google.com/*"],
  run_at: "document_idle",
}

function fromWorker(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false
  const background = chrome.runtime.getManifest().background
  const worker = background && "service_worker" in background ? background.service_worker : undefined
  return sender.url === undefined || (worker !== undefined && sender.url === chrome.runtime.getURL(worker))
}

async function deliver(reply: PhotosReply): Promise<void> {
  // The service worker acknowledges only a pending command from this document.
  // A transport failure or a stale command stops subsequent RPC batches.
  if (await chrome.runtime.sendMessage(reply) !== true) throw new Error("Photos response was not acknowledged.")
}

async function run(message: IsolatedPhotosCommand): Promise<void> {
  const { command, args, requestId } = message
  const session = parsePhotosSession(message.session)
  const request = parsePhotosCommand(command, args)
  if (!session || !request || request.command === "healthCheck") {
    await deliver({
      app: APP_ID, action: "gptkResult", command, requestId, success: false,
      error: "The Photos bridge requires a valid session and command.",
    })
    return
  }
  await executePhotosCommand(request, requestId, session.path, createPhotosApi(session), deliver)
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.app !== APP_ID || !fromWorker(sender)) return
  if (message.action === "photosProbe") {
    respond(true)
    return
  }
  if (message.action !== "gptkCommand" || !isInternalRequestId(message.requestId)) return
  void run(message).then(() => respond(), () => respond())
  return true
})
