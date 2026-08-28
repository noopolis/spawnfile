#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GO_IMAGE = "golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac";
const fail = (message) => { throw new Error(message); };
const exact = (value, label) => { if (!value || !path.isAbsolute(value) || path.resolve(value) !== value) fail(`${label} must be normalized absolute`); return value; };

const run = (input, network, copyBack) => {
  const id = execFileSync("docker", ["create", "--platform", "linux/amd64", ...(network ? ["--network", network] : []), "--env", "GOMODCACHE=/closure/gomodcache", "--env", "GOCACHE=/closure/gobuildcache", GO_IMAGE, "sh", "-ceu", "cd /closure; go mod download; go mod verify; test \"$(go env GOOS)/$(go env GOARCH)\" = linux/amd64; tar -cf /tmp/closure.tar ."], { encoding: "utf8" }).trim();
  try { execFileSync("docker", ["cp", `${input}/.`, `${id}:/closure`]); execFileSync("docker", ["start", "--attach", id], { stdio: "inherit" }); if (copyBack) { const archive = path.join(copyBack, ".closure-transfer.tar"); execFileSync("docker", ["cp", `${id}:/tmp/closure.tar`, archive]); execFileSync("tar", ["-xf", archive, "-C", copyBack]); rmSync(archive); execFileSync("chmod", ["-R", "u+rwX", copyBack]); } }
  finally { execFileSync("docker", ["rm", "--force", id], { stdio: "ignore" }); }
};

export const createLinuxAmd64GoClosure = (sourcePath, outputPath) => {
  const source = exact(sourcePath, "source"), output = exact(outputPath, "output");
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) fail("source must be a real directory");
  if (existsSync(output) && readdirSync(output).length) fail("output must be absent or empty"); mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(path.join(os.tmpdir(), "spawnfile-go-closure-"));
  try { copyFileSync(path.join(source, "go.mod"), path.join(staging, "go.mod")); copyFileSync(path.join(source, "go.sum"), path.join(staging, "go.sum")); run(staging, undefined, output); run(output, "none"); }
  finally { rmSync(staging, { force: true, recursive: true }); }
  rmSync(path.join(output, "gobuildcache"), { force: true, recursive: true });
  return { image: GO_IMAGE, target: "linux/amd64" };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) fail("usage: create-linux-amd64-go-closure <absolute-moltnet-source> <absolute-output>");
  process.stdout.write(`${JSON.stringify(createLinuxAmd64GoClosure(process.argv[2], process.argv[3]))}\n`);
}
