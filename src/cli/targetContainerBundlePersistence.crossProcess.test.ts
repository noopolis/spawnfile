import { fork } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { TargetDefaultConfigInputs } from "./targetDefaultConfig.js";
import type { TargetLocalBundlePrepareRequest } from "../target/containerBundleContracts.js";
import { parseOpaqueTargetHandle } from "../target/contracts.js";

const VERSION = "spawnfile.target-container-bundle-persistence-child.v1";
const roots: string[] = [];
const digest = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
const request: TargetLocalBundlePrepareRequest = Object.freeze({
  archive_base64: "YQ==",
  archive_digest: "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
  archive_entries: ["runtime.mjs"],
  artifact_digest: digest("a"),
  build_policy_digest: digest("b"),
  bundle_digest: digest("c"),
  entrypoint: "runtime.mjs",
  idempotency_key: "idem_persistentbundle",
  launcher_digest: digest("d"),
  network_alias: "world",
  platform: { architecture: "amd64" as const, os: "linux" as const },
  platform_digest: digest("e"),
  selected_target: {
    fingerprint: `sha256:${"f".repeat(32)}`,
    handle: parseOpaqueTargetHandle(`opaque_${"1".repeat(64)}`)
  },
  version: "spawnfile.target-local-container-bundle.prepare-request.v1"
});

interface ChildResult {
  readonly attested?: boolean;
  readonly bundle_reused: boolean;
  readonly bundle_root: string;
  readonly kind: "result";
  readonly ok: true;
  readonly secret_entries: readonly string[];
  readonly secret_root: string;
  readonly version: typeof VERSION;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const runChild = (
  home: string,
  config: TargetDefaultConfigInputs,
  action: "attest" | "complete" | "inspect",
  scenario?: "daemon_replaced" | "exact" | "image_missing" | "label_drift"
): Promise<ChildResult> => new Promise((resolve, reject) => {
  const child = fork(fileURLToPath(new URL("../../test/fixtures/targetContainerBundlePersistence.fixture.ts", import.meta.url)), [], {
    env: { ...process.env, SPAWNFILE_HOME: home },
    execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
    silent: true
  });
  let output = "";
  let result: ChildResult | undefined;
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("container-bundle persistence child timed out"));
  }, 15_000);
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  child.on("message", (raw: unknown) => {
    const message = raw as Record<string, unknown>;
    if (message.kind === "ready" && message.version === VERSION) {
      child.send({ action, config, request, ...(scenario ? { scenario } : {}), version: VERSION });
    } else if (message.kind === "result") {
      result = message as unknown as ChildResult;
    }
  });
  child.on("error", reject);
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0 || output !== "" || !result?.ok) {
      reject(new Error(`container-bundle persistence child failed: ${code} ${output}`));
    } else {
      resolve(result);
    }
  });
});

const freshRun = async (
  root: string,
  durable: string,
  name: string
): Promise<{ readonly config: TargetDefaultConfigInputs; readonly home: string }> => {
  const home = path.join(root, `${name}-home`);
  const output = path.join(root, `${name}-output`);
  await mkdir(home, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  return {
    config: {
      containerBundleStoreRoot: durable,
      context: "gpu_4090",
      dockerCommand: "docker",
      evidenceDestination: path.join(output, "evidence.tar"),
      timeoutMs: 30_000
    },
    home
  };
};

describe("persistent target-local container-bundle authority", () => {
  it("reuses completed mappings across fresh per-run homes and processes without reusing secret state", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-persistence-")));
    roots.push(root);
    const durable = path.join(root, "durable-container-bundles");
    await mkdir(durable, { mode: 0o700 });

    const first = await freshRun(root, durable, "first");
    const completed = await runChild(first.home, first.config, "complete");
    expect(completed).toMatchObject({ bundle_reused: true, bundle_root: durable, secret_entries: [] });
    await writeFile(path.join(completed.secret_root, "run-only-secret"), "must-not-reuse", { mode: 0o600 });

    const second = await freshRun(root, durable, "second");
    const replay = await runChild(second.home, second.config, "inspect");
    expect(replay).toMatchObject({ bundle_reused: true, bundle_root: durable, secret_entries: [] });
    expect(replay.secret_root).not.toBe(completed.secret_root);
  }, 30_000);

  it("re-attests a persisted mapping and fails closed for missing, drifted, or daemon-replaced images", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-reattest-")));
    roots.push(root);
    const durable = path.join(root, "durable-container-bundles");
    await mkdir(durable, { mode: 0o700 });
    const initial = await freshRun(root, durable, "initial");
    await runChild(initial.home, initial.config, "complete");

    for (const [scenario, attested] of [
      ["exact", true],
      ["image_missing", false],
      ["label_drift", false],
      ["daemon_replaced", false]
    ] as const) {
      const run = await freshRun(root, durable, `run-${scenario}`);
      await expect(runChild(run.home, run.config, "attest", scenario))
        .resolves.toMatchObject({ attested, bundle_reused: true, secret_entries: [] });
    }
  }, 45_000);
});
