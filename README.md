# Google Photos Deduper

[![CI Badge](https://github.com/mtalcott/google-photos-deduper/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mtalcott/google-photos-deduper/actions/workflows/ci.yml?query=branch%3Amain)

A Chrome extension that finds and removes duplicate photos from your Google Photos library.

Uses [Google Photos Toolkit (GPTK)](https://github.com/xob0t/Google-Photos-Toolkit) to access your library via Google Photos' web interface. Built with [Plasmo](https://plasmo.com/), [MediaPipe](https://developers.google.com/mediapipe), [React](https://react.dev/), and [MUI](https://mui.com/). 

## Demo

[![Demo](https://google-photos-deduper-public.s3.amazonaws.com/demo-2026-l.webp?1)](https://youtu.be/SeOX98uTVwQ)

## Install

Build this fork using the [setup instructions](#setup) below. To install a published upstream release, [download the upstream ZIP](https://github.com/mtalcott/google-photos-deduper/releases/latest/download/google-photos-deduper.zip).

1. Unzip to a permanent folder (don't delete it — Chrome needs it to stay there)
2. Open `chrome://extensions` → enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked** → select the unzipped folder
4. Pin the extension icon in your toolbar for easy access

## Usage

1. Open Google Photos in Chrome with the extension installed
2. Click the extension icon → **Open Deduper**
3. Click **Scan Library** to fetch your media items and find visually identical photos using local MediaPipe image embeddings
4. Review the duplicate groups and album details. You can stop here for a scan without changes to your library
5. To move selected copies to Trash, choose **Move to Trash** and review the confirmation

Album and ownership details load for photos in duplicate groups. Confirm the suggested Photos owner before selecting copies for trash. Partner, shared and unverified copies stay protected. Photos you own in a shared album require individual selection. Older scans without an associated account stay viewable and require a new scan before trash is available.

Trash moves are paced and can pause if Photos stops acknowledging batches. Use **Resume** to retry the remaining selection or **Stop** to return to the scan with acknowledged moves applied. If a batch timed out, check Photos before resuming.

The extension uses your signed-in Google Photos tab. There is no OAuth or Google Cloud project setup.

## Development

### Setup

Use Chrome 106 or later and Node.js 22. If you use nvm, run `nvm install` and `nvm use` from the repository root to select the version in `.nvmrc`.

For a new checkout, clone the fork's runbook branch. For an existing checkout of that branch or its merged changes, start in the repository root.

```bash
git clone --branch docs/fork-runbook https://github.com/rosenfeldalon/google-photos-deduper.git
cd google-photos-deduper
```

```bash
git submodule update --init --recursive
npm ci
npm run build
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked**. Choose `build/chrome-mv3-prod/` in this checkout. After rebuilding, click **Reload** on the extension card, then refresh your Google Photos tab and reopen the deduper from the toolbar.

### Development commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Watches for changes and builds into `build/chrome-mv3-dev/`. Load that folder for development. |
| `npm run build` | Builds the production extension into `build/chrome-mv3-prod/`. |
| `npm run package` | Builds the extension and writes `build/chrome-mv3-prod.zip`. |
| `npm run verify:worker` | Checks the committed worker against a fresh build without changing it. |
| `npm run build:worker` | Regenerates `scripts/embedder-worker.js` after worker source changes. |
| `npm test` | Runs unit and component tests. |
| `npm run test:watch` | Runs unit and component tests in watch mode. |
| `npm run test:bench` | Runs the benchmarks. |
| `npx tsc --noEmit` | Checks the extension's TypeScript. |

To check the pinned Toolkit separately, install its locked dependencies first.

```bash
npm ci --prefix Google-Photos-Toolkit
npm --prefix Google-Photos-Toolkit run typecheck
```

See [Photos bridge security](docs/bridge-security.md) for the command and session boundary.

### Mocked Chrome integration tests

Run these from the repository root. The suite launches an isolated Chromium profile and uses a mock Photos service. It requires no Google account.

```bash
npm run build
npx playwright install chromium
npm run test:integration
```

### Live Google Photos tests

The full E2E suite can move photos to Trash and attempt to undo the move. Run it only against a disposable Google Photos test account containing expendable copies. It connects to a running Chrome instance via the [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/). Start a dedicated Chrome profile with remote debugging.

**macOS:**
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-debug"
```

**Windows [WSL](https://learn.microsoft.com/en-us/windows/wsl/):**
```bash
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="C:\Users\<you>\Chrome Profiles\chrome-debug"
```

Load the unpacked build in that profile, sign into the disposable account at Google Photos, then run `npm run test:e2e` from the repository root.

## Motivation

Google deprecated the Photos Library API's write access in 2025, and duplicate detection has never been a built-in Google Photos feature. This extension uses [@xob0t](https://github.com/xob0t)'s [Google Photos Toolkit (GPTK)](https://github.com/xob0t/Google-Photos-Toolkit) — an open-source wrapper around Google Photos' undocumented web API — to access your library without OAuth, and runs MediaPipe's MobileNet V3 image embedder locally to find visually identical photos.

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/mtalcott/google-photos-deduper/issues/new/choose).

Have questions? [Post on the discussions page](https://github.com/mtalcott/google-photos-deduper/discussions).

## Say Thanks

If you found this project useful, give it a star!
