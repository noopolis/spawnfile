import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initializeTargetSecretSourceLifecycle } from "../auth/index.js";
import { initializeOrganizationHandoffAuthorityStore } from "../deployment/organizationHandoffAuthorityStore.js";
import { createOrganizationHandoff, parseCanonicalSha256Digest } from "../deployment/organizationHandoffTypes.js";
import {
  createCanonicalSelectedTargetReceiptBytes,
  createCanonicalTargetReceiptBytes,
  createCanonicalTargetWorldClockReceiptBytes,
  parseOpaqueTargetHandle,
  parseTargetResourceReceipt,
  parseTargetWorldClockReceipt,
  selectTarget
} from "../target/index.js";
import { createBuiltWorldClockState, selectBuiltWorldClockMode, type BuiltWorldClockMode } from "./targetWorldClockCrossProcess.test-helper.js";

const descriptor = `sha256:${"a".repeat(64)}`;
const manifest = `sha256:${"b".repeat(64)}`;
const image = `sha256:${"c".repeat(64)}`;
const labels = Object.freeze({
  "com.spawnfile.compile_fingerprint": "sf1.cli",
  "com.spawnfile.deployment": "cli",
  "com.spawnfile.project": "cli",
  "com.spawnfile.run_id": "run_cli",
  "com.spawnfile.unit": "cli-unit",
  "com.spawnfile.version": "0.1"
});
const roots: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;
const builtCliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

interface State {
  readonly callsPath: string;
  readonly config: Record<string, unknown>;
  readonly handoffHandle: string;
  readonly home: string;
  readonly requestRoot: string;
  readonly selected: { readonly fingerprint: string; readonly handle: string };
  readonly sourceHandle: string;
}
interface ChildResult { readonly code: number | null; readonly stderr: string; readonly stdout: string; }

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && /^(?!.*\.test\.)[^.].*\.(?:m?ts|js)$/u.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
};

beforeAll(async () => {
  expect(existsSync(builtCliPath), "dist/cli/index.js is required by the cross-process CLI suite").toBe(true);
  const builtAt = (await stat(builtCliPath)).mtimeMs;
  const staleSource = (await Promise.all((await sourceFiles(sourceRoot)).map(async (file) => ({
    file, modifiedAt: (await stat(file)).mtimeMs
  })))).find(({ modifiedAt }) => modifiedAt > builtAt);
  expect(staleSource, `Built CLI is stale: ${staleSource?.file ?? "a source file"} is newer than dist/cli/index.js; run npm run build`).toBeUndefined();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const boundedRawChild = (state: Pick<State, "home">, args: readonly string[], input: string): Promise<ChildResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builtCliPath, ...args], {
      cwd: process.cwd(), env: { SPAWNFILE_HOME: state.home }, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (error?: Error, code: number | null = child.exitCode): void => {
      if (settled) return; settled = true; clearTimeout(timer); child.kill("SIGKILL");
      if (error) reject(error); else resolve({ code, stderr, stdout });
    };
    const collect = (kind: "stderr" | "stdout") => (chunk: Buffer): void => {
      const next = kind === "stdout" ? stdout + chunk.toString("utf8") : stderr + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > 32_768) return finish(new Error("target CLI child output exceeded bound"));
      if (kind === "stdout") stdout = next; else stderr = next;
    };
    const timer = setTimeout(() => finish(new Error("target CLI child timed out")), 10_000);
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.on("error", () => finish(new Error("target CLI child failed")));
    child.on("close", (code) => finish(undefined, code));
    child.stdin.end(input);
  });

const boundedChild = async (state: State, request: Record<string, unknown>, input: string): Promise<ChildResult> => {
  const requestPath = path.join(state.requestRoot, `${request.operation}-${request.idempotency_key}.json`);
  await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  return boundedRawChild(
    state,
    ["target", "--config", "-", String(request.operation), requestPath],
    input
  );
};

const createState = async (): Promise<State> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-cli-child-")));
  roots.push(root);
  const home = path.join(root, "home"); const output = path.join(root, "output");
  const requests = path.join(root, "requests");
  const callsPath = path.join(root, "docker-calls.ndjson");
  await Promise.all([
    mkdir(home, { mode: 0o700 }), mkdir(output, { mode: 0o700 }),
    mkdir(requests, { mode: 0o700 }), writeFile(callsPath, "", { mode: 0o600 })
  ]);
  const fakeDocker = path.join(root, "docker-safe");
  const resourcePath = path.join(root, "docker-resources.json");
  await writeFile(fakeDocker, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const callsPath = ${JSON.stringify(callsPath)};
const resourcePath = ${JSON.stringify(resourcePath)};
fs.appendFileSync(callsPath, JSON.stringify(args) + "\\n", { mode: 0o600 });
const resources = fs.existsSync(resourcePath) ? JSON.parse(fs.readFileSync(resourcePath, "utf8")) : {};
const save = () => fs.writeFileSync(resourcePath, JSON.stringify(resources), { mode: 0o600 });
const type = args[0] === "context" ? args[0] : args[2];
const command = args[0] === "context" ? args[1] : args[3];
if (type === "context" && command === "inspect") process.stdout.write("\\\"ssh://target-cli\\\"\\n");
else if ((type === "network" || type === "volume") && command === "create") {
  const name = args.at(-1);
  const labels = Object.fromEntries(args.flatMap((value, index) => args[index - 1] === "--label" ? [value.split("=", 2)] : []));
  resources[name] = { Internal: type === "network", Labels: labels, Name: name };
  save(); process.stdout.write("raw-docker-id\\n");
} else if ((type === "network" || type === "volume") && command === "inspect") {
  const name = args.at(-1); const resource = resources[name];
  if (!resource) process.exitCode = 1;
  else process.stdout.write(JSON.stringify([type === "network" ? resource : { Labels: resource.Labels, Name: resource.Name }]));
} else { process.stderr.write("poison\\n"); process.exitCode = 1; }
`, { mode: 0o700 });
  await chmod(fakeDocker, 0o700);
  process.env.SPAWNFILE_HOME = home;
  const selectedReceipt = await selectTarget({ context: "target_cli", dockerCommand: fakeDocker,
    execFile: async () => ({ stderr: "", stdout: "\"ssh://target-cli\"\n" }), timeoutMs: 1_000 });
  const selected = { fingerprint: selectedReceipt.fingerprint, handle: selectedReceipt.handle };
  const selectedDigest = `sha256:${createHash("sha256").update(createCanonicalSelectedTargetReceiptBytes(selectedReceipt), "utf8").digest("hex")}`;
  const lifecycle = await initializeTargetSecretSourceLifecycle();
  const source = await lifecycle.author(new TextEncoder().encode("B113_PARENT_ONLY_SECRET"));
  await lifecycle.grant({ descriptor_digest: descriptor, name: "token", run_id: "run_cli", scope: "world", selected_target: selectedReceipt, source_handle: source.source_handle });
  const handoff = createOrganizationHandoff("run_cli", { bindingDigest: parseCanonicalSha256Digest(`sha256:${"d".repeat(64)}`), networkAttachmentHandle: parseOpaqueTargetHandle(`opaque_${"e".repeat(64)}`), selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest) });
  const store = await initializeOrganizationHandoffAuthorityStore();
  const pending = await store.reserve({ bindingDigest: handoff.binding_digest, containerName: "target-cli-container", deploymentLabels: labels, descriptorDigest: descriptor, handoff, selectedTarget: selectedReceipt, selectedTargetReceiptDigest: selectedDigest });
  const finalized = await store.finalize(pending.pending_key, { containerId: "f".repeat(64), deploymentLabels: labels });
  await store.dispose();
  return {
    config: { artifactMappings: [{ artifact_manifest_digest: manifest, image_digest: image, image_reference: `registry.example/spawn/helper@${image}` }], context: "target_cli", dockerCommand: fakeDocker, evidenceDestination: path.join(output, "evidence.tar"), helperArtifactManifestDigest: manifest, timeoutMs: 10_000, version: "spawnfile.target-default-config.v1" },
    callsPath, handoffHandle: finalized.organization_handoff_handle, home, requestRoot: requests, selected, sourceHandle: source.source_handle
  };
};

const envelope = (state: State, operation: string, idempotencyKey: string) => ({
  descriptor_digest: descriptor, expected_revision: 0, idempotency_key: idempotencyKey,
  operation, run_id: "run_cli", selected_target: state.selected, version: "spawnfile.target-resource.request.v1"
});

describe("built standalone target CLI", () => {
  it("normalizes hostile target grammar before stdin or private output", async () => {
    const state = await createState();
    const privateSentinel = `PRIVATE_${"s".repeat(100_000)}`;
    for (const args of [
      ["target", "--config", "-", privateSentinel],
      ["target", "--config", "-", "select_target", `/tmp/${privateSentinel}.json`, `--${privateSentinel}`],
      ["target", "--config", "-", "select_target"]
    ]) {
      const result = await boundedRawChild(state, args, "B113_PARENT_ONLY_SECRET");
      expect(result).toEqual({
        code: 2,
        stderr: "error: Invalid target command\n",
        stdout: ""
      });
    }
    expect(await readFile(state.callsPath, "utf8")).toBe("");
  }, 30_000);

  it("uses piped strict config and emits one canonical receipt from a separate process", async () => {
    const state = await createState();
    const result = await boundedChild(state, envelope(state, "create_data_network", "idem_aaaaaaaaaaaaaaaa"), JSON.stringify(state.config));
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.endsWith("\n")).toBe(true);
    const receipt = parseTargetResourceReceipt(JSON.parse(result.stdout));
    expect(result.stdout).toBe(`${createCanonicalTargetReceiptBytes(receipt)}\n`);
    expect(result.stdout).not.toContain("B113_PARENT_ONLY_SECRET");
  }, 30_000);

  it("queries authoritative clock truth through separate built production CLI processes", async () => {
    const state = await createBuiltWorldClockState(); roots.push(state.root);
    for (const mode of [
      "success", "tick-zero", "stale", "topology", "activation", "nonzero-action",
    ] as const satisfies readonly BuiltWorldClockMode[]) {
      await selectBuiltWorldClockMode(state, mode); await writeFile(state.callsPath, "");
      const result = await boundedRawChild(state, [
        "target", "--config", "-", "query_world_clock", state.requestPath,
      ], JSON.stringify(state.config));
      const calls = (await readFile(state.callsPath, "utf8")).trim().split("\n")
        .filter(Boolean).map((line) => JSON.parse(line) as string[]);
      expect(calls.every((args) => args[0] === "--context" && args[1] === "built_clock")).toBe(true);
      expect(calls.some((args) => args[2] === "container" && args[3] === "inspect")).toBe(true);
      expect(calls.some((args) => args.includes("/bin/cat"))).toBe(true);
      if (mode === "success") {
        expect(result).toMatchObject({ code: 0, stderr: "" });
        const receipt = parseTargetWorldClockReceipt(JSON.parse(result.stdout));
        expect(receipt).toMatchObject({ action_count: 0, clock: { completed_tick: 1 }, run_id: state.request.run_id });
        expect(result.stdout).toBe(`${createCanonicalTargetWorldClockReceiptBytes(receipt)}\n`);
        expect(calls.filter((args) => args[3] === "inspect")).toHaveLength(2);
        expect(calls.some((args) => args.includes("/usr/local/bin/node"))).toBe(true);
      } else {
        expect(result).toEqual({ code: 1, stderr: "error: Target world clock query failed\n", stdout: "" });
        expect(calls.filter((args) => args[3] === "inspect")).toHaveLength(
          mode === "topology" || mode === "activation" ? 1 : 2,
        );
        expect(calls.some((args) => args.includes("/usr/local/bin/node")))
          .toBe(mode !== "topology" && mode !== "activation");
      }
    }
  }, 30_000);

  it("routes composed preparation through the built production config and session", async () => {
    const state = await createState();
    const request = {
      auth_profile: "simfile_live",
      descriptor_digest: descriptor,
      idempotency_key: "idem_composed000000000",
      organization: {
        artifact_digest: `sha256:${"e".repeat(64)}`,
        world_bindings_digest: `sha256:${"d".repeat(64)}`,
      },
      run_id: "run_cli",
      secret_bindings: [{ name: "token", scope: "world", source_handle: state.sourceHandle }],
      target_selector: "target_cli",
      version: "spawnfile.composed-preparation.request.v1",
      world: {
        artifact_manifest_digest: manifest,
        bundle_digest: `sha256:${"f".repeat(64)}`,
      },
    } as const;
    const requestPath = path.join(state.requestRoot, "composed-preparation.json");
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    const result = await boundedRawChild(state, [
      "target", "--config", "-", "prepare_composed_run", requestPath,
    ], JSON.stringify(state.config));
    const calls = (await readFile(state.callsPath, "utf8")).trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(result).toEqual({
      code: 1,
      stderr: "error: Docker artifact resolution failed\n",
      stdout: "",
    });
    expect(calls.some((args) => args[0] === "context" && args[1] === "inspect")).toBe(true);
    expect(`${result.stdout}\n${result.stderr}\n${JSON.stringify(calls)}`)
      .not.toContain("B113_PARENT_ONLY_SECRET");
  }, 30_000);

  it("rejects hostile config before an owner-backed target operation or stdout", async () => {
    const state = await createState();
    const result = await boundedChild(state, envelope(state, "create_data_network", "idem_bbbbbbbbbbbbbbbb"), '{"unexpected":"B113_PARENT_ONLY_SECRET"}');
    expect(result).toEqual({ code: 2, stderr: "error: Invalid target configuration\n", stdout: "" });
    expect(await readFile(state.callsPath, "utf8")).toBe("");
  }, 30_000);

  it("reaches the parent-authored B113 secret authority without a Docker mutation or secret leak", async () => {
    const state = await createState();
    const network = await boundedChild(state, envelope(state, "create_data_network", "idem_cccccccccccccccc"), JSON.stringify(state.config));
    const dataNetwork = JSON.parse(network.stdout) as { result_handle: string };
    await writeFile(state.callsPath, "");
    const request = {
      ...envelope(state, "prepare_secret_bindings", "idem_dddddddddddddddd"), expected_revision: 1,
      bindings: [{ name: "token", scope: "world", source_handle: state.sourceHandle }]
    };
    const result = await boundedChild(state, request, JSON.stringify(state.config));
    const calls = (await readFile(state.callsPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(dataNetwork.result_handle).toMatch(/^opaque_/u);
    expect(result).toEqual({ code: 1, stderr: "error: Docker secret materialization failed\n", stdout: "" });
    expect(calls.some((args) => args.includes("volume") && args.includes("inspect"))).toBe(true);
    expect(calls.some((args) => args.includes("create") || args.includes("run"))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}\n${JSON.stringify(calls)}`).not.toContain("B113_PARENT_ONLY_SECRET");
  }, 30_000);

  it("reaches the parent-authored B114 handoff authority and rejects a drifted handle before Docker", async () => {
    const state = await createState();
    const network = await boundedChild(state, envelope(state, "create_data_network", "idem_eeeeeeeeeeeeeeee"), JSON.stringify(state.config));
    const dataNetwork = JSON.parse(network.stdout) as { result_handle: string };
    const request = {
      ...envelope(state, "attach_organization", "idem_ffffffffffffffff"), expected_revision: 1,
      data_network_handle: dataNetwork.result_handle, organization_handoff_handle: state.handoffHandle
    };
    await writeFile(state.callsPath, "");
    const reached = await boundedChild(state, request, JSON.stringify(state.config));
    const reachedCalls = (await readFile(state.callsPath, "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(reached).toEqual({ code: 1, stderr: "error: Docker organization attachment failed\n", stdout: "" });
    expect(reachedCalls.some((args) => args.includes("network") && args.includes("inspect"))).toBe(true);
    expect(reachedCalls.some((args) => args.includes("connect") || args.includes("create") || args.includes("run"))).toBe(false);

    await writeFile(state.callsPath, "");
    const drifted = await boundedChild(state, {
      ...request, idempotency_key: "idem_gggggggggggggggg", organization_handoff_handle: `opaque_${"h".repeat(64)}`
    }, JSON.stringify(state.config));
    expect(drifted).toEqual({ code: 1, stderr: "error: Docker organization attachment failed\n", stdout: "" });
    expect(await readFile(state.callsPath, "utf8")).toBe("");
  }, 30_000);
});
