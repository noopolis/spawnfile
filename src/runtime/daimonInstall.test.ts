import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./daimon/contractManifest.js";
import { createDaimonInstallCommands } from "./daimonInstall.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "daimon-install-"));
  directories.push(root);
  const receipt = JSON.stringify({ manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256 });
  writeFileSync(path.join(root, "capability-receipt.json"), receipt);
  writeFileSync(path.join(root, "contract-manifest.json"), readFileSync(new URL("./daimon/contract-manifest.json", import.meta.url)));
  writeFileSync(path.join(root, "contract-manifest.sha256"), DAIMON_CONTRACT_MANIFEST_SHA256);
  // Portable local stand-ins for the Linux tools; hashes are calculated from actual fixture bytes.
  // The CommonJS marker keeps the extensionless stub CommonJS even when TMPDIR sits inside an ESM package.
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}\n');
  writeFileSync(path.join(root, "dpkg"), "#!/bin/sh\nprintf '%s\\n' amd64\n", { mode: 0o755 });
  writeFileSync(path.join(root, "sha256sum"), `#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto');
console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);
`, { mode: 0o755 });
  const digest = `sha256:${createHash("sha256").update(receipt).digest("hex")}`;
  const commands = createDaimonInstallCommands(root, { amd64: digest, arm64: `sha256:${"0".repeat(64)}` });
  const run = (command: string) => spawnSync("/bin/sh", ["-c", command], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, encoding: "utf8"
  }).status;
  return { root, commands, run };
};

it("executes matching per-architecture receipt and manifest verification", () => {
  const { commands, run } = fixture();
  expect(run(commands[0]!)).toBe(0);
  expect(run(commands[1]!)).toBe(0);
  execFileSync("/bin/sh", ["-n", "-c", commands.join(" && ")]);
});

it("refuses missing and mismatched copied receipts", () => {
  const { root, commands, run } = fixture();
  writeFileSync(path.join(root, "capability-receipt.json"), '{"manifest_sha256":"wrong"}');
  expect(run(commands[0]!)).not.toBe(0);
  rmSync(path.join(root, "capability-receipt.json"));
  expect(run(commands[0]!)).not.toBe(0);
});

it("refuses manifest byte drift, digest drift, and receipt/manifest disagreement", () => {
  const { root, commands, run } = fixture();
  const manifest = path.join(root, "contract-manifest.json");
  const bytes = readFileSync(manifest);
  writeFileSync(manifest, "{}");
  expect(run(commands[1]!)).not.toBe(0);
  writeFileSync(manifest, bytes);
  writeFileSync(path.join(root, "contract-manifest.sha256"), `sha256:${"0".repeat(64)}`);
  expect(run(commands[1]!)).not.toBe(0);
  writeFileSync(path.join(root, "contract-manifest.sha256"), DAIMON_CONTRACT_MANIFEST_SHA256);
  writeFileSync(path.join(root, "capability-receipt.json"), '{"manifest_sha256":"wrong"}');
  expect(run(commands[1]!)).not.toBe(0);
});
