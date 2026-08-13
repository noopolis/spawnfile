import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCanonicalTargetWorldReadinessReceiptBytes,
  createTargetWorldReadinessReceipt,
  parseTargetWorldReadinessRequest,
  type TargetWorldReadinessRequest
} from "../target/worldReadiness.js";
import { registerTargetWorldReadinessCommand } from "./targetWorldReadinessCommand.js";

const roots: string[] = [];
const d = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const request = parseTargetWorldReadinessRequest({
  descriptor_digest: d("a"),
  endpoint: { internal_port: 4_070, path: "/v1/world/readiness" },
  expected: {
    artifact_digest: d("b"), bundle_digest: d("c"),
    capability_manifest_digests: [d("d")],
    document_version: "simfile.world-sidecar-readiness.v1",
    mechanics_sha256: d("f"), normalized_checkpoint_sha256: d("0"),
    runtime_abi: "simfile.world-sidecar-runtime.v1",
    world_instance_id: "run-simfile-world"
  },
  run_id: "run-simfile",
  selected_target: {
    fingerprint: `sha256:${"e".repeat(32)}`,
    handle: "opaque_1111111111111111"
  },
  version: "spawnfile.target-world-readiness.request.v1",
  world_service_handle: "opaque_2222222222222222"
});
const document = {
  artifact_digest: d("b"), bundle_digest: d("c"),
  capability_manifest_digests: [d("d")],
  clock: { next_tick: 0, state: "paused" },
  decisions: { count: 0, phase: "open" },
  mechanics_sha256: d("f"), normalized_checkpoint_sha256: d("0"),
  run_id: "run-simfile", runtime_abi: "simfile.world-sidecar-runtime.v1",
  status: "ready", version: "simfile.world-sidecar-readiness.v1",
  world_instance_id: "run-simfile-world"
} as const;
const receipt = createTargetWorldReadinessReceipt({ document, request });

const requestFile = async (value: unknown): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-readiness-cli-"));
  roots.push(root);
  const file = path.join(root, "request.json");
  await writeFile(file, JSON.stringify(value));
  return file;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })));
});

describe("target world readiness command", () => {
  it("routes the exact Simfile endpoint request and emits one truthful canonical receipt", async () => {
    const seen: TargetWorldReadinessRequest[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: number[] = [];
    const program = new Command();
    program.exitOverride();
    const target = program.command("target");
    registerTargetWorldReadinessCommand(target, {
      queryWorldReadiness: async (input) => {
        seen.push(input);
        return receipt;
      }
    }, {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message)
    }, (code) => exits.push(code));
    await program.parseAsync([
      "target", "query_world_readiness", await requestFile(request)
    ], { from: "user" });
    expect(seen).toEqual([request]);
    expect(stdout).toEqual([createCanonicalTargetWorldReadinessReceiptBytes(receipt)]);
    expect(stderr).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("rejects hostile request additions before invoking the query", async () => {
    const calls: number[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const program = new Command(); program.exitOverride();
    const target = program.command("target");
    registerTargetWorldReadinessCommand(target, {
      queryWorldReadiness: async () => { calls.push(1); return receipt; }
    }, { stderr: (message) => errors.push(message), stdout: () => undefined },
    (code) => exits.push(code));
    await program.parseAsync([
      "target", "query_world_readiness",
      await requestFile({ ...request, organization: { room: "private" } })
    ], { from: "user" });
    expect(calls).toEqual([]);
    expect(errors).toEqual(["error: Invalid world readiness request"]);
    expect(exits).toEqual([2]);
  });

  it("refuses to emit a stale or forged handler receipt", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const program = new Command(); program.exitOverride();
    const target = program.command("target");
    registerTargetWorldReadinessCommand(target, {
      queryWorldReadiness: async () => ({
        ...receipt,
        request_digest: d("9")
      })
    }, { stderr: (message) => errors.push(message), stdout: (message) => output.push(message) },
    (code) => exits.push(code));
    await program.parseAsync([
      "target", "query_world_readiness", await requestFile(request)
    ], { from: "user" });
    expect(output).toEqual([]);
    expect(errors).toEqual(["error: Target world readiness query crashed"]);
    expect(exits).toEqual([1]);
  });
});
