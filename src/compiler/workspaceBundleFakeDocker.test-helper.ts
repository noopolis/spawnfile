import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A stand-in `docker` for bundle tests. It understands only the
 * `docker run` shape bundle steps emit, records every invocation, maps
 * container paths back to their host mounts and runs the step on the host.
 * `npm ci` is simulated offline from package-lock.json: each locked package
 * gets a package.json, a locked `bin` gets a `.bin` symlink, and npm's
 * hidden lockfile is written, so tests exercise archiving without a registry.
 */
const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\n");
if (args[0] === "rm") process.exit(0);
if (args[0] !== "run") process.exit(64);
const mounts = [], env = {}; let platform = "", workdir = "/", index = 1;
for (; index < args.length; index += 1) {
  const flag = args[index];
  if (flag === "--rm") continue;
  if (flag === "--platform") platform = args[++index];
  else if (flag === "--user" || flag === "--network" || flag === "--name") index += 1;
  else if (flag === "--volume") { const value = args[++index], at = value.lastIndexOf(":"); mounts.push([value.slice(at + 1), value.slice(0, at)]); }
  else if (flag === "--workdir") workdir = args[++index];
  else if (flag === "--env") { const value = args[++index], at = value.indexOf("="); env[value.slice(0, at)] = value.slice(at + 1); }
  else break;
}
const image = args[index], argv = args.slice(index + 1);
if (!/@sha256:[a-f0-9]{64}$/.test(image) || !/^linux\/(amd64|arm64)$/.test(platform)) process.exit(65);
const host = (value) => { for (const [container, source] of mounts) if (value === container || value.startsWith(container + "/")) return source + value.slice(container.length); return value; };
const cwd = host(workdir);
if (argv[0] === "npm" && argv[1] === "ci") {
  const lock = JSON.parse(fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8"));
  const omitDev = argv.includes("--omit=dev");
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || (omitDev && entry.dev)) continue;
    fs.mkdirSync(path.join(cwd, location), { recursive: true });
    fs.writeFileSync(path.join(cwd, location, "package.json"), JSON.stringify({ name: location.split("node_modules/").pop(), version: entry.version, platform }));
    for (const [name, target] of Object.entries(entry.bin || {})) {
      fs.writeFileSync(path.join(cwd, location, target), "#!/bin/sh\n", { mode: 0o755 });
      const bin = path.join(cwd, path.dirname(location), ".bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.symlinkSync(path.relative(bin, path.join(cwd, location, target)), path.join(bin, name));
    }
  }
  fs.writeFileSync(path.join(cwd, "node_modules", ".package-lock.json"), "{}");
  process.exit(0);
}
const mapped = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, host(value)]));
const result = spawnSync(argv[0], argv.slice(1).map(host), { cwd, env: { ...process.env, ...mapped }, stdio: "inherit" });
process.exit(result.status === null ? 70 : result.status);
`;

export interface FakeDocker {
  command: string;
  invocations: () => Promise<string[][]>;
}

export const createFakeDocker = async (directory: string): Promise<FakeDocker> => {
  const command = path.join(directory, "fake-docker"), log = path.join(directory, "fake-docker.log");
  await writeFile(command, SCRIPT);
  await chmod(command, 0o755);
  await writeFile(log, "");
  process.env.FAKE_DOCKER_LOG = log;
  return {
    command,
    invocations: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
  };
};
