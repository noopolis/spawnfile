import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { parseContainerBundleArchive, validateContainerBundleEnvelope, type ParsedContainerBundleArchive } from "./containerBundleArchive.js";
import type { AuthorizedContainerBundlePlan, ContainerBundlePreparationAuthority } from "./containerBundleAuthority.js";
import {
  createTargetLocalBundleReceiptDigest,
  createTargetLocalBundleRequestDigest,
  parseTargetLocalBundlePrepareRequest,
  type TargetLocalBundlePrepareReceipt,
  type TargetLocalBundlePrepareRequest
} from "./containerBundleContracts.js";
import type { TargetLocalBundleLease, TargetLocalBundlePrivateMapping, TargetLocalBundleStore } from "./containerBundleStore.js";
import { parseOpaqueTargetHandle, type OpaqueTargetHandle } from "./contracts.js";

export const TARGET_LOCAL_CONTAINER_BUNDLE_ERROR = "Target-local container bundle preparation failed";

export interface DockerTargetLocalBundleBuilder {
  build(input: {
    readonly archive: ParsedContainerBundleArchive;
    readonly base_image_config_digest: string;
    readonly entrypoint: string;
    readonly gc_tag: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  }): Promise<{ readonly config_id: string; readonly labels: Readonly<Record<string, string>>; readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" } }>;
  inspect(input: { readonly config_id: string; readonly gc_tag: string; readonly labels: Readonly<Record<string, string>>; readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" } }): Promise<{ readonly config_id: string; readonly labels: Readonly<Record<string, string>>; readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" } } | null>;
  /** Finds only this deterministic anchor. `missing` means no tag existed before an effect. */
  inspectAnchor(input: { readonly gc_tag: string; readonly labels: Readonly<Record<string, string>>; readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" } }): Promise<{ readonly config_id: string; readonly labels: Readonly<Record<string, string>>; readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" } } | "missing" | null>;
  /** A fresh selected-target + daemon attestation. It is called before and after any Docker action. */
  attestTarget(input: { readonly selected_target: TargetLocalBundlePrepareRequest["selected_target"] }): Promise<{ readonly daemon_epoch: string } | null>;
}
export interface TargetLocalContainerBundleOperations {
  lookup(input: { readonly idempotency_key: unknown; readonly request_digest: unknown }): ReturnType<TargetLocalBundleStore["lookup"]>;
  prepare(raw: unknown): Promise<TargetLocalBundlePrepareReceipt>;
  recover(raw: unknown): Promise<TargetLocalBundlePrepareReceipt>;
}

const fail = (): never => { throw new Error(TARGET_LOCAL_CONTAINER_BUNDLE_ERROR); };
export const targetLocalBundleGcTag = (requestDigest: string): string => `spfb_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.gc-tag.v1\0", "utf8").update(requestDigest).digest("hex").slice(0, 58)}`;
type BundleLabelPlan = Pick<AuthorizedContainerBundlePlan, "archive_digest" | "artifact_digest" | "base_image_config_digest" | "build_policy_digest" | "bundle_digest" | "entrypoint" | "launcher_digest" | "network_alias" | "platform_digest">;
export const targetLocalBundleLabels = (plan: BundleLabelPlan, daemonEpoch: string, requestDigest: string): Readonly<Record<string, string>> => Object.freeze({
  spawnfile_target_bundle_v1_archive: plan.archive_digest,
  spawnfile_target_bundle_v1_alias: plan.network_alias,
  spawnfile_target_bundle_v1_artifact: plan.artifact_digest,
  spawnfile_target_bundle_v1_base: plan.base_image_config_digest,
  spawnfile_target_bundle_v1_bundle: plan.bundle_digest,
  spawnfile_target_bundle_v1_daemon: daemonEpoch,
  spawnfile_target_bundle_v1_entrypoint: plan.entrypoint,
  spawnfile_target_bundle_v1_launcher: plan.launcher_digest,
  spawnfile_target_bundle_v1_platform: plan.platform_digest,
  spawnfile_target_bundle_v1_policy: plan.build_policy_digest,
  spawnfile_target_bundle_v1_request: requestDigest,
  spawnfile_target_bundle_v1_version: "v1"
});
const exactLabels = (actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean =>
  Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value);
const receipt = (request: TargetLocalBundlePrepareRequest, requestDigest: string, operation: string, mapping: string): TargetLocalBundlePrepareReceipt => {
  const raw = { archive_digest: request.archive_digest, artifact_digest: request.artifact_digest,
    build_policy_digest: request.build_policy_digest, bundle_digest: request.bundle_digest,
    launcher_digest: request.launcher_digest, mapping_handle: mapping, network_alias: request.network_alias,
    operation_handle: operation, platform: request.platform, platform_digest: request.platform_digest,
    receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: requestDigest,
    selected_target: request.selected_target, version: "spawnfile.target-local-container-bundle.prepare-receipt.v1" as const };
  return { ...raw, mapping_handle: parseOpaqueTargetHandle(mapping),
    operation_handle: parseOpaqueTargetHandle(operation), receipt_digest: createTargetLocalBundleReceiptDigest(raw) };
};
const mappingHandle = (operation: string, requestDigest: string): string => `opaque_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.mapping.v1\0", "utf8").update(`${operation}\0${requestDigest}`, "utf8").digest("hex")}`;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const mapping = (plan: AuthorizedContainerBundlePlan, request: TargetLocalBundlePrepareRequest, daemonEpoch: string, reservation: { readonly operation_handle: OpaqueTargetHandle; readonly request_digest: string }, configId: string): TargetLocalBundlePrivateMapping => ({
  archive_digest: plan.archive_digest, artifact_digest: plan.artifact_digest,
  base_image_config_digest: plan.base_image_config_digest, build_policy_digest: plan.build_policy_digest,
  bundle_digest: plan.bundle_digest, config_id: configId, daemon_epoch: daemonEpoch,
  entrypoint: plan.entrypoint, gc_tag: targetLocalBundleGcTag(reservation.request_digest), identity_kind: "docker_image_config_digest",
  launcher_digest: plan.launcher_digest, network_alias: plan.network_alias,
  operation_handle: reservation.operation_handle, platform: plan.platform, platform_digest: plan.platform_digest,
  request_digest: reservation.request_digest, selected_target: request.selected_target
});
const compatibleMapping = (value: TargetLocalBundlePrivateMapping, plan: AuthorizedContainerBundlePlan, request: TargetLocalBundlePrepareRequest, requestDigest: string): boolean =>
  value.request_digest === requestDigest && value.archive_digest === plan.archive_digest && value.artifact_digest === plan.artifact_digest
  && value.base_image_config_digest === plan.base_image_config_digest && value.build_policy_digest === plan.build_policy_digest
  && value.bundle_digest === plan.bundle_digest && value.entrypoint === plan.entrypoint && value.launcher_digest === plan.launcher_digest
  && value.network_alias === plan.network_alias && value.platform_digest === plan.platform_digest
  && same(value.platform, plan.platform) && same(value.selected_target, request.selected_target);

/** Re-attests the exact private anchor before an image config becomes usable. */
export const attestTargetLocalBundleMapping = async (
  builder: DockerTargetLocalBundleBuilder,
  value: TargetLocalBundlePrivateMapping
): Promise<void> => {
  if (value.gc_tag !== targetLocalBundleGcTag(value.request_digest)) fail();
  const first = await builder.attestTarget({ selected_target: value.selected_target });
  if (!first || first.daemon_epoch !== value.daemon_epoch) fail();
  const expected = targetLocalBundleLabels(value, value.daemon_epoch, value.request_digest);
  const inspected = await builder.inspect({ config_id: value.config_id, gc_tag: value.gc_tag, labels: expected, platform: value.platform });
  if (!inspected || inspected.config_id !== value.config_id || !exactLabels(inspected.labels, expected)
    || !same(inspected.platform, value.platform)) fail();
  const second = await builder.attestTarget({ selected_target: value.selected_target });
  if (!second || second.daemon_epoch !== value.daemon_epoch) fail();
};

export const createTargetLocalContainerBundleOperations = (input: {
  readonly authority: ContainerBundlePreparationAuthority;
  readonly builder: DockerTargetLocalBundleBuilder;
  readonly store: TargetLocalBundleStore;
}): TargetLocalContainerBundleOperations => {
  if (!input?.authority || typeof input.authority.authorize !== "function" || !input.builder || !input.store) fail();
  const attest = async (request: TargetLocalBundlePrepareRequest): Promise<string> => {
    const result = await input.builder.attestTarget({ selected_target: request.selected_target });
    if (!result || !/^sha256:[a-f0-9]{64}$/u.test(result.daemon_epoch)) fail(); return (result as { readonly daemon_epoch: string }).daemon_epoch;
  };
  const withHeartbeat = async <T>(lease: TargetLocalBundleLease, action: () => Promise<T>): Promise<{ readonly lease: TargetLocalBundleLease; readonly value: T }> => {
    let current = lease; let failure: unknown; let renewing = Promise.resolve();
    const beat = () => { renewing = renewing.then(async () => { try { current = await input.store.renew({ lease: current }); } catch (error) { failure = error; } }); };
    const timer = setInterval(beat, 5_000);
    try { const value = await action(); await renewing; if (failure) fail(); return { lease: current, value }; }
    finally { clearInterval(timer); }
  };
  type Reservation = Awaited<ReturnType<TargetLocalBundleStore["reserve"]>>;
  type Owner = Extract<Reservation, { readonly kind: "owner" }>;
  const replayAnchor = async (value: Extract<Reservation, { readonly kind: "replay" }>, plan: AuthorizedContainerBundlePlan,
    request: TargetLocalBundlePrepareRequest): Promise<"intact" | "missing"> => {
    const privateMapping = value.mapping;
    if (!compatibleMapping(privateMapping, plan, request, value.receipt.request_digest)
      || privateMapping.operation_handle !== value.receipt.operation_handle
      || privateMapping.gc_tag !== targetLocalBundleGcTag(privateMapping.request_digest)) fail();
    const first = await input.builder.attestTarget({ selected_target: privateMapping.selected_target });
    if (!first || first.daemon_epoch !== privateMapping.daemon_epoch) fail();
    const expected = targetLocalBundleLabels(privateMapping, privateMapping.daemon_epoch, privateMapping.request_digest);
    const inspected = await input.builder.inspectAnchor({ gc_tag: privateMapping.gc_tag, labels: expected, platform: privateMapping.platform });
    const second = await input.builder.attestTarget({ selected_target: privateMapping.selected_target });
    if (!second || second.daemon_epoch !== privateMapping.daemon_epoch) fail();
    if (inspected === "missing") return "missing";
    if (!inspected || inspected.config_id !== privateMapping.config_id || !exactLabels(inspected.labels, expected)
      || !same(inspected.platform, privateMapping.platform)) fail();
    return "intact";
  };
  const reserveAttested = async (request: TargetLocalBundlePrepareRequest, plan: AuthorizedContainerBundlePlan,
    joinPending: boolean): Promise<Reservation> => {
    let reservation = await input.store.reserve(request); let mayJoin = joinPending;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (reservation.kind === "replay") {
        if (await replayAnchor(reservation, plan, request) === "intact") return reservation;
        reservation = await input.store.retryMissingCompleted({ generation: reservation.generation,
          operation_handle: reservation.receipt.operation_handle, request_digest: reservation.receipt.request_digest });
        mayJoin = true; continue;
      }
      if (reservation.kind === "pending" && mayJoin) {
        const waited = await input.store.awaitReplay({ idempotency_key: request.idempotency_key,
          maximum_wait_ms: 30_000, request_digest: createTargetLocalBundleRequestDigest(request) });
        if (waited.status !== "completed") return reservation;
        reservation = await input.store.reserve(request); continue;
      }
      return reservation;
    }
    return fail();
  };
  const buildOwner = async (request: TargetLocalBundlePrepareRequest, plan: AuthorizedContainerBundlePlan,
    owner: Owner): Promise<TargetLocalBundlePrepareReceipt> => {
    const archive = parseContainerBundleArchive(Buffer.from(request.archive_base64, "base64"), request.archive_entries, request.archive_digest);
    validateContainerBundleEnvelope(archive, plan);
    let buildLease = await input.store.beginBuild({ lease: owner.lease });
    const daemonEpoch = await attest(request); const expected = targetLocalBundleLabels(plan, daemonEpoch, owner.request_digest);
    buildLease = await input.store.renew({ lease: buildLease });
    const heartbeated = await withHeartbeat(buildLease, () => input.builder.build({ archive, base_image_config_digest: plan.base_image_config_digest,
      entrypoint: plan.entrypoint, gc_tag: targetLocalBundleGcTag(owner.request_digest), labels: expected, platform: plan.platform }));
    buildLease = heartbeated.lease; const built = heartbeated.value;
    buildLease = await input.store.renew({ lease: buildLease });
    if (!/^sha256:[a-f0-9]{64}$/u.test(built.config_id) || !exactLabels(built.labels, expected) || !same(built.platform, plan.platform)
      || await attest(request) !== daemonEpoch) { await input.store.markIncomplete({ lease: buildLease, operation_handle: owner.operation_handle, request_digest: owner.request_digest }); fail(); }
    const privateMapping = mapping(plan, request, daemonEpoch, owner, built.config_id);
    const postbuildLease = await input.store.stagePostbuild({ lease: buildLease, mapping: privateMapping });
    try { await attestTargetLocalBundleMapping(input.builder, privateMapping); }
    catch { await input.store.markIncomplete({ lease: postbuildLease, operation_handle: owner.operation_handle, request_digest: owner.request_digest }); fail(); }
    return input.store.complete({ lease: postbuildLease, mapping: privateMapping,
      receipt: receipt(request, owner.request_digest, owner.operation_handle, mappingHandle(owner.operation_handle, owner.request_digest)) });
  };
  const completePostbuild = async (request: TargetLocalBundlePrepareRequest, plan: AuthorizedContainerBundlePlan,
    owner: Owner): Promise<TargetLocalBundlePrepareReceipt> => {
    const recovered = owner.mapping;
    if (recovered === undefined || owner.state !== "postbuild") return fail();
    const daemonEpoch = await attest(request);
    if (!compatibleMapping(recovered, plan, request, owner.request_digest) || recovered.daemon_epoch !== daemonEpoch) fail();
    await attestTargetLocalBundleMapping(input.builder, recovered);
    return input.store.complete({ lease: owner.lease, mapping: recovered,
      receipt: receipt(request, owner.request_digest, owner.operation_handle, mappingHandle(owner.operation_handle, owner.request_digest)) });
  };
  const recover = async (raw: unknown): Promise<TargetLocalBundlePrepareReceipt> => {
    const request = parseTargetLocalBundlePrepareRequest(raw); const plan = input.authority.authorize(request);
    const reservation = await reserveAttested(request, plan, false);
    if (reservation.kind === "replay") return reservation.receipt;
    if (reservation.kind !== "owner") fail();
    const owner = reservation as Owner;
    if (owner.state === "prebuild") return buildOwner(request, plan, owner);
    const recovered = owner.mapping;
    if (owner.state === "inflight" && recovered === undefined) {
      const daemonEpoch = await attest(request); const expected = targetLocalBundleLabels(plan, daemonEpoch, owner.request_digest);
      const anchor = await input.builder.inspectAnchor({ gc_tag: targetLocalBundleGcTag(owner.request_digest), labels: expected, platform: plan.platform });
      if (anchor && anchor !== "missing") {
        const adopted = mapping(plan, request, daemonEpoch, owner, anchor.config_id);
        const postbuild = await input.store.stagePostbuild({ lease: owner.lease, mapping: adopted });
        await attestTargetLocalBundleMapping(input.builder, adopted);
        return input.store.complete({ lease: postbuild, mapping: adopted,
          receipt: receipt(request, owner.request_digest, owner.operation_handle, mappingHandle(owner.operation_handle, owner.request_digest)) });
      }
      if (anchor !== "missing") fail(); // Existing but non-exact is ambiguous drift, never a retry.
      const retryLease = await input.store.retryPrebuild({ lease: owner.lease });
      return buildOwner(request, plan, { ...owner, lease: retryLease, state: "prebuild" });
    }
    return completePostbuild(request, plan, owner);
  };
  const prepare = async (raw: unknown): Promise<TargetLocalBundlePrepareReceipt> => {
    const request = parseTargetLocalBundlePrepareRequest(raw); const plan = input.authority.authorize(request);
    const reservation = await reserveAttested(request, plan, true);
    if (reservation.kind === "replay") return reservation.receipt;
    if (reservation.kind !== "owner") fail();
    const owner = reservation as Owner;
    if (owner.state === "postbuild") return completePostbuild(request, plan, owner);
    /* An expired/reclaimed inflight record is ambiguous; never erase it from a fresh caller. */
    if (owner.state !== "prebuild") fail();
    return buildOwner(request, plan, owner);
  };
  /* Join only byte-identical work inside this process; the durable store remains the authority across restarts. */
  const active = new Map<string, Promise<TargetLocalBundlePrepareReceipt>>();
  const joinedPrepare = async (raw: unknown): Promise<TargetLocalBundlePrepareReceipt> => {
    const key = createTargetLocalBundleRequestDigest(parseTargetLocalBundlePrepareRequest(raw));
    const prior = active.get(key); if (prior) return prior;
    const task = prepare(raw).finally(() => { if (active.get(key) === task) active.delete(key); });
    active.set(key, task); return task;
  };
  return Object.freeze({ lookup: (value: { readonly idempotency_key: unknown; readonly request_digest: unknown }) => input.store.lookup(value), prepare: joinedPrepare, recover });
};
