import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_TARGET_SECRET_SOURCE_SECRET_BYTES,
  createCanonicalTargetSecretSourceJson,
  parseTargetSecretSourceOpaqueHandle
} from "../auth/targetSecretSourceRecordCommon.js";
import {
  TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION,
  TARGET_SECRET_SOURCE_REQUEST_VERSION
} from "./targetSecretSourceInput.js";
import { runCli } from "./runCli.js";

const handle = (value: number) => parseTargetSecretSourceOpaqueHandle(`opaque_${value.toString(16).padStart(2, "0").repeat(16)}`);
const cleanup: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const stdin = (bytes: Uint8Array = new Uint8Array([7, 8])) => (async function* () { yield bytes; })();
const streams = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stderr, stdout, value: { stderr: (message: string) => stderr.push(message), stdout: (message: string) => stdout.push(message) } };
};
const lifecycle = () => ({
  author: vi.fn(async (_secret: Uint8Array) => ({ source_handle: handle(1) })),
  grant: vi.fn(async (input: { source_handle: ReturnType<typeof handle> }) => ({ source_handle: input.source_handle })),
  resolver: { resolve: vi.fn() },
  revokeGrant: vi.fn(async () => ({ kind: "grant" as const, source_handle: handle(1) })),
  revokeVersion: vi.fn(async () => ({ kind: "version" as const, source_handle: handle(1) })),
  rotate: vi.fn(async (_source: unknown, _secret: Uint8Array) => ({ source_handle: handle(2) }))
});
const requestFiles = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-secret-cli-"));
  cleanup.push(directory);
  const sourceFile = path.join(directory, "source.json");
  const grantFile = path.join(directory, "grant.json");
  await writeFile(sourceFile, createCanonicalTargetSecretSourceJson({
    source_handle: handle(1),
    version: TARGET_SECRET_SOURCE_REQUEST_VERSION
  }));
  await writeFile(grantFile, createCanonicalTargetSecretSourceJson({
    grant: {
      descriptor_digest: `sha256:${"a".repeat(64)}`,
      name: "token",
      run_id: "run-1",
      scope: "world",
      selected_target: {
        fingerprint: `sha256:${"b".repeat(32)}`,
        handle: handle(9),
        version: "spawnfile.target-resource.selected-target.v1"
      },
      source_handle: handle(1)
    },
    version: TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION
  }));
  return { grantFile, sourceFile };
};

describe("target secret CLI commands", () => {
  it("keeps help registration lazy and exposes no resolve-to-stdout command", async () => {
    const initialize = vi.fn();
    const output = streams();
    expect(await runCli(["auth", "target-secret", "--help"], {
      handlers: { initializeTargetSecretSourceLifecycle: initialize },
      stdin: stdin(),
      streams: output.value
    })).toBe(0);
    expect(initialize).not.toHaveBeenCalled();
    expect(output.stdout.join("\n")).not.toMatch(/\bresolve\b/u);
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-help-"));
    cleanup.push(directory);
    const absentHome = path.join(directory, "absent-home");
    process.env.SPAWNFILE_HOME = absentHome;
    expect(await runCli(["auth", "target-secret", "--help"], { stdin: stdin(), streams: output.value })).toBe(0);
    await expect(lstat(absentHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("authors from stdin, clears the passed buffer, and emits one canonical receipt", async () => {
    const service = lifecycle();
    const seen: Uint8Array[] = [];
    service.author.mockImplementation(async (secret) => { seen.push(secret); return { source_handle: handle(1) }; });
    const initialize = vi.fn(async () => service);
    const output = streams();
    expect(await runCli(["auth", "target-secret", "author"], {
      handlers: { initializeTargetSecretSourceLifecycle: initialize },
      stdin: stdin(new Uint8Array([1, 2, 3])),
      streams: output.value
    })).toBe(0);
    expect(initialize).toHaveBeenCalledOnce();
    expect(seen[0]?.every((byte) => byte === 0)).toBe(true);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toEqual([
      `{"kind":"author","source_handle":"${handle(1)}","version":"spawnfile.auth.target-secret.receipt.v1"}`
    ]);
  });

  it("routes grant, rotate, and both revocations through secret-free request files", async () => {
    const files = await requestFiles();
    expect(await readFile(files.grantFile, "utf8")).not.toContain('"secret":');
    expect(await readFile(files.sourceFile, "utf8")).not.toContain('"secret":');
    for (const command of ["grant", "rotate", "revoke-grant", "revoke-version"] as const) {
      const service = lifecycle();
      const initialize = vi.fn(async () => service);
      const output = streams();
      const file = command === "grant" ? files.grantFile : files.sourceFile;
      expect(await runCli(["auth", "target-secret", command, file], {
        handlers: { initializeTargetSecretSourceLifecycle: initialize },
        stdin: stdin(),
        streams: output.value
      })).toBe(0);
      expect(initialize).toHaveBeenCalledOnce();
      expect(output.stderr).toEqual([]);
      expect(output.stdout).toHaveLength(1);
      expect(output.stdout[0]).not.toContain("\n");
      expect(output.stdout[0]).not.toContain('"secret":');
      if (command === "grant") expect(service.grant).toHaveBeenCalledOnce();
      if (command === "rotate") expect(service.rotate).toHaveBeenCalledOnce();
      if (command === "revoke-grant") expect(service.revokeGrant).toHaveBeenCalledOnce();
      if (command === "revoke-version") expect(service.revokeVersion).toHaveBeenCalledOnce();
    }
  });

  it.each(["author", "rotate"] as const)("clears %s stdin on failure and never reflects a service sentinel", async (command) => {
    const files = await requestFiles();
    const seen: Uint8Array[] = [];
    const service = lifecycle();
    const failure = async (secret: Uint8Array) => {
      seen.push(secret);
      throw new Error("TOP_SECRET_SENTINEL");
    };
    if (command === "author") service.author.mockImplementation(failure);
    else service.rotate.mockImplementation(async (_source: unknown, secret: Uint8Array) => failure(secret));
    const output = streams();
    const argv = command === "author"
      ? ["auth", "target-secret", "author"]
      : ["auth", "target-secret", "rotate", files.sourceFile];
    expect(await runCli(argv, {
      handlers: { initializeTargetSecretSourceLifecycle: vi.fn(async () => service) },
      stdin: stdin(new Uint8Array([4, 5])),
      streams: output.value
    })).toBe(1);
    expect(seen[0]?.every((byte) => byte === 0)).toBe(true);
    expect(output.stderr.join("\n")).not.toContain("TOP_SECRET_SENTINEL");
  });

  it("rejects oversized stdin before lifecycle initialization", async () => {
    const initialize = vi.fn();
    const output = streams();
    expect(await runCli(["auth", "target-secret", "author"], {
      handlers: { initializeTargetSecretSourceLifecycle: initialize },
      stdin: stdin(new Uint8Array(MAX_TARGET_SECRET_SOURCE_SECRET_BYTES + 1)),
      streams: output.value
    })).toBe(1);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("writes exactly one LF through the real default stream shape", async () => {
    const service = lifecycle();
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    expect(await runCli(["auth", "target-secret", "author"], {
      handlers: { initializeTargetSecretSourceLifecycle: vi.fn(async () => service) },
      stdin: stdin()
    })).toBe(0);
    expect(writes).toEqual([
      `{"kind":"author","source_handle":"${handle(1)}","version":"spawnfile.auth.target-secret.receipt.v1"}\n`
    ]);
  });
});
