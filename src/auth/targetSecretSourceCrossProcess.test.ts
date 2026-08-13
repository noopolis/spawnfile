import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCanonicalTargetSecretSourceJson } from "./targetSecretSourceRecordCommon.js";
import { parseTargetSecretSourceAuthorization } from "../target/dockerSecretsAuthority.js";
import {
  TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION,
  TARGET_SECRET_SOURCE_REQUEST_VERSION
} from "../cli/targetSecretSourceInput.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
const cwd = path.resolve(import.meta.dirname, "../..");
const cli = path.join(cwd, "src/cli/index.ts");
const resolverProgram = `
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { initializeTargetSecretSourceResolver } from "./src/auth/index.ts";
import { parseTargetSecretSourceAuthorization } from "./src/target/dockerSecretsAuthority.ts";
let value;
try {
  const authorization = parseTargetSecretSourceAuthorization(JSON.parse(await readFile(process.argv[1], "utf8")));
  const resolver = await initializeTargetSecretSourceResolver();
  const result = await resolver.resolve({ authorization });
  value = result.value;
  process.stdout.write(JSON.stringify({
    authorization: result.authorization,
    value_digest: "sha256:" + createHash("sha256").update(value).digest("hex")
  }) + "\\n");
} catch {
  process.stderr.write("resolution failed\\n");
  process.exitCode = 1;
} finally {
  value?.fill(0);
}`;
type ProcessResult = Readonly<{ code: number; stderr: string; stdout: string }>;
const run = (
  args: readonly string[],
  home: string,
  input?: Uint8Array
): Promise<ProcessResult> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, SPAWNFILE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.on("error", reject);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.on("close", (code) => {
    clearTimeout(timeout);
    resolve({
      code: code ?? -1,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8")
    });
  });
  child.stdin.end(input);
});
const runCli = (home: string, args: readonly string[], input?: Uint8Array) =>
  run(["--import", "tsx", cli, ...args], home, input);
const runResolver = (home: string, authorizationFile: string) =>
  run(["--import", "tsx", "--input-type=module", "-e", resolverProgram, authorizationFile], home);
const receipt = (result: ProcessResult): { kind: string; source_handle: string; version: string } => {
  expect(result.code, JSON.stringify(result)).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.endsWith("\n\n")).toBe(false);
  return JSON.parse(result.stdout) as { kind: string; source_handle: string; version: string };
};
const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const authorization = (sourceHandle: string, operation: string, request: string) => ({
  descriptorDigest: `sha256:${"a".repeat(64)}`,
  name: "token",
  operationHandle: `opaque_${operation.repeat(16)}`,
  requestDigest: `sha256:${request.repeat(64)}`,
  runId: "run-1",
  scope: "world",
  selectedTarget: {
    fingerprint: `sha256:${"b".repeat(32)}`,
    handle: `opaque_${"09".repeat(16)}`
  },
  sourceHandle,
  version: "spawnfile.target-secret-source.authorization.v1"
});
const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  }));
  return nested.flat();
};

describe("target secret source cross-process lifecycle", () => {
  it("survives restarts without leaking values or private version handles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-secret-cross-process-"));
    cleanup.push(directory);
    const home = path.join(directory, "home");
    const requests = path.join(directory, "requests");
    await mkdir(home, { mode: 0o700 });
    await mkdir(requests);
    const oldSecret = new TextEncoder().encode("OLD_SENTINEL_cross_process");
    const newSecret = new TextEncoder().encode("NEW_SENTINEL_cross_process");
    const allOutput: ProcessResult[] = [];

    const authoredResult = await runCli(home, ["auth", "target-secret", "author"], oldSecret);
    allOutput.push(authoredResult);
    const authored = receipt(authoredResult);
    const grantFile = path.join(requests, "grant.json");
    await writeFile(grantFile, createCanonicalTargetSecretSourceJson({
      grant: {
        descriptor_digest: `sha256:${"a".repeat(64)}`,
        name: "token",
        run_id: "run-1",
        scope: "world",
        selected_target: {
          fingerprint: `sha256:${"b".repeat(32)}`,
          handle: `opaque_${"09".repeat(16)}`,
          version: "spawnfile.target-resource.selected-target.v1"
        },
        source_handle: authored.source_handle
      },
      version: TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION
    }));
    const grantedResult = await runCli(home, ["auth", "target-secret", "grant", grantFile]);
    allOutput.push(grantedResult);
    expect(receipt(grantedResult).source_handle).toBe(authored.source_handle);

    const oldAuthorizationFile = path.join(requests, "old-authorization.json");
    await writeFile(oldAuthorizationFile, JSON.stringify(authorization(authored.source_handle, "0a", "c")));
    const firstResolution = await runResolver(home, oldAuthorizationFile);
    const replayResolution = await runResolver(home, oldAuthorizationFile);
    allOutput.push(firstResolution, replayResolution);
    expect(firstResolution).toEqual(replayResolution);
    const resolved = JSON.parse(firstResolution.stdout) as Record<string, unknown>;
    expect(Object.keys(resolved).sort()).toEqual(["authorization", "value_digest"]);
    expect(parseTargetSecretSourceAuthorization(resolved.authorization)).toEqual(resolved.authorization);
    expect(resolved.value_digest).toBe(digest(oldSecret));
    expect(resolved).not.toHaveProperty("value");
    expect(resolved).not.toHaveProperty("sourceVersionHandle");
    expect(firstResolution.stdout).not.toContain("source_version");

    const differentAuthorizationFile = path.join(requests, "different-authorization.json");
    await writeFile(differentAuthorizationFile, JSON.stringify(authorization(authored.source_handle, "0a", "d")));
    const different = await runResolver(home, differentAuthorizationFile);
    allOutput.push(different);
    expect(different.code).toBe(1);

    const oldSourceFile = path.join(requests, "old-source.json");
    await writeFile(oldSourceFile, createCanonicalTargetSecretSourceJson({
      source_handle: authored.source_handle,
      version: TARGET_SECRET_SOURCE_REQUEST_VERSION
    }));
    const rotatedResult = await runCli(home, ["auth", "target-secret", "rotate", oldSourceFile], newSecret);
    allOutput.push(rotatedResult);
    const rotated = receipt(rotatedResult);
    expect(rotated.source_handle).not.toBe(authored.source_handle);
    const newAuthorizationFile = path.join(requests, "new-authorization.json");
    await writeFile(newAuthorizationFile, JSON.stringify(authorization(rotated.source_handle, "0b", "e")));
    const newResolution = await runResolver(home, newAuthorizationFile);
    allOutput.push(newResolution);
    expect((JSON.parse(newResolution.stdout) as Record<string, unknown>).value_digest).toBe(digest(newSecret));

    const newSourceFile = path.join(requests, "new-source.json");
    await writeFile(newSourceFile, createCanonicalTargetSecretSourceJson({
      source_handle: rotated.source_handle,
      version: TARGET_SECRET_SOURCE_REQUEST_VERSION
    }));
    allOutput.push(await runCli(home, ["auth", "target-secret", "revoke-grant", oldSourceFile]));
    allOutput.push(await runCli(home, ["auth", "target-secret", "revoke-version", newSourceFile]));
    expect(receipt(allOutput.at(-2)!).kind).toBe("revoke-grant");
    expect(receipt(allOutput.at(-1)!).kind).toBe("revoke-version");
    const revokedOld = await runResolver(home, oldAuthorizationFile);
    const revokedNew = await runResolver(home, newAuthorizationFile);
    allOutput.push(revokedOld, revokedNew);
    expect(revokedOld.code).toBe(1);
    expect(revokedNew.code).toBe(1);

    const sentinels = ["OLD_SENTINEL_cross_process", "NEW_SENTINEL_cross_process"];
    for (const output of allOutput) for (const sentinel of sentinels) {
      expect(output.stdout).not.toContain(sentinel);
      expect(output.stderr).not.toContain(sentinel);
      expect(output.stdout).not.toContain("sourceVersionHandle");
      expect(output.stdout).not.toContain("source_version_handle");
      expect(output.stderr).not.toContain("sourceVersionHandle");
      expect(output.stderr).not.toContain("source_version_handle");
    }
    for (const file of await walk(requests)) {
      const text = await readFile(file, "utf8");
      for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
      expect(text).not.toContain("source_version_handle");
    }
    const storeFiles = await walk(path.join(home, "auth", "target-secrets"));
    const recovered: string[] = [];
    for (const file of storeFiles) {
      const info = await stat(file);
      expect(info.mode & 0o777).toBe(0o600);
      const text = await readFile(file, "utf8");
      const relative = path.relative(path.join(home, "auth", "target-secrets"), file);
      if (relative.startsWith(`versions${path.sep}`)) {
        const record = JSON.parse(text) as { secret: string };
        recovered.push(Buffer.from(record.secret, "base64").toString("utf8"));
      } else {
        for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
      }
    }
    expect(recovered.sort()).toEqual(sentinels.sort());
    oldSecret.fill(0);
    newSecret.fill(0);
  }, 30_000);
});
