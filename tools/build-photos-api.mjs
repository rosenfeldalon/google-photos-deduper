import { build } from "esbuild"

await build({
  stdin: {
    contents: 'export { default } from "./Google-Photos-Toolkit/src/api/api.ts"',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  globalName: "photosApiBundle",
  minify: true,
  drop: ["console"],
  outfile: "scripts/photos-api.generated.mjs",
  // The shim binds GPTK to this command's session through the factory closure.
  banner: { js: "export function createPhotosApi(gpdPhotosSession) {" },
  footer: { js: "return new photosApiBundle.default(); }" },
  plugins: [{
    name: "request-local-photos-session",
    setup(builder) {
      builder.onResolve({ filter: /^\.\.\/windowGlobalData$/ }, () => ({
        path: "photos-session",
        namespace: "gpd-session",
      }))
      builder.onLoad({ filter: /.*/, namespace: "gpd-session" }, () => ({
        contents: "export const windowGlobalData = gpdPhotosSession;",
      }))
    },
  }],
})
