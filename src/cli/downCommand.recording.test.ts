import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeDeploymentRecord } from "../deployment/index.js";

import { createDownLifecyclePolicy } from "./downCommand.js";
import { runCli } from "./runCli.js";

const originalHome = process.env.SPAWNFILE_HOME;
let root = "";
const invocationId = "lci_recordedmemory0001";
const streams = () => {
  const stdout: string[] = [], stderr: string[] = [];
  return { stdout, stderr, value: { stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) } };
};
const receipt = { deployment: "recorded", errors: [], retained_volumes: [], units_stopped: ["organization"], version: "spawnfile.down-receipt.v1" as const };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-recording-cli-"));
  process.env.SPAWNFILE_HOME = path.join(root, "home");
  await writeDeploymentRecord(root, {
    auth_profile: null, compile_fingerprint: "sf1:recorded", created_at: "2026-10-11T00:00:00.000Z",
    manager: "docker", name: "recorded", output_directory: root, source: { kind: "project", root },
    target: { endpoint_fingerprint: `sha256:${"a".repeat(32)}`, kind: "context", name: "default" },
    units: [{ container_id: "container-123", container_name: "organization", contains: [], id: "organization",
      image_id: "image-123", image_tag: "image:latest", kind: "container", runtime_instances: [] }],
    version: "spawnfile.deployment.v2",
  });
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await rm(root, { force: true, recursive: true });
});

describe("down recorded memory override", () => {
  it("forwards the explicit flag and does not infer it from --force", async () => {
    const effect = vi.fn(async () => receipt);
    for (const override of [false, true]) {
      const output = streams();
      const code = await runCli(["down", root, "--compiled", root, "--deployment", "recorded", "--force", "--volumes", "--json",
        ...(override ? ["--discard-recorded-memory"] : [])], output.value, { downDeployment: effect });
      expect(code, output.stderr.join("\n")).toBe(0);
      expect(effect).toHaveBeenLastCalledWith(expect.objectContaining({
        discardRecordedMemory: override ? true : undefined, force: true, removeVolumes: true,
      }));
    }
  });

  it("preserves the old lifecycle policy bytes when the flag is omitted or false", () => {
    const original = { docker_command: null, export_to: null, force: false, reader_image: null, remove_volumes: false, timeout_ms: null };
    expect(createDownLifecyclePolicy({ deployment: "recorded" })).toEqual(original);
    expect(createDownLifecyclePolicy({ deployment: "recorded", discardRecordedMemory: false })).toEqual(original);
    expect(createDownLifecyclePolicy({ deployment: "recorded", discardRecordedMemory: true }))
      .toEqual({ discard_recorded_memory: true, ...original });
  });

  it("binds the override in lifecycle plans and refuses omission when executing that plan", async () => {
    const effect = vi.fn(async () => receipt);
    const planOutput = streams();
    const request = {
      compiled: root, deployment: "recorded", discard_recorded_memory: true, docker_command: null,
      export_to: null, force: true, lifecycle_invocation_id: invocationId, operation: "down", path: root,
      reader_image: null, remove_volumes: true, timeout_ms: null, version: "spawnfile.lifecycle-plan-request.v1",
    };
    const planCode = await runCli(["lifecycle", "plan", "--request", "-"], {
      handlers: { downDeployment: effect },
      stdin: (async function* () { yield JSON.stringify(request); })(),
      streams: planOutput.value,
    });
    expect(planCode, planOutput.stderr.join("\n")).toBe(0);
    expect(effect).not.toHaveBeenCalled();
    expect(JSON.parse(planOutput.stdout.join("\n")).request_policy.discard_recorded_memory).toBe(true);
    const base = ["down", root, "--compiled", root, "--deployment", "recorded", "--force", "--volumes", "--json", "--lifecycle-invocation", invocationId];
    const refused = streams();
    expect(await runCli(base, refused.value, { downDeployment: effect })).not.toBe(0);
    expect(refused.stderr.join("\n")).toContain("Lifecycle invocation id drift");
    expect(effect).not.toHaveBeenCalled();
    const accepted = streams();
    expect(await runCli([...base, "--discard-recorded-memory"], accepted.value, { downDeployment: effect }),
      accepted.stderr.join("\n")).toBe(0);
    expect(effect).toHaveBeenCalledOnce();
  });
});
