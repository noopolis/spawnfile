import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCanonicalSelectedTargetReceiptBytes,
  createCanonicalTargetOperationLookupBytes,
  createCanonicalTargetReceiptBytes,
  createCanonicalTargetTopologyReceiptBytes,
  createCanonicalTargetPublicArtifactSnapshotBytes,
  createTargetPublicArtifactSnapshot,
  createCanonicalTargetTopologyActivationReceiptBytes,
  createTargetReceiptDigest,
  createTargetRequestDigest,
  createTargetTopologyActivationReceiptDigest,
  createTargetTopologyReceiptDigest,
  parseTargetTopologyActivationReceipt,
  parseTargetOperationLookup,
  parseTargetPublicArtifactSnapshotRequest,
  parseTargetTopologyReceipt,
  type TargetMutationRequest,
  type TargetOperationLookup,
  type TargetResourceRequest,
  type TargetTopologyAttestationRequest
} from "../target/index.js";
import type {
  TargetPublicArtifactSnapshotRequest
} from "../target/publicArtifactSnapshot.js";
import {
  createCanonicalTargetWorldClockReceiptBytes,
  createTargetWorldClockReceipt,
  parseTargetWorldClockRequest,
  type TargetWorldClockRequest,
} from "../target/worldClock.js";
import {
  createProductionTargetCommandSession,
  registerTargetCommands,
  type TargetCommandHandlerSession,
  type TargetCommandHandlers
} from "./targetCommands.js";
import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import {
  TARGET_OPERATION_DISPATCH,
  type TargetOperation
} from "./targetOperationDispatch.js";
import { SpawnfileError } from "../shared/index.js";

const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
const selectedTarget = {
  fingerprint: `sha256:${"b".repeat(32)}`,
  handle: "opaque_cccccccccccccccc"
};
const selectedReceipt = {
  ...selectedTarget,
  version: "spawnfile.target-resource.selected-target.v1"
} as const;
const envelope = {
  descriptor_digest: digest,
  expected_revision: 0,
  idempotency_key: "idem_aaaaaaaaaaaaaaaa",
  run_id: "run-one",
  selected_target: selectedTarget,
  version: "spawnfile.target-resource.request.v1"
} as const;

const requestFor = (operation: TargetOperation): TargetResourceRequest => {
  const extras: Partial<Record<TargetOperation, Record<string, unknown>>> = {
    attach_organization: {
      data_network_handle: "opaque_dddddddddddddddd",
      organization_handoff_handle: "opaque_eeeeeeeeeeeeeeee"
    },
    cleanup_run: { cleanup_policy: "remove" },
    create_world_service: {
      data_network_handle: "opaque_dddddddddddddddd",
      evidence_mount_path: "/run/world/evidence",
      evidence_volume_handle: "opaque_eeeeeeeeeeeeeeee",
      secret_bindings_handle: "opaque_ffffffffffffffff",
      world_artifact_handle: "opaque_gggggggggggggggg"
    },
    detach_organization: {
      data_network_handle: "opaque_dddddddddddddddd",
      organization_attachment_handle: "opaque_eeeeeeeeeeeeeeee"
    },
    export_evidence_volume: { evidence_volume_handle: "opaque_dddddddddddddddd" },
    prepare_secret_bindings: {
      bindings: [{
        name: "model_key",
        scope: "world",
        source_handle: "opaque_dddddddddddddddd"
      }]
    },
    recover_operation: { operation_handle: "opaque_dddddddddddddddd" },
    resolve_world_artifact: { artifact_manifest_digest: digest },
    revoke_secret_bindings: { secret_bindings_handle: "opaque_dddddddddddddddd" },
    start_world_service: { world_service_handle: "opaque_dddddddddddddddd" },
    stop_world_service: { world_service_handle: "opaque_dddddddddddddddd" }
  };
  if (operation === "select_target") {
    return {
      idempotency_key: envelope.idempotency_key,
      operation,
      target_reference: "gpu-host",
      version: envelope.version
    };
  }
  return { ...envelope, ...extras[operation], operation } as TargetResourceRequest;
};

const mutationResult = (operation: Exclude<TargetOperation, "select_target">) => {
  const exportHandle = "opaque_eeeeeeeeeeeeeeee";
  const evidenceIndex = {
    evidence_digest: digest,
    export_handle: exportHandle,
    files: [{ bytes: 1, path: "actions/log.jsonl", sha256: digest }],
    item_count: 1,
    labels: [],
    run_id: "run-one",
    source: { evidence_volume_handle: "opaque_dddddddddddddddd", state: "preserved" as const },
    state: "exported" as const,
    version: "spawnfile.target-resource.export-index.v1" as const,
  };
  const body = {
    cleanup_state: "not_requested",
    descriptor_digest: digest,
    ...(operation === "export_evidence_volume" ? { evidence_index: evidenceIndex } : {}),
    export_state: operation === "export_evidence_volume" ? "exported" as const : "not_requested" as const,
    labels: [],
    operation,
    operation_handle: "opaque_dddddddddddddddd",
    request_digest: digest,
    result_handle: operation === "export_evidence_volume" ? exportHandle : null,
    resulting_revision: 1,
    run_id: "run-one",
    selected_target: selectedTarget,
    version: "spawnfile.target-resource.receipt.v1"
  } as const;
  const receipt = {
    ...body,
    receipt_digest: createTargetReceiptDigest({ ...body, receipt_digest: digest })
  };
  return { receipt, receiptBytes: createCanonicalTargetReceiptBytes(receipt) };
};

const requestFile = async (request: unknown): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-command-"));
  roots.push(root);
  const file = path.join(root, "request.json");
  await writeFile(file, JSON.stringify(request));
  return file;
};

const topologyRequest = {
  data_network: { operation_handle: "opaque_1111111111111111", request_digest: `sha256:${"1".repeat(64)}`, result_handle: "opaque_2222222222222222" },
  descriptor_digest: digest,
  organization_attachment: { operation_handle: "opaque_3333333333333333", request_digest: `sha256:${"2".repeat(64)}`, result_handle: "opaque_4444444444444444" },
  run_id: "run-one",
  selected_target: selectedTarget,
  version: "spawnfile.target-topology-attestation.request.v1",
  world_service: {
    create: { operation_handle: "opaque_5555555555555555", request_digest: `sha256:${"3".repeat(64)}`, result_handle: "opaque_6666666666666666" },
    start: { operation_handle: "opaque_7777777777777777", request_digest: `sha256:${"4".repeat(64)}`, result_handle: "opaque_6666666666666666" }
  }
};
const topologyBody = {
  descriptor_digest: digest, handoff_scope: "organization_to_private_service" as const,
  organization: { data_network_attachment: "exact" as const, egress_policy: "egress_only" as const },
  receipt_digest: digest, request_digest: `sha256:${"5".repeat(64)}`, run_id: "run-one",
  selected_target: selectedTarget, service_discovery: "dns_only" as const,
  version: "spawnfile.target-topology-receipt.v1" as const, world_network: "private_internal" as const,
  world_service: { data_network_attachment: "exactly_one" as const, egress_policy: "none" as const, published_ports: "none" as const }
};
const topologyReceipt = parseTargetTopologyReceipt({
  ...topologyBody,
  receipt_digest: createTargetTopologyReceiptDigest(topologyBody)
});
const publicArtifactRequest = parseTargetPublicArtifactSnapshotRequest({
  artifact: {
    id: "viewer_trace",
    max_bytes: 4_096,
    media_type: "application/json",
    path: "/tmp/spawnfile-public/viewer-trace.json"
  },
  descriptor_digest: digest,
  run_id: "run-one",
  selected_target: selectedTarget,
  version: "spawnfile.target-public-artifact-snapshot.request.v1",
  world_service_handle: "opaque_6666666666666666"
});
const publicArtifactSnapshot = createTargetPublicArtifactSnapshot({
  content: Buffer.from("{\"tick\":1}"),
  request: publicArtifactRequest
});
const worldClockRequest = parseTargetWorldClockRequest({
  activation_digest: `sha256:${"1".repeat(64)}`,
  activation_receipt_digest: `sha256:${"2".repeat(64)}`,
  descriptor_digest: digest,
  endpoint: { internal_port: 4_070, path: "/v1/world/clock" },
  expected: { document_version: "world.clock-document.v1", world_instance_id: "world-one" },
  run_id: "run-one", selected_target: selectedTarget,
  topology_receipt_digest: `sha256:${"3".repeat(64)}`,
  topology_request_digest: `sha256:${"4".repeat(64)}`,
  version: "spawnfile.target-world-clock.request.v1",
  world_service_handle: "opaque_6666666666666666",
});
const worldClockReceipt = createTargetWorldClockReceipt({ request: worldClockRequest, observation: {
  action_count: 0, clock: { completed_tick: 1, next_tick: 2, state: "running" },
  run_id: "run-one", version: "world.clock-document.v1", world_instance_id: "world-one",
} });
const activationBody = {
  activation_digest: `sha256:${"6".repeat(64)}`,
  bundle_digest: `sha256:${"7".repeat(64)}`,
  receipt_digest: digest,
  run_id: "run-one",
  state: "activated" as const,
  topology_receipt_digest: topologyReceipt.receipt_digest,
  topology_request_digest: topologyReceipt.request_digest,
  version: "spawnfile.target-topology-activation-receipt.v1" as const
};
const activationReceipt = parseTargetTopologyActivationReceipt({
  ...activationBody,
  receipt_digest: createTargetTopologyActivationReceiptDigest(activationBody)
});

const handlers = (calls: TargetOperation[]): TargetCommandHandlers =>
  Object.fromEntries((Object.keys(TARGET_OPERATION_DISPATCH) as TargetOperation[]).map(
    (operation) => [operation, vi.fn(async () => {
      calls.push(operation);
      return operation === "select_target" ? selectedReceipt : mutationResult(operation);
    })]
  )) as unknown as TargetCommandHandlers;

const sessionFor = (
  targetHandlers: TargetCommandHandlers,
  runs: number[] = [],
  clockCalls: string[] = [],
): TargetCommandHandlerSession => Object.freeze({
  queryWorldClock: async (request: TargetWorldClockRequest) => {
    clockCalls.push(request.run_id);
    return worldClockReceipt;
  },
  run: async <Result>(
    invoke: (handlers: TargetCommandHandlers) => Promise<Result>
  ): Promise<Result> => {
    runs.push(1);
    return invoke(targetHandlers);
  }
});

const runWorldClock = async (session: TargetCommandHandlerSession) => {
  const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
  const program = new Command(); program.exitOverride();
  registerTargetCommands(program, session, {
    stderr: (message) => stderr.push(message), stdout: (message) => stdout.push(message),
  }, (code) => exits.push(code));
  await program.parseAsync([
    "target", "query_world_clock", await requestFile(worldClockRequest),
  ], { from: "user" });
  return { exits, stderr, stdout };
};

const run = async (
  operation: TargetOperation,
  request: TargetResourceRequest,
  targetHandlers: TargetCommandHandlers,
  session: TargetCommandHandlerSession = sessionFor(targetHandlers)
) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  program.exitOverride();
  registerTargetCommands(
    program,
    session,
    { stderr: (message) => stderr.push(message), stdout: (message) => stdout.push(message) },
    (code) => exits.push(code)
  );
  await program.parseAsync(["target", operation, await requestFile(request)], { from: "user" });
  return { exits, stderr, stdout };
};

const runTopology = async (session: TargetCommandHandlerSession) => {
  const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
  const program = new Command(); program.exitOverride();
  registerTargetCommands(program, session, {
    stderr: (message) => stderr.push(message), stdout: (message) => stdout.push(message)
  }, (code) => exits.push(code));
  await program.parseAsync(["target", "attest_topology", await requestFile(topologyRequest)], { from: "user" });
  return { exits, stderr, stdout };
};

const runPublicArtifactSnapshot = async (session: TargetCommandHandlerSession) => {
  const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
  const program = new Command(); program.exitOverride();
  registerTargetCommands(program, session, {
    stderr: (message) => stderr.push(message), stdout: (message) => stdout.push(message)
  }, (code) => exits.push(code));
  await program.parseAsync([
    "target", "snapshot_public_artifact", await requestFile(publicArtifactRequest)
  ], { from: "user" });
  return { exits, stderr, stdout };
};

const runActivation = async (session: TargetCommandHandlerSession) => {
  const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
  const program = new Command(); program.exitOverride();
  registerTargetCommands(program, session, {
    stderr: (message) => stderr.push(message), stdout: (message) => stdout.push(message)
  }, (code) => exits.push(code));
  await program.parseAsync([
    "target", "activate_topology", await requestFile(topologyRequest)
  ], { from: "user" });
  return { exits, stderr, stdout };
};

const runLookup = async (
  request: TargetResourceRequest,
  lookup: (request: TargetMutationRequest) => Promise<TargetOperationLookup>,
  configLoads: number[] = []
) => {
  const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
  const program = new Command(); program.exitOverride();
  registerTargetCommands(
    program,
    sessionFor(handlers([])),
    { stderr: (message) => stderr.push(message), stdout: (message) => stdout.push(message) },
    (code) => exits.push(code),
    async () => {
      configLoads.push(1);
      return lookup;
    }
  );
  await program.parseAsync(["target", "lookup_operation", await requestFile(request)], {
    from: "user"
  });
  return { exits, stderr, stdout };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("target command registration", () => {
  it("enters one scoped handler session only after exact request validation", async () => {
    const calls: TargetOperation[] = [];
    const runs: number[] = [];
    const targetHandlers = handlers(calls);
    const scoped = sessionFor(targetHandlers, runs);
    await expect(run(
      "create_data_network",
      requestFor("create_data_network"),
      targetHandlers,
      scoped
    )).resolves.toMatchObject({ exits: [], stderr: [] });
    expect(runs).toEqual([1]);

    await expect(run(
      "cleanup_run",
      requestFor("select_target"),
      targetHandlers,
      scoped
    )).resolves.toEqual({
      exits: [2],
      stderr: ["error: Invalid target request"],
      stdout: []
    });
    expect(runs).toEqual([1]);
  });

  it("constructs the production command session without exposing handlers", () => {
    const session = createProductionTargetCommandSession({} as TargetDefaultConfig);
    expect(Object.keys(session)).toEqual([
      "activateTopology", "run", "attestTopology", "queryWorldReadiness",
      "queryWorldClock", "snapshotPublicArtifact"
    ]);
    expect(Object.isFrozen(session)).toBe(true);
  });

  it("registers exact underscore names and routes all fifteen operations exactly once", async () => {
    const calls: TargetOperation[] = [];
    const clockCalls: string[] = [];
    const targetHandlers = handlers(calls);
    for (const operation of Object.keys(TARGET_OPERATION_DISPATCH) as TargetOperation[]) {
      const result = await run(operation, requestFor(operation), targetHandlers);
      expect(result.stderr).toEqual([]);
      expect(result.exits).toEqual([]);
      expect(result.stdout).toHaveLength(1);
    }
    const clock = await runWorldClock(sessionFor(targetHandlers, [], clockCalls));
    expect(clock).toEqual({
      exits: [], stderr: [],
      stdout: [createCanonicalTargetWorldClockReceiptBytes(worldClockReceipt)],
    });
    expect(calls).toEqual(Object.keys(TARGET_OPERATION_DISPATCH));
    expect(clockCalls).toEqual(["run-one"]);
  });

  it("emits canonical selection and mutation receipts once without stderr", async () => {
    const targetHandlers = handlers([]);
    const selection = await run("select_target", requestFor("select_target"), targetHandlers);
    expect(selection.stdout).toEqual([createCanonicalSelectedTargetReceiptBytes(selectedReceipt)]);
    const mutation = await run(
      "create_data_network",
      requestFor("create_data_network"),
      targetHandlers
    );
    expect(mutation.stdout).toEqual([mutationResult("create_data_network").receiptBytes]);
  });

  it("rejects operation mismatch as bounded input failure without dispatch", async () => {
    const calls: TargetOperation[] = [];
    const result = await run("cleanup_run", requestFor("select_target"), handlers(calls));
    expect(calls).toEqual([]);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual(["error: Invalid target request"]);
    expect(result.exits).toEqual([2]);
  });

  it("bounds handler and output failures and never writes a receipt", async () => {
    const calls: TargetOperation[] = [];
    const failing = handlers(calls);
    failing.create_data_network = vi.fn(async () => {
      throw new Error("docker endpoint /private leaked");
    });
    const handlerFailure = await run(
      "create_data_network",
      requestFor("create_data_network"),
      failing
    );
    expect(handlerFailure).toEqual({
      exits: [1],
      stderr: ["error: Target operation crashed"],
      stdout: []
    });

    const invalid = handlers(calls);
    invalid.select_target = vi.fn(async () => ({ ...selectedReceipt, endpoint: "/private" } as never));
    const outputFailure = await run("select_target", requestFor("select_target"), invalid);
    expect(outputFailure).toEqual({
      exits: [1],
      stderr: ["error: Target operation crashed"],
      stdout: []
    });
  });

  it("routes only a strict canonical read-only topology attestation", async () => {
    const calls: string[] = [];
    const session = Object.freeze({
      ...sessionFor(handlers([])),
      attestTopology: async (request: TargetTopologyAttestationRequest) => {
        calls.push(request.run_id);
        return { receipt: topologyReceipt, receiptBytes: createCanonicalTargetTopologyReceiptBytes(topologyReceipt) };
      }
    });
    await expect(runTopology(session)).resolves.toEqual({
      exits: [], stderr: [], stdout: [createCanonicalTargetTopologyReceiptBytes(topologyReceipt)]
    });
    expect(calls).toEqual(["run-one"]);
  });

  it("surfaces topology rejection reasons and distinguishes unexpected crashes", async () => {
    const rejection = Object.freeze({
      ...sessionFor(handlers([])),
      attestTopology: async () => {
        throw new SpawnfileError("runtime_error", "Target topology attestation failed: selected_target_mismatch");
      }
    });
    await expect(runTopology(rejection)).resolves.toEqual({
      exits: [1],
      stderr: ["error: Target topology attestation failed: selected_target_mismatch"],
      stdout: []
    });

    const crash = Object.freeze({
      ...sessionFor(handlers([])),
      attestTopology: async () => { throw new TypeError("private detail"); }
    });
    await expect(runTopology(crash)).resolves.toEqual({
      exits: [1],
      stderr: ["error: Target topology attestation crashed"],
      stdout: []
    });
  });

  it("routes a strict public artifact declaration outside mutation dispatch", async () => {
    const seen: TargetPublicArtifactSnapshotRequest[] = [];
    const session: TargetCommandHandlerSession = {
      run: sessionFor(handlers([])).run,
      snapshotPublicArtifact: async (request) => {
        seen.push(request);
        return publicArtifactSnapshot;
      }
    };
    await expect(runPublicArtifactSnapshot(session)).resolves.toEqual({
      exits: [],
      stderr: [],
      stdout: [
        createCanonicalTargetPublicArtifactSnapshotBytes(publicArtifactSnapshot)
      ]
    });
    expect(seen).toEqual([publicArtifactRequest]);
    expect(Object.keys(TARGET_OPERATION_DISPATCH))
      .not.toContain("snapshot_public_artifact");
  });

  it("routes topology activation separately and emits one canonical receipt", async () => {
    const calls: string[] = [];
    const session = Object.freeze({
      ...sessionFor(handlers([])),
      activateTopology: async (request: TargetTopologyAttestationRequest) => {
        calls.push(request.run_id);
        return {
          receipt: activationReceipt,
          receiptBytes: createCanonicalTargetTopologyActivationReceiptBytes(
            activationReceipt
          )
        };
      }
    });
    await expect(runActivation(session)).resolves.toEqual({
      exits: [],
      stderr: [],
      stdout: [
        createCanonicalTargetTopologyActivationReceiptBytes(activationReceipt)
      ]
    });
    expect(calls).toEqual(["run-one"]);
    expect("activate_topology" in TARGET_OPERATION_DISPATCH).toBe(false);
  });

  it("registers lookup outside mutation dispatch and emits one canonical state", async () => {
    const request = requestFor("create_data_network") as TargetMutationRequest;
    const lookup = {
      idempotency_key: request.idempotency_key,
      operation: request.operation,
      request_digest: createTargetRequestDigest(request),
      status: "not_applied",
      version: "spawnfile.target-resource.operation-lookup.v1"
    } as const;
    const loads: number[] = [];
    expect(await runLookup(request, async () => lookup, loads)).toEqual({
      exits: [], stderr: [], stdout: [createCanonicalTargetOperationLookupBytes(lookup)]
    });
    expect(loads).toEqual([1]);
    expect("lookup_operation" in TARGET_OPERATION_DISPATCH).toBe(false);
  });

  it("emits correlated pending and completed lookup states", async () => {
    const request = requestFor("create_data_network") as TargetMutationRequest;
    const requestDigest = createTargetRequestDigest(request);
    const base = {
      idempotency_key: request.idempotency_key,
      operation: request.operation,
      operation_handle: "opaque_dddddddddddddddd",
      request_digest: requestDigest,
      version: "spawnfile.target-resource.operation-lookup.v1" as const
    };
    const pending = parseTargetOperationLookup({ ...base, status: "pending" });
    expect(await runLookup(request, async () => pending)).toEqual({
      exits: [], stderr: [], stdout: [createCanonicalTargetOperationLookupBytes(pending)]
    });
    const receiptBody = {
      cleanup_state: "not_requested" as const,
      descriptor_digest: request.descriptor_digest,
      export_state: "not_requested" as const,
      labels: [],
      operation: request.operation,
      operation_handle: base.operation_handle,
      receipt_digest: digest,
      request_digest: requestDigest,
      result_handle: "opaque_eeeeeeeeeeeeeeee",
      resulting_revision: request.expected_revision + 1,
      run_id: request.run_id,
      selected_target: request.selected_target,
      version: "spawnfile.target-resource.receipt.v1" as const
    };
    const receipt = { ...receiptBody, receipt_digest: createTargetReceiptDigest(receiptBody) };
    const completed = parseTargetOperationLookup({ ...base, receipt, status: "completed" });
    expect(await runLookup(request, async () => completed)).toEqual({
      exits: [], stderr: [], stdout: [createCanonicalTargetOperationLookupBytes(completed)]
    });
  });

  it("rejects selection before lookup configuration and bounds lookup failure", async () => {
    const loads: number[] = [];
    expect(await runLookup(
      requestFor("select_target"),
      async () => { throw new Error("must not run"); },
      loads
    )).toEqual({
      exits: [2], stderr: ["error: Invalid target lookup request"], stdout: []
    });
    expect(loads).toEqual([]);
    const request = requestFor("create_data_network") as TargetMutationRequest;
    expect(await runLookup(request, async () => {
      throw new Error("private provider path");
    })).toEqual({
      exits: [1], stderr: ["error: Target operation lookup failed"], stdout: []
    });
    expect(await runLookup(request, async () => ({
      idempotency_key: "idem_bbbbbbbbbbbbbbbb",
      operation: request.operation,
      request_digest: createTargetRequestDigest(request),
      status: "not_applied",
      version: "spawnfile.target-resource.operation-lookup.v1"
    }))).toEqual({
      exits: [1], stderr: ["error: Target operation lookup failed"], stdout: []
    });
  });
});
