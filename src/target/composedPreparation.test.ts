import { describe, expect, it, vi } from "vitest";

import {
  createCanonicalTargetReceiptBytes,
  createTargetReceiptDigest,
  createTargetRequestDigest,
  parseOpaqueTargetHandle,
  parseSelectedTargetReceipt,
  type SelectedTargetReceipt,
  type TargetResourceRequest,
} from "./index.js";
import {
  createCanonicalComposedPreparationReceiptBytes,
  parseComposedPreparationReceipt,
  parseComposedPreparationRequest,
  prepareComposedRun,
  type ComposedPreparationHandlers,
  type ComposedPreparationMutationResult,
} from "./composedPreparation.js";

const sha = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const handle = (value: string) =>
  parseOpaqueTargetHandle(`opaque_${value.repeat(16).slice(0, 16)}`);
const selected: SelectedTargetReceipt = parseSelectedTargetReceipt({
  fingerprint: `sha256:${"b".repeat(32)}`,
  handle: handle("c"),
  version: "spawnfile.target-resource.selected-target.v1",
});
const request = {
  auth_profile: "profile-one",
  descriptor_digest: sha("d"),
  idempotency_key: "idem_prepare0000000000",
  organization: {
    artifact_digest: sha("e"),
    world_bindings_digest: sha("f"),
  },
  run_id: "run-one",
  secret_bindings: [{
    name: "world_bearer",
    scope: "world",
    source_handle: handle("g"),
  }],
  target_selector: "gpu-host",
  version: "spawnfile.composed-preparation.request.v1",
  world: {
    artifact_manifest_digest: sha("a"),
    bundle_digest: sha("1"),
  },
} as const;

const mutation = (
  operationRequest: Exclude<TargetResourceRequest, { operation: "select_target" }>,
): ComposedPreparationMutationResult => {
  const operationIndex: number | undefined = ({
    resolve_world_artifact: 1,
    prepare_secret_bindings: 2,
    create_data_network: 3,
    create_evidence_volume: 4,
  } as Partial<Record<TargetResourceRequest["operation"], number>>)[operationRequest.operation];
  if (operationIndex === undefined) throw new Error("unexpected operation");
  const body = {
    cleanup_state: "not_requested" as const,
    descriptor_digest: operationRequest.descriptor_digest,
    export_state: "not_requested" as const,
    labels: [],
    operation: operationRequest.operation,
    operation_handle: handle(String(operationIndex)),
    receipt_digest: sha("0"),
    request_digest: createTargetRequestDigest(operationRequest),
    result_handle: handle(String(operationIndex + 4)),
    resulting_revision: operationIndex,
    run_id: operationRequest.run_id,
    selected_target: operationRequest.selected_target,
    version: "spawnfile.target-resource.receipt.v1" as const,
  };
  const receipt = {
    ...body,
    receipt_digest: createTargetReceiptDigest(body),
  };
  return {
    receipt,
    receiptBytes: createCanonicalTargetReceiptBytes(receipt),
  };
};

const handlers = (calls: TargetResourceRequest[]): ComposedPreparationHandlers => ({
  select_target: vi.fn(async (value) => {
    calls.push(value);
    return selected;
  }),
  ...Object.fromEntries([
    "resolve_world_artifact",
    "prepare_secret_bindings",
    "create_data_network",
    "create_evidence_volume",
    "attach_organization",
    "cleanup_run",
    "create_world_service",
    "detach_organization",
    "export_evidence_volume",
    "recover_operation",
    "revoke_secret_bindings",
    "start_world_service",
    "stop_world_service",
  ].map((operation) => [operation, vi.fn(async (value: TargetResourceRequest) => {
    calls.push(value);
    return mutation(value as Exclude<TargetResourceRequest, { operation: "select_target" }>);
  })])),
} as unknown as ComposedPreparationHandlers);

describe("composed preparation", () => {
  it("prepares one fixed target-owned artifact/binding/resource sequence", async () => {
    const calls: TargetResourceRequest[] = [];
    const receipt = await prepareComposedRun(handlers(calls), request);
    expect(calls.map((value) => value.operation)).toEqual([
      "select_target",
      "resolve_world_artifact",
      "prepare_secret_bindings",
      "create_data_network",
      "create_evidence_volume",
    ]);
    expect(calls.slice(1).map((value) =>
      "expected_revision" in value ? value.expected_revision : null)).toEqual([0, 1, 2, 3]);
    expect(receipt).toMatchObject({
      auth_profile: "profile-one",
      run_id: "run-one",
      selected_target: selected,
      target_selector: "gpu-host",
    });
    expect(parseComposedPreparationReceipt(receipt)).toEqual(receipt);
    expect(JSON.parse(createCanonicalComposedPreparationReceiptBytes(receipt))).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toMatch(/B7_PRIVATE|target_config|credential_value/u);
  });

  it("retries with the exact same lower requests and receipt", async () => {
    const firstCalls: TargetResourceRequest[] = [];
    const secondCalls: TargetResourceRequest[] = [];
    const first = await prepareComposedRun(handlers(firstCalls), request);
    const second = await prepareComposedRun(handlers(secondCalls), request);
    expect(secondCalls).toEqual(firstCalls);
    expect(second).toEqual(first);
  });

  it("fails closed on malformed, secret-shaped, cross-run, or forged operation data", async () => {
    for (const invalid of [
      { ...request, token: "B7_PRIVATE" },
      { ...request, run_id: "../foreign" },
      { ...request, secret_bindings: [{ ...request.secret_bindings[0], source_handle: "token=B7_PRIVATE" }] },
    ]) expect(() => parseComposedPreparationRequest(invalid)).toThrow();

    const calls: TargetResourceRequest[] = [];
    const forged = handlers(calls);
    forged.resolve_world_artifact = vi.fn(async (value) => {
      const result = mutation(value);
      return {
        ...result,
        receipt: { ...(result.receipt as object), run_id: "run-foreign" },
      };
    });
    await expect(prepareComposedRun(forged, request)).rejects.toThrow(
      /operation receipt is invalid/u,
    );
  });
});
