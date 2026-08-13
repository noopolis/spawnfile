import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./runCli.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))));
const helpFor = async (argv: string[]): Promise<string> => {
  const stdout: string[] = [];
  const exitCode = await runCli(argv, {
    streams: {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message)
    }
  });
  expect(exitCode).toBe(0);
  return stdout.join("\n");
};

describe("auth command extraction", () => {
  it("preserves top-level order and the nested auth grammar", async () => {
    const top = await helpFor(["--help"]);
    expect(top.indexOf("runtimes")).toBeLessThan(top.indexOf("auth"));

    const auth = await helpFor(["auth", "--help"]);
    expect(auth).toContain("import");
    expect(auth).toContain("provision");
    expect(auth).toContain("sync");
    expect(auth).toContain("show");

    const imports = await helpFor(["auth", "import", "--help"]);
    expect(imports).toContain("env");
    expect(imports).toContain("claude-code");
    expect(imports).toContain("codex");

    const provision = await helpFor(["auth", "provision", "--help"]);
    expect(provision).toContain("--env-file");
    expect(provision).toContain("--world-bindings");
    expect(provision).toContain("--resolved-grants");
    expect(provision).not.toContain("--json");
  });

  it("routes one request through the batch handler, emits only a receipt, and disposes materials", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-provision-cli-"));
    cleanup.push(directory);
    const requestFile = path.join(directory, "request.json");
    await writeFile(requestFile, JSON.stringify({
      credentials: [{ bytes: 16, env: "ACCESS_TOKEN", kind: "generated-token", name: "access-token" }],
      descriptor_digest: `sha256:${"a".repeat(64)}`,
      run_id: "run-1",
      scope: "world",
      selected_target: {
        fingerprint: `sha256:${"b".repeat(32)}`,
        handle: `opaque_${"c".repeat(16)}`,
        version: "spawnfile.target-resource.selected-target.v1"
      },
      version: "spawnfile.auth.credential-provisioning.request.v1"
    }));
    const material = new TextEncoder().encode("CLI_SECRET_SENTINEL");
    const provisionCredentials = vi.fn(async () => ({
      materials: new Map([["access-token", material]]),
      receipt: {
        credentials: [{
          env: "ACCESS_TOKEN",
          name: "access-token",
          scope: "world",
          source_handle: `opaque_${"d".repeat(16)}`
        }],
        phases: ["author", "grant"],
        run_id: "run-1",
        scope: "world",
        version: "spawnfile.auth.credential-provisioning.receipt.v1"
      }
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await runCli(["auth", "provision", requestFile], {
      handlers: { provisionCredentials: provisionCredentials as never },
      streams: {
        stderr: (message) => stderr.push(message),
        stdout: (message) => stdout.push(message)
      }
    })).toBe(0);
    expect(provisionCredentials).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      phases: ["author", "grant"],
      version: "spawnfile.auth.credential-provisioning.receipt.v1"
    });
    expect(stdout[0]).not.toContain("CLI_SECRET_SENTINEL");
    expect(material.every((byte) => byte === 0)).toBe(true);
  });

  it("normalizes handler failure without reflecting a secret detail", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-provision-error-"));
    cleanup.push(directory);
    const requestFile = path.join(directory, "request.json");
    await writeFile(requestFile, JSON.stringify({
      credentials: [{ bytes: 16, env: "ACCESS_TOKEN", kind: "generated-token", name: "access-token" }],
      descriptor_digest: `sha256:${"a".repeat(64)}`,
      run_id: "run-1",
      scope: "world",
      selected_target: {
        fingerprint: `sha256:${"b".repeat(32)}`,
        handle: `opaque_${"c".repeat(16)}`,
        version: "spawnfile.target-resource.selected-target.v1"
      },
      version: "spawnfile.auth.credential-provisioning.request.v1"
    }));
    const stderr: string[] = [];
    expect(await runCli(["auth", "provision", requestFile], {
      handlers: {
        provisionCredentials: vi.fn(async () => {
          throw new Error("CLI_SECRET_SENTINEL");
        }) as never
      },
      streams: { stderr: (message) => stderr.push(message), stdout: () => undefined }
    })).toBe(1);
    expect(stderr.join("\n")).toBe("error: invalid target secret source record");
    expect(stderr.join("\n")).not.toContain("CLI_SECRET_SENTINEL");
  });
});
