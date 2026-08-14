import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";

import { loadTargetDefaultConfig } from "../../src/cli/targetDefaultConfig.js";
import {
  createTargetLocalBundleReceiptDigest,
  type TargetLocalBundlePrepareRequest
} from "../../src/target/containerBundleContracts.js";
import { initializeFilesystemTargetLocalBundleStore } from "../../src/target/containerBundleFilesystemStore.js";
import {
  attestTargetLocalBundleMapping,
  targetLocalBundleGcTag,
  type DockerTargetLocalBundleBuilder
} from "../../src/target/containerBundle.js";
import type { TargetLocalBundlePrivateMapping } from "../../src/target/containerBundleStore.js";
import { parseOpaqueTargetHandle } from "../../src/target/contracts.js";

const VERSION = "spawnfile.target-container-bundle-persistence-child.v1";
const fail = (): never => { throw new Error("fixture failed"); };
const digest = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
const mappingHandle = (operation: string, requestDigest: string) => parseOpaqueTargetHandle(`opaque_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.mapping.v1\0", "utf8")
  .update(`${operation}\0${requestDigest}`, "utf8").digest("hex")}`);
const plain = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  return raw as Record<string, unknown>;
};
const send = (message: Record<string, unknown>): void => {
  process.send?.(message, () => process.disconnect());
};

process.once("message", async (raw: unknown) => {
  let ok = false;
  try {
    const input = plain(raw);
    if (input.version !== VERSION
      || !["complete", "inspect", "attest"].includes(input.action as string)
      || typeof input.config !== "object" || typeof input.request !== "object") fail();
    const action = input.action as "attest" | "complete" | "inspect";
    const config = await loadTargetDefaultConfig(input.config as never);
    const request = input.request as TargetLocalBundlePrepareRequest;
    const store = await initializeFilesystemTargetLocalBundleStore(config.paths.containerBundles);
    if (action === "complete") {
      const owner = await store.reserve(request);
      if (owner.kind !== "owner") fail();
      const mapping: TargetLocalBundlePrivateMapping = Object.freeze({
        archive_digest: request.archive_digest,
        artifact_digest: request.artifact_digest,
        base_image_config_digest: digest("8"),
        build_policy_digest: request.build_policy_digest,
        bundle_digest: request.bundle_digest,
        config_id: digest("9"),
        daemon_epoch: digest("0"),
        entrypoint: request.entrypoint,
        gc_tag: targetLocalBundleGcTag(owner.request_digest),
        identity_kind: "docker_image_config_digest",
        launcher_digest: request.launcher_digest,
        network_alias: request.network_alias,
        operation_handle: owner.operation_handle,
        platform: request.platform,
        platform_digest: request.platform_digest,
        request_digest: owner.request_digest,
        selected_target: request.selected_target
      });
      const body = {
        archive_digest: request.archive_digest,
        artifact_digest: request.artifact_digest,
        build_policy_digest: request.build_policy_digest,
        bundle_digest: request.bundle_digest,
        launcher_digest: request.launcher_digest,
        mapping_handle: mappingHandle(owner.operation_handle, owner.request_digest),
        network_alias: request.network_alias,
        operation_handle: owner.operation_handle,
        platform: request.platform,
        platform_digest: request.platform_digest,
        receipt_digest: digest("7"),
        request_digest: owner.request_digest,
        selected_target: request.selected_target,
        version: "spawnfile.target-local-container-bundle.prepare-receipt.v1" as const
      };
      const inflight = await store.beginBuild({ lease: owner.lease });
      const postbuild = await store.stagePostbuild({ lease: inflight, mapping });
      await store.complete({
        lease: postbuild,
        mapping,
        receipt: { ...body, receipt_digest: createTargetLocalBundleReceiptDigest(body) }
      });
    }
    const prepared = await store.resolvePrepared({
      artifact_digest: request.artifact_digest,
      build_policy_digest: request.build_policy_digest,
      bundle_digest: request.bundle_digest,
      selected_target: request.selected_target
    });
    let attested: boolean | undefined;
    if (action === "attest") {
      if (!prepared) fail();
      const scenario = input.scenario;
      if (!["exact", "image_missing", "label_drift", "daemon_replaced"].includes(scenario as string)) fail();
      const mapping = prepared.mapping;
      const builder: DockerTargetLocalBundleBuilder = Object.freeze({
        attestTarget: async () => ({
          daemon_epoch: scenario === "daemon_replaced" ? digest("6") : mapping.daemon_epoch
        }),
        build: async () => fail(),
        inspect: async (value) => scenario === "image_missing" ? null : ({
          config_id: value.config_id,
          labels: scenario === "label_drift" ? Object.freeze({}) : value.labels,
          platform: value.platform
        }),
        inspectAnchor: async () => fail()
      });
      try {
        await attestTargetLocalBundleMapping(builder, mapping);
        attested = true;
      } catch {
        attested = false;
      }
    }
    ok = true;
    send({
      ...(attested === undefined ? {} : { attested }),
      bundle_reused: prepared !== null,
      bundle_root: config.paths.containerBundles,
      kind: "result",
      ok: true,
      secret_entries: await readdir(config.paths.secretAuthority),
      secret_root: config.paths.secretAuthority,
      version: VERSION
    });
  } catch {
    process.exitCode = 1;
    send({ kind: "result", ok: false, version: VERSION });
    return;
  }
  process.exitCode = ok ? 0 : 1;
});

process.send?.({ kind: "ready", version: VERSION });
