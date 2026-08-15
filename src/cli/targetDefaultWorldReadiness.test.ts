import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { Command } from "commander";

import { queryTargetDefaultWorldReadiness } from "./targetDefaultWorldReadiness.js";
import type { TargetDefaultWorldReadinessConfig } from "./targetDefaultConfig.js";
import { registerProductionTargetCommands } from "./targetProductionCommands.js";
import { TARGET_DEFAULT_CONFIG_STDIN_VERSION } from "./targetDefaultConfigStdin.js";

const roots: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;
const d = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const request = {
  descriptor_digest: d("a"), endpoint: { internal_port: 4_070, path: "/v1/world/readiness" },
  expected: { artifact_digest: d("b"), bundle_digest: d("c"), capability_manifest_digests: [d("d")],
    document_version: "simfile.world-sidecar-readiness.v1", mechanics_sha256: d("e"),
    normalized_checkpoint_sha256: d("f"), runtime_abi: "simfile.world-sidecar-runtime.v1",
    world_instance_id: "run-world" },
  run_id: "run-test", selected_target: { fingerprint: `sha256:${"1".repeat(32)}`,
    handle: "opaque_1111111111111111" }, version: "spawnfile.target-world-readiness.request.v1",
  world_service_handle: "opaque_2222222222222222"
} as const;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("production world-readiness dependency boundary", () => {
  it("initializes only generic Docker execution and recorded world authority", () => {
    const source = readFileSync(new URL(
      "./targetDefaultWorldReadiness.ts",
      import.meta.url
    ), "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles
      .map((entry) => entry.fileName)
      .sort();
    expect(imports).toEqual([
      "../target/dockerCommandExecutor.js",
      "../target/dockerWorldReadiness.js",
      "../target/dockerWorldServiceStore.js",
      "../target/worldReadiness.js",
      "./targetDefaultConfig.js"
    ]);
  });

  it("does not create an absent authority root for invalid or valid queries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-readiness-reader-"));
    roots.push(root);
    const authority = path.join(root, "absent", "world-authority");
    const config: TargetDefaultWorldReadinessConfig = {
      context: "gpu-host", dockerCommand: "docker",
      paths: { worldAuthority: authority }, timeoutMs: 30_000
    };
    const before = await readdir(root);
    await expect(queryTargetDefaultWorldReadiness(config, {})).rejects.toThrow();
    expect(await readdir(root)).toEqual(before);
    await expect(queryTargetDefaultWorldReadiness(config, request)).rejects.toThrow();
    expect(await readdir(root)).toEqual(before);
  });

  it("does not chmod an existing unsafe read authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-readiness-reader-"));
    roots.push(root);
    const authority = path.join(root, "world-authority");
    await mkdir(authority); await chmod(authority, 0o755);
    const config: TargetDefaultWorldReadinessConfig = {
      context: "gpu-host", dockerCommand: "docker",
      paths: { worldAuthority: authority }, timeoutMs: 30_000
    };
    await expect(queryTargetDefaultWorldReadiness(config, request)).rejects.toThrow();
    expect((await stat(authority)).mode & 0o777).toBe(0o755);
  });

  it("uses the read-only config resolver in the production query command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-readiness-cli-"));
    roots.push(root);
    const home = path.join(root, "absent-home");
    process.env.SPAWNFILE_HOME = home;
    const requestPath = path.join(root, "request.json");
    await writeFile(requestPath, JSON.stringify(request));
    const configBytes = JSON.stringify({
      context: "gpu-host", dockerCommand: "docker",
      evidenceDestination: path.join(root, "unused-evidence.tar"),
      timeoutMs: 30_000, version: TARGET_DEFAULT_CONFIG_STDIN_VERSION
    });
    const program = new Command(); program.exitOverride();
    const stderr: string[] = []; const exits: number[] = [];
    registerProductionTargetCommands(program, {
      stderr: (message) => stderr.push(message), stdout: () => undefined
    }, (async function* () { yield configBytes; })(), (code) => exits.push(code));
    await program.parseAsync([
      "target", "--config", "-", "query_world_readiness", requestPath
    ], { from: "user" });
    expect(await readdir(root)).toEqual(["request.json"]);
    expect(stderr).toEqual(["error: Target world readiness query crashed"]);
    expect(exits).toEqual([1]);
  });
});
