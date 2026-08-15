import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCanonicalTargetReceiptBytes,
  createTargetReceiptDigest,
  createTargetRequestDigest,
  parseOpaqueTargetHandle,
  parseSelectedTargetReceipt,
  parseComposedPreparationReceipt,
  type TargetResourceRequest,
} from "../target/index.js";
import {
  registerTargetCommands,
  type TargetCommandHandlerSession,
  type TargetCommandHandlers,
} from "./targetCommands.js";

const roots: string[] = [];
const sha = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const opaque = (value: string) =>
  parseOpaqueTargetHandle(`opaque_${value.repeat(16).slice(0, 16)}`);
const selected = parseSelectedTargetReceipt({
  fingerprint: `sha256:${"b".repeat(32)}`,
  handle: opaque("c"),
  version: "spawnfile.target-resource.selected-target.v1",
});
const request = {
  auth_profile: "profile-one",
  descriptor_digest: sha("d"),
  idempotency_key: "idem_prepare0000000000",
  organization: { artifact_digest: sha("e"), world_bindings_digest: sha("f") },
  run_id: "run-one",
  secret_bindings: [{ name: "world_bearer", scope: "world", source_handle: opaque("a") }],
  target_selector: "gpu-host",
  version: "spawnfile.composed-preparation.request.v1",
  world: { artifact_manifest_digest: sha("1"), bundle_digest: sha("2") },
} as const;

const fileFor = async (value: unknown): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-composed-prepare-command-"));
  roots.push(root);
  const file = path.join(root, "request.json");
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
};

const resultFor = (requestValue: Exclude<TargetResourceRequest, { operation: "select_target" }>) => {
  const revisions: Partial<Record<TargetResourceRequest["operation"], number>> = {
    resolve_world_artifact: 1,
    prepare_secret_bindings: 2,
    create_data_network: 3,
    create_evidence_volume: 4,
  };
  const revision = revisions[requestValue.operation];
  if (revision === undefined) throw new Error("unexpected operation");
  const body = {
    cleanup_state: "not_requested" as const,
    descriptor_digest: requestValue.descriptor_digest,
    export_state: "not_requested" as const,
    labels: [],
    operation: requestValue.operation,
    operation_handle: opaque(String(revision)),
    receipt_digest: sha("0"),
    request_digest: createTargetRequestDigest(requestValue),
    result_handle: opaque(String(revision + 4)),
    resulting_revision: revision,
    run_id: requestValue.run_id,
    selected_target: requestValue.selected_target,
    version: "spawnfile.target-resource.receipt.v1" as const,
  };
  const receipt = { ...body, receipt_digest: createTargetReceiptDigest(body) };
  return { receipt, receiptBytes: createCanonicalTargetReceiptBytes(receipt) };
};

const handlers = (failure?: string): TargetCommandHandlers => Object.fromEntries([
  "select_target", "resolve_world_artifact", "prepare_secret_bindings",
  "create_data_network", "create_evidence_volume", "attach_organization",
  "cleanup_run", "create_world_service", "detach_organization",
  "export_evidence_volume", "recover_operation", "revoke_secret_bindings",
  "start_world_service", "stop_world_service",
].map((operation) => [operation, vi.fn(async (value: TargetResourceRequest) => {
  if (failure && operation === "prepare_secret_bindings") throw new Error(failure);
  return operation === "select_target"
    ? selected
    : resultFor(value as Exclude<TargetResourceRequest, { operation: "select_target" }>);
})])) as unknown as TargetCommandHandlers;

const invoke = async (raw: unknown, failure?: string) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const configInputs: unknown[] = [];
  const program = new Command();
  program.exitOverride();
  registerTargetCommands(program, async (configInput) => {
    configInputs.push(configInput);
    return Object.freeze({
      run: async <Result>(call: (value: TargetCommandHandlers) => Promise<Result>) =>
        call(handlers(failure)),
    }) as TargetCommandHandlerSession;
  }, {
    stderr: (message) => stderr.push(message),
    stdout: (message) => stdout.push(message),
  }, (code) => exits.push(code));
  const requestFile = await fileFor(raw);
  await program.parseAsync([
    "target", "--config", "-", "prepare_composed_run", requestFile,
  ], { from: "user" });
  return { configInputs, exits, stderr, stdout };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("target prepare_composed_run command", () => {
  it("accepts only the exact target/config/request argv and emits one receipt", async () => {
    const result = await invoke(request);
    expect(result.configInputs).toEqual(["-"]);
    expect(result.exits).toEqual([]);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toHaveLength(1);
    expect(parseComposedPreparationReceipt(JSON.parse(result.stdout[0]!))).toMatchObject({
      run_id: "run-one",
      target_selector: "gpu-host",
    });
  });

  it("validates before config and redacts private operation failures", async () => {
    const invalid = await invoke({ ...request, private_config: "B7_PRIVATE_CONFIG" });
    expect(invalid).toEqual({
      configInputs: [],
      exits: [2],
      stderr: ["error: Invalid composed preparation request"],
      stdout: [],
    });
    const failed = await invoke(request, "B7_PRIVATE_CONFIG token=password");
    expect(failed).toEqual({
      configInputs: ["-"],
      exits: [1],
      stderr: ["error: Composed preparation crashed"],
      stdout: [],
    });
  });
});
