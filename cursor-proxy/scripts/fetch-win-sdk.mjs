#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const version = "1.0.31";
const names = ["@cursor/sdk-win32-x64", "@cursor/sdk-darwin-x64"];

for (const name of names) {
  const dest = `node_modules/${name}`;
  if (existsSync(`${dest}/package.json`)) {
    console.log(name, "already present");
    continue;
  }
  const spec = `${name}@${version}`;
  const tarball = execFileSync("npm", ["pack", spec], { encoding: "utf8" }).trim().split("\n").at(-1);
  if (!tarball) throw new Error(`npm pack produced no tarball for ${spec}`);
  await mkdir(dest, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
  await rm(tarball, { force: true });
  console.log("installed", spec);
}
