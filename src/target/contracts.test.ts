import { describe, expect, it } from "vitest";

import {
  SELECTED_TARGET_VERSION,
  TARGET_EXPORT_INDEX_VERSION,
  TARGET_JOURNAL_VERSION,
  TARGET_OPERATION_LOOKUP_VERSION,
  TARGET_RESOURCE_RECEIPT_VERSION,
  TARGET_RESOURCE_REQUEST_VERSION,
  TARGET_TOPOLOGY_ATTESTATION_REQUEST_VERSION,
  TARGET_TOPOLOGY_RECEIPT_VERSION,
  MAX_JSON_GRAPH_DEPTH,
  MAX_JSON_GRAPH_KEYS,
  MAX_JSON_GRAPH_NODES,
  MAX_JSON_GRAPH_STRING_BYTES,
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseTargetOperationLookup,
  parseRunId,
  parseSelectedTargetReceipt,
  parseTargetResourceExportIndex,
  parseTargetResourceJournal,
  parseTargetResourceReceipt,
  parseTargetResourceRequest,
  parseTargetTopologyAttestationRequest,
  parseTargetTopologyReceipt
} from "./contracts.js";

const digest = `sha256:${"a".repeat(64)}`;
const fingerprint = `sha256:${"b".repeat(32)}`;
const runId = `run-${"c".repeat(32)}`;
const handle = (suffix: string) => `opaque_${suffix.padEnd(16, "a")}`;
const target = { fingerprint, handle: handle("target") };
const mutation = {
  descriptor_digest: digest,
  expected_revision: 4,
  idempotency_key: `idem_${"d".repeat(16)}`,
  run_id: runId,
  selected_target: target,
  version: TARGET_RESOURCE_REQUEST_VERSION
};

const requests = [
  { idempotency_key: mutation.idempotency_key, operation: "select_target", target_reference: "target_alpha", version: TARGET_RESOURCE_REQUEST_VERSION },
  { ...mutation, artifact_manifest_digest: digest, operation: "resolve_world_artifact" },
  { ...mutation, bindings: [{ name: "world", scope: "runtime", source_handle: handle("source") }], operation: "prepare_secret_bindings" },
  { ...mutation, operation: "create_data_network" },
  { ...mutation, operation: "create_evidence_volume" },
  { ...mutation, data_network_handle: handle("network"), operation: "attach_organization", organization_handoff_handle: handle("handoff") },
  { ...mutation, data_network_handle: handle("network"), evidence_mount_path: "/run/world/evidence", evidence_volume_handle: handle("evidence"), operation: "create_world_service", secret_bindings_handle: handle("secrets"), world_artifact_handle: handle("artifact") },
  { ...mutation, operation: "start_world_service", world_service_handle: handle("service") },
  { ...mutation, operation: "stop_world_service", world_service_handle: handle("service") },
  { ...mutation, data_network_handle: handle("network"), operation: "detach_organization", organization_attachment_handle: handle("attachment") },
  { ...mutation, evidence_volume_handle: handle("evidence"), operation: "export_evidence_volume" },
  { ...mutation, operation: "revoke_secret_bindings", secret_bindings_handle: handle("secrets") },
  { ...mutation, cleanup_policy: "preserve_evidence", evidence_volume_handle: handle("evidence"), operation: "cleanup_run", organization_attachment_handle: handle("attachment"), secret_bindings_handle: handle("secrets"), world_service_handle: handle("service") },
  { ...mutation, operation: "recover_operation", operation_handle: handle("operation") }
] as const;

describe("target-resource requests", () => {
  it("exact-parses and round-trips every legal operation", () => {
    for (const request of requests) {
      expect(parseTargetResourceRequest(request)).toEqual(request);
      expect(JSON.parse(JSON.stringify(parseTargetResourceRequest(request)))).toEqual(request);
    }
  });

  it("requires the operation-specific prior opaque handles", () => {
    const handleFields: Record<string, string[]> = {
      attach_organization: ["data_network_handle", "organization_handoff_handle"],
      create_world_service: ["data_network_handle", "evidence_volume_handle", "secret_bindings_handle", "world_artifact_handle"],
      start_world_service: ["world_service_handle"], stop_world_service: ["world_service_handle"],
      detach_organization: ["data_network_handle", "organization_attachment_handle"],
      export_evidence_volume: ["evidence_volume_handle"], revoke_secret_bindings: ["secret_bindings_handle"],
      recover_operation: ["operation_handle"]
    };
    for (const request of requests) for (const field of handleFields[request.operation] ?? []) {
      const broken = { ...request } as Record<string, unknown>;
      delete broken[field];
      expect(() => parseTargetResourceRequest(broken)).toThrow();
      expect(() => parseTargetResourceRequest({ ...request, [field]: "container-id" })).toThrow();
    }
    const secretRequest = requests.find(({ operation }) => operation === "prepare_secret_bindings")!;
    expect(() => parseTargetResourceRequest({ ...secretRequest, bindings: [{ name: "world", scope: "runtime" }] })).toThrow();
    expect(() => parseTargetResourceRequest({ ...secretRequest, bindings: [{ name: "world", scope: "runtime", source_handle: "container-id" }] })).toThrow();
    const cleanupRequest = requests.find(({ operation }) => operation === "cleanup_run")!;
    for (const field of ["evidence_volume_handle", "organization_attachment_handle", "secret_bindings_handle", "world_service_handle"]) {
      expect(() => parseTargetResourceRequest({ ...cleanupRequest, [field]: "container-id" })).toThrow();
    }
  });

  it("rejects hostile, malformed, unknown, and prototype-bearing requests", () => {
    const request = requests[1];
    for (const key of ["endpoint", "context", "path", "error", "container_id", "secret", "token", "env", "identity", "topology", "argv", "port", "url", "provider_payload", "runtime_payload"]) {
      expect(() => parseTargetResourceRequest({ ...request, [key]: "sentinel" })).toThrow();
    }
    expect(() => parseTargetResourceRequest({ ...request, run_id: "bad run" })).toThrow();
    expect(() => parseTargetResourceRequest({ ...requests[0], target_reference: `a${"a".repeat(64)}` })).toThrow();
    expect(() => parseTargetResourceRequest({ ...request, descriptor_digest: "sha256:ABC" })).toThrow();
    expect(() => parseTargetResourceRequest({ ...request, expected_revision: -1 })).toThrow();
    expect(() => parseTargetResourceRequest({ ...request, expected_revision: 2_147_483_648 })).toThrow();
    expect(() => parseTargetResourceRequest({ ...request, operation: "unknown" })).toThrow();
    expect(() => parseTargetResourceRequest({ ...request, version: "spawnfile.target-resource.request.v2" })).toThrow();
    expect(() => parseTargetResourceRequest(Object.assign(Object.create({}), request))).toThrow();
    const world = requests.find((value) => value.operation === "create_world_service")!;
    for (const evidence_mount_path of [
      "/run/spawnfile-secrets", "/run/spawnfile-secrets/nested", "/run", "/etc/evidence",
      "/run/world/../evidence", "/run/world,evidence"
    ]) expect(() => parseTargetResourceRequest({ ...world, evidence_mount_path })).toThrow();
  });

  it("accepts repository-compatible bounded run ids and rejects hostile variants", () => {
    for (const compatibleRunId of [runId, "run-abc123", "run-from-host", "RUN.Host_1:West", "a", "Z".repeat(128)]) {
      expect(parseTargetResourceRequest({ ...requests[1], run_id: compatibleRunId })).toMatchObject({ run_id: compatibleRunId });
    }
    for (const hostileRunId of ["", "-run", "a".repeat(129), "réunion", "run id", "run/id"]) {
      expect(() => parseTargetResourceRequest({ ...requests[1], run_id: hostileRunId })).toThrow();
    }
  });

  it("exports the exact compile-compatible run-id parser", () => {
    for (const legal of [runId, "run-from-host", "RUN.Host_1:West", "A".repeat(128)]) {
      expect(parseRunId(legal)).toBe(legal);
    }
    for (const illegal of ["A".repeat(129), "run id", "run/id", "été"]) expect(() => parseRunId(illegal)).toThrow();
  });
});

describe("target-resource opaque handles", () => {
  it("exports the one canonical bounded opaque-handle parser", () => {
    for (const legal of [handle("a"), `opaque_${"a".repeat(64)}`]) expect(parseOpaqueTargetHandle(legal)).toBe(legal);
    for (const hostile of ["opaque_short", "opaque_ABCDEFabcdef1234", "opaque-a".repeat(16), `opaque_${"a".repeat(65)}`]) {
      expect(() => parseOpaqueTargetHandle(hostile)).toThrow();
    }
  });
});

describe("target-resource public receipts", () => {
  const receipt = {
    cleanup_state: "not_requested", descriptor_digest: digest, export_state: "not_requested",
    labels: [{ key: "run", value: "target_alpha" }], operation: "create_data_network",
    operation_handle: handle("operation"), receipt_digest: digest, request_digest: digest,
    result_handle: handle("network"), resulting_revision: 5, run_id: runId,
    selected_target: target, version: TARGET_RESOURCE_RECEIPT_VERSION
  } as const;

  it("accepts bounded receipt state and serializes exactly without private data", () => {
    const parsed = parseTargetResourceReceipt(receipt);
    expect(parsed).toEqual(receipt);
    expect(JSON.stringify(parsed)).toBe(`{"cleanup_state":"not_requested","descriptor_digest":"${digest}","export_state":"not_requested","labels":[{"key":"run","value":"target_alpha"}],"operation":"create_data_network","operation_handle":"${handle("operation")}","receipt_digest":"${digest}","request_digest":"${digest}","result_handle":"${handle("network")}","resulting_revision":5,"run_id":"${runId}","selected_target":{"fingerprint":"${fingerprint}","handle":"${handle("target")}"},"version":"${TARGET_RESOURCE_RECEIPT_VERSION}"}`);
  });

  it("rejects forbidden receipt additions, invalid selection correlation, and prototype keys", () => {
    for (const key of ["endpoint", "context", "path", "error", "container", "secret", "token", "env", "identity", "topology", "resource_map"]) {
      expect(() => parseTargetResourceReceipt({ ...receipt, [key]: "sentinel" })).toThrow();
    }
    expect(() => parseTargetResourceReceipt({ ...receipt, operation: "select_target" })).toThrow();
    expect(() => parseTargetResourceReceipt(Object.assign(Object.create({ inherited: true }), receipt))).toThrow();
  });
});

describe("target topology-attestation contracts", () => {
  const complete = (suffix: string) => ({
    operation_handle: handle(`op${suffix}`),
    request_digest: `sha256:${suffix.repeat(64).slice(0, 64)}`,
    result_handle: handle(`res${suffix}`)
  });
  const request = {
    data_network: complete("c"),
    descriptor_digest: digest,
    organization_attachment: complete("d"),
    run_id: runId,
    selected_target: target,
    version: TARGET_TOPOLOGY_ATTESTATION_REQUEST_VERSION,
    world_service: {
      create: complete("e"),
      start: {
        operation_handle: handle("opf"),
        request_digest: `sha256:${"f".repeat(64)}`,
        result_handle: handle("rese")
      }
    }
  } as const;
  const receipt = {
    descriptor_digest: digest,
    handoff_scope: "organization_to_private_service",
    organization: { data_network_attachment: "exact", egress_policy: "egress_only" },
    receipt_digest: digest,
    request_digest: `sha256:${"f".repeat(64)}`,
    run_id: runId,
    selected_target: target,
    service_discovery: "dns_only",
    version: TARGET_TOPOLOGY_RECEIPT_VERSION,
    world_network: "private_internal",
    world_service: {
      data_network_attachment: "exactly_one", egress_policy: "none", published_ports: "none"
    }
  } as const;

  it("uses exact opaque completed-operation correlation and semantic-only receipt facts", () => {
    expect(parseTargetTopologyAttestationRequest(request)).toEqual(request);
    expect(parseTargetTopologyReceipt(receipt)).toEqual(receipt);
  });

  it("rejects handle aliasing, mismatched start result, extra fields, and private leakage", () => {
    for (const hostile of [
      { ...request, data_network: { ...request.data_network, result_handle: request.organization_attachment.result_handle } },
      { ...request, organization_attachment: { ...request.organization_attachment, operation_handle: request.data_network.operation_handle } },
      { ...request, world_service: { ...request.world_service, start: { ...request.world_service.start, result_handle: handle("other") } } },
      { ...request, endpoint: "ssh://private" },
      { ...request, organization_attachment: { ...request.organization_attachment, container_id: "private" } }
    ]) expect(() => parseTargetTopologyAttestationRequest(hostile)).toThrow();
    for (const field of ["context", "container_id", "network_name", "endpoint", "path", "url", "ports", "raw_inspect", "token"]) {
      expect(() => parseTargetTopologyReceipt({ ...receipt, [field]: "private" })).toThrow();
    }
  });
});

describe("target-operation lookup", () => {
  const base = {
    idempotency_key: mutation.idempotency_key,
    operation: "create_data_network",
    request_digest: digest,
    version: TARGET_OPERATION_LOOKUP_VERSION
  } as const;
  const receipt = {
    cleanup_state: "not_requested", descriptor_digest: digest, export_state: "not_requested",
    labels: [], operation: base.operation, operation_handle: handle("operation"),
    receipt_digest: digest, request_digest: digest, result_handle: handle("network"),
    resulting_revision: 5, run_id: runId, selected_target: target,
    version: TARGET_RESOURCE_RECEIPT_VERSION
  } as const;

  it("strictly distinguishes not-applied, pending, and completed results", () => {
    expect(parseTargetOperationLookup({ ...base, status: "not_applied" }).status).toBe("not_applied");
    expect(parseTargetOperationLookup({
      ...base, operation_handle: handle("operation"), status: "pending"
    }).status).toBe("pending");
    expect(parseTargetOperationLookup({
      ...base, operation_handle: handle("operation"), receipt, status: "completed"
    }).status).toBe("completed");
  });

  it("excludes selection and rejects additions or receipt-correlation drift", () => {
    expect(() => parseTargetOperationLookup({
      ...base, operation: "select_target", status: "not_applied"
    })).toThrow();
    expect(() => parseTargetOperationLookup({
      ...base, path: "/private", status: "not_applied"
    })).toThrow();
    expect(() => parseTargetOperationLookup({
      ...base, operation_handle: handle("other"), receipt, status: "completed"
    })).toThrow();
    expect(() => parseTargetOperationLookup({
      ...base, operation_handle: handle("operation"),
      receipt: { ...receipt, request_digest: `sha256:${"0".repeat(64)}` },
      status: "completed"
    })).toThrow();
  });
});

describe("target-resource supporting contracts", () => {
  const index = {
    evidence_digest: digest, export_handle: handle("export"), files: [], item_count: 0,
    labels: [], run_id: runId,
    source: { evidence_volume_handle: handle("evidence"), state: "preserved" },
    state: "exported", version: TARGET_EXPORT_INDEX_VERSION
  } as const;
  it("parses selected targets, journal projections, and export indexes", () => {
    expect(parseSelectedTargetReceipt({ fingerprint, handle: handle("target"), version: SELECTED_TARGET_VERSION })).toEqual({ fingerprint, handle: handle("target"), version: SELECTED_TARGET_VERSION });
    expect(parseTargetResourceJournal({ descriptor_digest: digest, entries: [{ operation: "create_data_network", operation_handle: handle("operation"), receipt_digest: digest, request_digest: digest, state: "completed" }], revision: 5, run_id: runId, selected_target: target, version: TARGET_JOURNAL_VERSION }).revision).toBe(5);
    expect(parseTargetResourceExportIndex(index).state).toBe("exported");
  });

  it("rejects journal resource maps and unsafe fields from every public supporting contract", () => {
    const selected = { fingerprint, handle: handle("target"), version: SELECTED_TARGET_VERSION };
    const journal = { descriptor_digest: digest, entries: [], revision: 0, run_id: runId, selected_target: target, version: TARGET_JOURNAL_VERSION };
    for (const key of ["unknown_field", "resource_map", "endpoint", "context", "path", "error", "secret", "token", "identity", "topology"]) {
      expect(() => parseSelectedTargetReceipt({ ...selected, [key]: "sentinel" })).toThrow();
      expect(() => parseTargetResourceJournal({ ...journal, [key]: "sentinel" })).toThrow();
      expect(() => parseTargetResourceExportIndex({ ...index, [key]: "sentinel" })).toThrow();
    }
  });
});

describe("target-resource raw graph guard", () => {
  const receipt = {
    cleanup_state: "not_requested", descriptor_digest: digest, export_state: "not_requested", labels: [], operation: "create_data_network",
    operation_handle: handle("operation"), receipt_digest: digest, request_digest: digest, result_handle: handle("network"), resulting_revision: 1,
    run_id: runId, selected_target: target, version: TARGET_RESOURCE_RECEIPT_VERSION
  };
  const selected = { fingerprint, handle: handle("target"), version: SELECTED_TARGET_VERSION };
  const journal = { descriptor_digest: digest, entries: [], revision: 0, run_id: runId, selected_target: target, version: TARGET_JOURNAL_VERSION };
  const index = { evidence_digest: digest, export_handle: handle("export"), files: [], item_count: 0, labels: [], run_id: runId, source: { evidence_volume_handle: handle("evidence"), state: "preserved" }, state: "exported", version: TARGET_EXPORT_INDEX_VERSION };
  const parsers = [
    [parseTargetResourceRequest, requests[1]], [parseTargetResourceReceipt, receipt], [parseSelectedTargetReceipt, selected],
    [parseTargetResourceJournal, journal], [parseTargetResourceExportIndex, index]
  ] as const;

  it("rejects custom prototypes, symbol keys, non-enumerable extras, and accessors before parsing", () => {
    for (const [parse, valid] of parsers) {
      const customPrototype = Object.assign(Object.create({}), valid);
      expect(() => parse(customPrototype)).toThrow();
      const symbolKey = { ...valid, [Symbol("hostile")]: true };
      expect(() => parse(symbolKey)).toThrow();
      const hidden = { ...valid };
      Object.defineProperty(hidden, "unknown_field", { configurable: true, enumerable: false, value: true, writable: true });
      expect(() => parse(hidden)).toThrow();
      let getterCalls = 0;
      const getter = { ...valid };
      Object.defineProperty(getter, "version", { configurable: true, enumerable: true, get: () => { getterCalls += 1; return valid.version; } });
      expect(() => parse(getter)).toThrow();
      expect(getterCalls).toBe(0);
    }
  });

  it("rejects nested objects and arrays with custom prototypes without reading hostile values", () => {
    const nested = { ...requests[1], selected_target: Object.assign(Object.create({}), target) };
    expect(() => parseTargetResourceRequest(nested)).toThrow();
    const bindings = [{ name: "world", scope: "runtime", source_handle: handle("source") }];
    Object.setPrototypeOf(bindings, {});
    expect(() => parseTargetResourceRequest({ ...requests[2], bindings })).toThrow();
  });

  it("rejects proxies without invoking traps and always reports one safe error", () => {
    let traps = 0;
    const proxy = new Proxy({ ...requests[1] }, {
      getOwnPropertyDescriptor: () => { traps += 1; throw new Error("trap"); },
      getPrototypeOf: () => { traps += 1; throw new Error("trap"); },
      ownKeys: () => { traps += 1; throw new Error("trap"); }
    });
    expect(() => parseTargetResourceRequest(proxy)).toThrow(new TypeError("invalid JSON-like graph"));
    expect(traps).toBe(0);
  });

  it("enforces graph depth, node, width, and aggregate string budgets", () => {
    let deep: unknown = null;
    for (let index = 0; index <= MAX_JSON_GRAPH_DEPTH + 1; index += 1) deep = { child: deep };
    expect(() => assertOrdinaryJsonGraph(deep)).toThrow(new TypeError("invalid JSON-like graph"));

    const wide = Object.fromEntries(Array.from({ length: MAX_JSON_GRAPH_KEYS + 1 }, (_, index) => [`field${index}`, null]));
    expect(() => assertOrdinaryJsonGraph(wide)).toThrow(new TypeError("invalid JSON-like graph"));

    const nodes = Array.from({ length: 128 }, () => Array.from({ length: 7 }, () => ({})));
    expect(1 + nodes.length + nodes.length * 7).toBe(MAX_JSON_GRAPH_NODES + 1);
    expect(() => assertOrdinaryJsonGraph(nodes)).toThrow(new TypeError("invalid JSON-like graph"));
    expect(() => assertOrdinaryJsonGraph("a".repeat(MAX_JSON_GRAPH_STRING_BYTES + 1))).toThrow(new TypeError("invalid JSON-like graph"));
  });

  it("accepts deeply frozen ordinary JSON data without invoking getters", () => {
    const frozen = Object.freeze({
      nested: Object.freeze({ values: Object.freeze(["one", Object.freeze({ two: true })]) })
    });
    expect(() => assertOrdinaryJsonGraph(frozen)).not.toThrow();
    let calls = 0;
    const getter = {};
    Object.defineProperty(getter, "value", { enumerable: true, get: () => { calls += 1; return "never"; } });
    expect(() => assertOrdinaryJsonGraph(getter)).toThrow(new TypeError("invalid JSON-like graph"));
    expect(calls).toBe(0);
  });
});
