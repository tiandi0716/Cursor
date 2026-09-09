#!/usr/bin/env node
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("electron-dist", { recursive: true });

await build({
  entryPoints: ["electron/main.ts"],
  outfile: "electron-dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  external: ["electron"],
});

await build({
  entryPoints: ["electron/preload.ts"],
  outfile: "electron-dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});

console.log("electron-dist ready");
