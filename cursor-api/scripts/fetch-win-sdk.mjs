#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const version = "1.0.31";
const spec = `@cursor/sdk-win32-x64@${version}`;
const dest = "node_modules/@cursor/sdk-win32-x64";
if (existsSync(`${dest}/package.json`)) {
  console.log("win sdk already present");
  process.exit(0);
}

const tarball = execFileSync("npm", ["pack", spec], { encoding: "utf8" }).trim().split("\n").at(-1);
await mkdir(dest, { recursive: true });
execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
await rm(tarball, { force: true });
console.log("installed", spec);
