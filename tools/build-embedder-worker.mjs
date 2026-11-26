import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "esbuild"

const output = "scripts/embedder-worker.js"
const verify = process.argv.includes("--verify")
const temporary = verify ? await mkdtemp(join(tmpdir(), "gpd-worker-")) : undefined
const target = temporary ? join(temporary, "embedder-worker.js") : output

try {
  await build({
    entryPoints: ["workers/embedder.worker.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    outfile: target,
  })
  if (verify) {
    const [committed, rebuilt] = await Promise.all([readFile(output), readFile(target)])
    if (!committed.equals(rebuilt)) {
      console.error("The embedder worker bundle is out of date. Run npm run build:worker and include the regenerated file.")
      process.exitCode = 1
    } else {
      console.log("The embedder worker bundle matches its source.")
    }
  }
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true })
}
