import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOrganizationHandoff,
  parseCanonicalSha256Digest
} from "./organizationHandoffTypes.js";
import {
  initializeOrganizationHandoffAuthorityStore
} from "./organizationHandoffAuthorityStore.js";
import { downDeployment } from "./downDeployment.js";
import { writeDeploymentRecord } from "./record.js";
import {
  createDockerOrganizationAttachmentSpec
} from "../target/organizationAttachmentProvider.js";
import {
  detachExactOrganizationAttachment
} from "../target/organizationAttachmentLifecycle.js";
import {
  createOrganizationAttachmentBinding,
  initializeOrganizationAttachmentAuthorityStore
} from "../target/organizationAttachmentStore.js";
import { parseOrganizationAttachmentResolution } from "../target/organizationAttachmentAuthority.js";
import { createEndpointFingerprint, parseOpaqueTargetHandle } from "../target/index.js";

const homes: string[] = [];
const targetRoots: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;
const authorities: Array<Awaited<ReturnType<typeof initializeOrganizationHandoffAuthorityStore>>> = [];
const digest = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const childEndpoint = "ssh://operator@remote-4090";
const childContext = "remote_4090";
const selectedFingerprint = createEndpointFingerprint(childEndpoint);
const selected = {
  fingerprint: selectedFingerprint,
  handle: parseOpaqueTargetHandle(`opaque_${createHash("sha256")
    .update("spawnfile.target-resource.selected-target.v1\0", "utf8")
    .update(childContext, "utf8")
    .update("\0", "utf8")
    .update(selectedFingerprint, "utf8")
    .digest("hex")}`),
  version: "spawnfile.target-resource.selected-target.v1"
} as const;
const selectedDigest = digest(JSON.stringify(selected));
const labels = {
  "com.spawnfile.compile_fingerprint": "sf1.abc",
  "com.spawnfile.deployment": "football",
  "com.spawnfile.project": "football",
  "com.spawnfile.run_id": "run-one",
  "com.spawnfile.unit": "football-container",
  "com.spawnfile.version": "0.1"
};
const handoff = createOrganizationHandoff("run-one", {
  bindingDigest: parseCanonicalSha256Digest(`sha256:${"d".repeat(64)}`),
  networkAttachmentHandle: "opaque_eeeeeeeeeeeeeeee" as never,
  selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
});
const input = {
  bindingDigest: `sha256:${"d".repeat(64)}`,
  containerName: "football",
  deploymentLabels: labels,
  descriptorDigest: `sha256:${"c".repeat(64)}`,
  handoff,
  selectedTarget: selected,
  selectedTargetReceiptDigest: selectedDigest
};
const alternateHandoff = createOrganizationHandoff("run-one", {
  bindingDigest: parseCanonicalSha256Digest(`sha256:${"1".repeat(64)}`),
  networkAttachmentHandle: "opaque_2222222222222222" as never,
  selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
});
const alternateInput = {
  ...input,
  bindingDigest: alternateHandoff.binding_digest,
  handoff: alternateHandoff
};

const authorization = (handle: string) => ({
  descriptor_digest: input.descriptorDigest,
  operation_handle: "opaque_ffffffffffffffff",
  organization_handoff_handle: handle,
  request_digest: `sha256:${"0".repeat(64)}`,
  run_id: "run-one",
  selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
  version: "spawnfile.target-organization-attachment.authorization.v1" as const
});

const initialize = async () => {
  const authority = await initializeOrganizationHandoffAuthorityStore();
  authorities.push(authority);
  return authority;
};

const CHILD_VERSION = "spawnfile.deployment-handoff-close.v1" as const;
const ATTACH_CHILD_VERSION = "spawnfile.deployment-handoff-attach.v1" as const;
type AttachChildResult =
  | { attachmentHandle: string; executorCallCount: number; ok: true; operations: string[] }
  | { executorCallCount: number; failed: true };
const attachFromSeparateProcess = async (
  home: string,
  targetRoot: string,
  authorizationInput: unknown
): Promise<AttachChildResult> =>
  new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("../../fixtures/support/organizationHandoffAttach.fixture.ts", import.meta.url)),
      [],
      {
        env: { SPAWNFILE_HOME: home },
        execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
        silent: true
      }
    );
    let ready = false;
    let result: AttachChildResult | undefined;
    let outputBytes = 0;
    const fail = (): void => { child.kill(); reject(new Error("separate attach failed")); };
    const timer = setTimeout(fail, 8_000);
    const output = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 0) fail();
    };
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    child.on("message", (raw: unknown) => {
      if (raw === null || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype
        || Buffer.byteLength(JSON.stringify(raw), "utf8") > 16_384) return fail();
      const message = raw as Record<string, unknown>;
      if (!ready && message.version === ATTACH_CHILD_VERSION && message.ready === true) {
        ready = true;
        const request = { authorization: authorizationInput, targetRoot, version: ATTACH_CHILD_VERSION };
        if (Buffer.byteLength(JSON.stringify(request), "utf8") > 16_384 || !child.send(request)) fail();
        return;
      }
      if (message.version !== ATTACH_CHILD_VERSION) return fail();
      const allowedOperations = new Set([
        "context inspect", "network inspect", "container inspect", "network connect"
      ]);
      if (message.ok === true && typeof message.attachmentHandle === "string"
        && typeof message.executorCallCount === "number" && Array.isArray(message.operations)
        && message.operations.every((value) => typeof value === "string" && allowedOperations.has(value))) {
        result = {
          attachmentHandle: message.attachmentHandle,
          executorCallCount: message.executorCallCount,
          ok: true,
          operations: message.operations as string[]
        };
      } else if (message.failed === true && typeof message.executorCallCount === "number") {
        result = { executorCallCount: message.executorCallCount, failed: true };
      } else fail();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      if (!ready || !result || outputBytes !== 0) fail();
      else resolve(result);
    });
    child.on("error", fail);
  });

const closeFromSeparateProcess = async (
  home: string,
  organizationHandoffHandle: string,
  expectedHandoff: unknown
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("../../fixtures/support/organizationHandoffDownClose.fixture.ts", import.meta.url)),
      [],
      {
        env: { SPAWNFILE_HOME: home },
        execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
        silent: true
      }
    );
    let ready = false;
    let settled = false;
    let stderr = "";
    let stdout = "";
    const fail = (): void => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("separate authority close failed"));
    };
    const timer = setTimeout(fail, 5_000);
    const collect = (current: () => string, append: (value: string) => void) => (chunk: Buffer): void => {
      const next = current() + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > 1_024) return fail();
      append(next);
    };
    child.stdout?.on("data", collect(() => stdout, (value) => { stdout = value; }));
    child.stderr?.on("data", collect(() => stderr, (value) => { stderr = value; }));
    child.on("message", (raw: unknown) => {
      if (raw === null || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
      const message = raw as Record<string, unknown>;
      if (!ready && Object.keys(message).sort().join(",") === "ready,version"
        && message.ready === true && message.version === CHILD_VERSION) {
        ready = true;
        const request = { expectedHandoff, organizationHandoffHandle, version: CHILD_VERSION };
        if (Buffer.byteLength(JSON.stringify(request), "utf8") > 4_096 || !child.send(request)) fail();
        return;
      }
      if (ready && Object.keys(message).sort().join(",") === "ok,version"
        && message.ok === true && message.version === CHILD_VERSION) return;
      fail();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!settled && ready && code === 0 && stdout === "" && stderr === "") {
        settled = true;
        resolve();
      } else if (!settled) fail();
    });
    child.on("error", fail);
  });

const startHome = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-down-close-"));
  homes.push(home);
  process.env.SPAWNFILE_HOME = home;
};

afterEach(async () => {
  await Promise.all(authorities.splice(0).map((authority) => authority.dispose()));
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
  await Promise.all(targetRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("deployment handoff close boundary", () => {
  it("closes fresh authorization after a worker restart while a target-owned stored attachment remains exactly detachable", async () => {
    await startHome();
    const initial = await initialize();
    const pending = await initial.reserve(input);
    const finalized = await initial.finalize(pending.pending_key, {
      containerId: "1".repeat(64), deploymentLabels: labels
    });
    const resolution = parseOrganizationAttachmentResolution(await initial.resolver.resolve({
      authorization: authorization(finalized.organization_handoff_handle)
    }));

    // This is the target's durable, already-bound attachment. It is created
    // from the B93 resolution before deployment close and never calls back to
    // deployment authority during detach.
    const operationHandle = "opaque_9999999999999999" as never;
    const requestDigest = `sha256:${"9".repeat(64)}`;
    const spec = createDockerOrganizationAttachmentSpec({
      containerId: resolution.network_attachment.container_id,
      dataNetworkOperationHandle: operationHandle,
      dataNetworkRequestDigest: requestDigest,
      deploymentLabels: resolution.network_attachment.deployment_labels,
      operationHandle: resolution.authorization.operation_handle,
      organizationHandoffHandle: resolution.authorization.organization_handoff_handle,
      requestDigest: resolution.authorization.request_digest,
      runId: resolution.authorization.run_id,
      selectedTargetHandle: resolution.authorization.selected_target.handle
    });
    const targetRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-attachment-")));
    targetRoots.push(targetRoot);
    const targetStore = await initializeOrganizationAttachmentAuthorityStore(targetRoot);
    const binding = createOrganizationAttachmentBinding({
      dataNetworkOperationHandle: operationHandle,
      dataNetworkRequestDigest: requestDigest,
      networkId: "2".repeat(64),
      resolution,
      spec
    });
    await targetStore.bindResolution(resolution);
    await targetStore.bindAttachment(binding);

    await initial.dispose();
    await closeFromSeparateProcess(
      process.env.SPAWNFILE_HOME!,
      finalized.organization_handoff_handle,
      finalized.handoff
    );
    const restarted = await initialize();
    await expect(restarted.resolver.resolve({
      authorization: authorization(finalized.organization_handoff_handle)
    })).rejects.toThrow("Organization handoff authority failed");

    let attached = true;
    const calls: string[][] = [];
    await detachExactOrganizationAttachment(
      await targetStore.loadAttachment(binding.attachment_handle),
      {
        context: "remote_4090",
        executor: async (_file, args) => {
          calls.push(args);
          if (args[2] === "network" && args[3] === "inspect") {
            return { stderr: "", stdout: JSON.stringify([{
              Id: binding.data_network.id, Internal: true, Labels: spec.network.labels, Name: spec.network.name
            }]) };
          }
          if (args[2] === "container" && args[3] === "inspect") {
            return { stderr: "", stdout: JSON.stringify([{
              Attached: attached, Id: resolution.network_attachment.container_id, Labels: labels
            }]) };
          }
          if (args[2] === "network" && args[3] === "disconnect") {
            attached = false;
            return { stderr: "", stdout: "" };
          }
          throw new Error(`unexpected command ${args.join(" ")}`);
        },
        timeoutMs: 4_000
      }
    );
    expect(calls.map((args) => args.slice(0, 4))).toEqual([
      ["--context", "remote_4090", "network", "inspect"],
      ["--context", "remote_4090", "container", "inspect"],
      ["--context", "remote_4090", "network", "disconnect"],
      ["--context", "remote_4090", "container", "inspect"],
      ["--context", "remote_4090", "network", "inspect"]
    ]);
  }, 20_000);

  it("fails closed when a restarted authority opens a different host store", async () => {
    await startHome();
    const first = await initialize();
    const pending = await first.reserve(input);
    const finalized = await first.finalize(pending.pending_key, {
      containerId: "3".repeat(64), deploymentLabels: labels
    });
    await first.dispose();

    await startHome();
    await expect(closeFromSeparateProcess(
      process.env.SPAWNFILE_HOME!,
      finalized.organization_handoff_handle,
      finalized.handoff
    ))
      .rejects.toThrow("separate authority close failed");
  });

  it("attaches in a child, closes deployment authority, denies fresh attach, and detaches from target-owned state", async () => {
    await startHome();
    const authority = await initialize();
    const pending = await authority.reserve(input);
    const finalized = await authority.finalize(pending.pending_key, {
      containerId: "1".repeat(64), deploymentLabels: labels
    });
    const auth = authorization(finalized.organization_handoff_handle);
    await authority.dispose();
    const targetRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-child-target-")));
    targetRoots.push(targetRoot);

    const attached = await attachFromSeparateProcess(process.env.SPAWNFILE_HOME!, targetRoot, auth);
    expect(attached).toMatchObject({
      executorCallCount: 6,
      ok: true,
      operations: [
        "context inspect", "network inspect", "container inspect",
        "network connect", "container inspect", "network inspect"
      ]
    });
    if (!("ok" in attached)) throw new Error("child attach failed");

    await closeFromSeparateProcess(
      process.env.SPAWNFILE_HOME!,
      finalized.organization_handoff_handle,
      finalized.handoff
    );
    const restarted = await initialize();
    await expect(restarted.resolver.resolve({ authorization: auth }))
      .rejects.toThrow("Organization handoff authority failed");

    const deniedRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-child-denied-")));
    targetRoots.push(deniedRoot);
    await expect(attachFromSeparateProcess(process.env.SPAWNFILE_HOME!, deniedRoot, auth))
      .resolves.toEqual({ executorCallCount: 0, failed: true });
    expect(await readdir(deniedRoot)).toEqual([]);

    const foreignHome = await mkdtemp(path.join(os.tmpdir(), "spawnfile-child-foreign-home-"));
    homes.push(foreignHome);
    const foreignTarget = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-child-foreign-target-")));
    targetRoots.push(foreignTarget);
    await expect(attachFromSeparateProcess(foreignHome, foreignTarget, auth))
      .resolves.toEqual({ executorCallCount: 0, failed: true });
    expect(await readdir(foreignTarget)).toEqual([]);

    const targetStore = await initializeOrganizationAttachmentAuthorityStore(
      await realpath(path.join(targetRoot, "authority"))
    );
    const binding = await targetStore.loadAttachment(parseOpaqueTargetHandle(attached.attachmentHandle));
    let stillAttached = true;
    const detachCalls: string[][] = [];
    await detachExactOrganizationAttachment(binding, {
      context: childContext,
      executor: async (_file, args) => {
        detachCalls.push(args);
        if (args[2] === "network" && args[3] === "inspect") return {
          stderr: "",
          stdout: JSON.stringify([{
            Id: binding.data_network.id,
            Internal: true,
            Labels: binding.data_network.labels,
            Name: binding.data_network.name
          }])
        };
        if (args[2] === "container" && args[3] === "inspect") return {
          stderr: "",
          stdout: JSON.stringify([{
            Attached: stillAttached,
            Id: binding.resolution.network_attachment.container_id,
            Labels: binding.resolution.network_attachment.deployment_labels
          }])
        };
        if (args[2] === "network" && args[3] === "disconnect") {
          stillAttached = false;
          return { stderr: "", stdout: "" };
        }
        throw new Error("unexpected detach Docker call");
      },
      timeoutMs: 4_000
    });
    expect(detachCalls.map((args) => args.slice(0, 4))).toEqual([
      ["--context", childContext, "network", "inspect"],
      ["--context", childContext, "container", "inspect"],
      ["--context", childContext, "network", "disconnect"],
      ["--context", childContext, "container", "inspect"],
      ["--context", childContext, "network", "inspect"]
    ]);
  }, 20_000);

  it("refuses a deployment record with a swapped valid capability pair before Docker and closes neither", async () => {
    await startHome();
    const authority = await initialize();
    const firstPending = await authority.reserve(input);
    const first = await authority.finalize(firstPending.pending_key, {
      containerId: "4".repeat(64), deploymentLabels: labels
    });
    const secondPending = await authority.reserve(alternateInput);
    const second = await authority.finalize(secondPending.pending_key, {
      containerId: "5".repeat(64), deploymentLabels: labels
    });
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-down-swapped-"));
    homes.push(outputDirectory);
    await writeDeploymentRecord(outputDirectory, {
      auth_profile: null,
      compile_fingerprint: "sf1:abc",
      created_at: "2026-07-24T00:00:00.000Z",
      export_index: {
        exported_at: "2026-07-24T00:00:00.000Z",
        path: "/safe/export-index.json",
        run_id: "run-one"
      },
      manager: "docker",
      name: "football",
      organization_handoff: second.handoff,
      organization_handoff_handle: first.organization_handoff_handle,
      output_directory: outputDirectory,
      run_id: "run-one",
      source: { kind: "project", root: "/project" },
      target: { endpoint_fingerprint: `sha256:${"0".repeat(32)}`, kind: "context", name: "remote_4090" },
      units: [{
        container_id: "4".repeat(64),
        container_name: "football",
        contains: [],
        id: "football-container",
        image_id: `sha256:${"4".repeat(64)}`,
        image_tag: "football:latest",
        kind: "container",
        runtime_instances: []
      }],
      version: "spawnfile.deployment.v2"
    });
    let dockerCalls = 0;

    await expect(downDeployment({
      compiledOutputDirectory: outputDirectory,
      deploymentName: "football",
      execFile: async () => { dockerCalls += 1; return { stderr: "", stdout: "" }; }
    })).rejects.toThrow("Unable to close organization handoff authority");

    expect(dockerCalls).toBe(0);
    await expect(authority.resolver.resolve({
      authorization: authorization(first.organization_handoff_handle)
    })).resolves.toBeTruthy();
    await expect(authority.resolver.resolve({
      authorization: authorization(second.organization_handoff_handle)
    })).resolves.toBeTruthy();
  });
});
