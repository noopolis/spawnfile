import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";
import { boundedRedactedText, SpawnfileError } from "../shared/index.js";

import {
  assertOrdinaryJsonGraph,
  parseRunId,
  type TargetTopologyReceipt
} from "./contracts.js";
import {
  executeDockerWorldService,
  type DockerWorldServiceExecutor
} from "./dockerWorldServiceProvider.js";
import type { WorldServiceBinding } from "./dockerWorldServiceStore.js";
import { worldServiceSpecForBinding } from "./dockerWorldServiceLifecycle.js";
import type { TopologyAttestationReason } from "./topologyAttestationErrors.js";

export const WORLD_SERVICE_ACTIVATION_VERSION =
  "spawnfile.world-service-activation.v1" as const;
export const TARGET_TOPOLOGY_ACTIVATION_RECEIPT_VERSION =
  "spawnfile.target-topology-activation-receipt.v1" as const;
export const WORLD_SERVICE_ACTIVATION_RELATIVE_PATH =
  ".spawnfile/world-service-activated.v1" as const;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const markerSchema = z.object({
  bundle_digest: digestSchema,
  run_id: z.string(),
  state: z.literal("activated"),
  topology_receipt_digest: digestSchema,
  topology_request_digest: digestSchema,
  version: z.literal(WORLD_SERVICE_ACTIVATION_VERSION)
}).strict();
const receiptSchema = z.object({
  activation_digest: digestSchema,
  bundle_digest: digestSchema,
  receipt_digest: digestSchema,
  run_id: z.string(),
  state: z.literal("activated"),
  topology_receipt_digest: digestSchema,
  topology_request_digest: digestSchema,
  version: z.literal(TARGET_TOPOLOGY_ACTIVATION_RECEIPT_VERSION)
}).strict();

export type WorldServiceActivation = z.infer<typeof markerSchema>;
export type TargetTopologyActivationReceipt = z.infer<typeof receiptSchema>;
export interface TargetTopologyActivationResult {
  readonly receipt: TargetTopologyActivationReceipt;
  readonly receiptBytes: string;
}

const fail = (reason: TopologyAttestationReason): never => {
  throw new SpawnfileError("runtime_error", `Target topology activation failed: ${reason}`);
};
const canonical = (value: unknown): string => {
  assertOrdinaryJsonGraph(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const digest = (domain: "activation" | "receipt", value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(domain === "activation"
      ? "spawnfile.world-service-activation.v1\0"
      : "spawnfile.target-topology-activation-receipt.v1\0", "utf8")
    .update(canonical(value), "utf8")
    .digest("hex")}`;

export const parseWorldServiceActivation = (raw: unknown): WorldServiceActivation => {
  assertOrdinaryJsonGraph(raw);
  const parsed = markerSchema.parse(raw);
  return Object.freeze({ ...parsed, run_id: parseRunId(parsed.run_id) });
};
export const parseTargetTopologyActivationReceipt = (
  raw: unknown
): TargetTopologyActivationReceipt => {
  assertOrdinaryJsonGraph(raw);
  const parsed = receiptSchema.parse(raw);
  return Object.freeze({ ...parsed, run_id: parseRunId(parsed.run_id) });
};
export const createCanonicalWorldServiceActivationBytes = (raw: unknown): string =>
  `${canonical(parseWorldServiceActivation(raw))}\n`;
export const createCanonicalTargetTopologyActivationReceiptBytes = (raw: unknown): string =>
  canonical(parseTargetTopologyActivationReceipt(raw));
export const createWorldServiceActivationDigest = (raw: unknown): string =>
  digest("activation", parseWorldServiceActivation(raw));
export const createTargetTopologyActivationReceiptDigest = (raw: unknown): string => {
  const parsed = parseTargetTopologyActivationReceipt(raw);
  const { receipt_digest: _receiptDigest, ...body } = parsed;
  return digest("receipt", body);
};

const markerFor = (
  world: WorldServiceBinding,
  topology: TargetTopologyReceipt
): WorldServiceActivation => parseWorldServiceActivation({
  bundle_digest: world.resolution.artifact.artifact_manifest_digest,
  run_id: topology.run_id,
  state: "activated",
  topology_receipt_digest: topology.receipt_digest,
  topology_request_digest: topology.request_digest,
  version: WORLD_SERVICE_ACTIVATION_VERSION
});

const receiptFor = (
  marker: WorldServiceActivation
): TargetTopologyActivationResult => {
  const body = {
    activation_digest: createWorldServiceActivationDigest(marker),
    bundle_digest: marker.bundle_digest,
    receipt_digest: `sha256:${"0".repeat(64)}`,
    run_id: marker.run_id,
    state: "activated" as const,
    topology_receipt_digest: marker.topology_receipt_digest,
    topology_request_digest: marker.topology_request_digest,
    version: TARGET_TOPOLOGY_ACTIVATION_RECEIPT_VERSION
  };
  const receipt = parseTargetTopologyActivationReceipt({
    ...body,
    receipt_digest: createTargetTopologyActivationReceiptDigest(body)
  });
  return Object.freeze({
    receipt,
    receiptBytes: createCanonicalTargetTopologyActivationReceiptBytes(receipt)
  });
};

/**
 * Publishes the owner-only lifecycle release through the service's existing
 * evidence mount. Docker copies exact canonical bytes; no provider traffic or
 * agent-reachable endpoint participates in activation.
 */
export const activateDockerWorldService = async (input: {
  readonly executor: DockerWorldServiceExecutor;
  readonly signal?: AbortSignal;
  readonly target: readonly string[];
  readonly timeoutMs: number;
  readonly topology: TargetTopologyReceipt;
  readonly world: WorldServiceBinding;
}): Promise<TargetTopologyActivationResult> => {
  const marker = markerFor(input.world, input.topology);
  const spec = worldServiceSpecForBinding(input.world);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-activation-"));
  try {
    const markerDirectory = path.join(temporaryRoot, ".spawnfile");
    // This path is docker cp'd into the evidence volume, which is exported by a
    // helper running as uid 65534. The marker is a closed schema of digests and
    // identifiers with no secret material, so the restriction protected nothing;
    // tightening it back disables evidence export. A file written into a volume
    // that exists to be exported must be readable by the exporter.
    await mkdir(markerDirectory, { mode: 0o755 });
    // This path is docker cp'd into the evidence volume, which is exported by a
    // helper running as uid 65534. The marker is a closed schema of digests and
    // identifiers with no secret material, so the restriction protected nothing;
    // tightening it back disables evidence export. A file written into a volume
    // that exists to be exported must be readable by the exporter.
    await writeFile(
      path.join(markerDirectory, "world-service-activated.v1"),
      createCanonicalWorldServiceActivationBytes(marker),
      { encoding: "utf8", mode: 0o644 }
    );
    const result = await executeDockerWorldService({
      args: [
        ...input.target,
        "container",
        "cp",
        markerDirectory,
        `${input.world.container_id}:${spec.evidenceMountPath}`
      ],
      executor: input.executor,
      signal: input.signal,
      timeoutMs: input.timeoutMs
    });
    if (result.stdout !== "") {
      return fail(`activation_stdout_unexpected:${boundedRedactedText(result.stdout)}`);
    }
    if (result.stderr !== "") {
      return fail(`activation_stderr_unexpected:${boundedRedactedText(result.stderr)}`);
    }
    return receiptFor(marker);
  } catch (error) {
    if (error instanceof SpawnfileError
      && error.message.startsWith("Target topology activation failed:")) throw error;
    return fail("activation_failed");
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true }).catch(() => undefined);
  }
};
