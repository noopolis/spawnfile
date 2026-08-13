import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  TARGET_RESOURCE_REQUEST_VERSION,
  parseOpaqueTargetHandle
} from "../target/contracts.js";

import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import {
  TARGET_DEFAULT_AUTHORITIES_ERROR,
  createTargetJournalAccess
} from "./targetDefaultJournalAuthority.js";

const descriptorDigest = `sha256:${"d".repeat(64)}`;
const selectedTarget = {
  fingerprint: `sha256:${"c".repeat(32)}`,
  handle: parseOpaqueTargetHandle(`opaque_${"e".repeat(64)}`)
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

const createAccess = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-journal-access-")));
  roots.push(root);
  const config = {
    context: "prod_1",
    paths: { journals: root }
  } as TargetDefaultConfig;
  return createTargetJournalAccess(config);
};

const identity = (changes: Record<string, unknown> = {}) => ({
  context: "prod_1",
  descriptorDigest,
  runId: "run-one",
  selectedTarget,
  ...changes
});

const mutation = (changes: Record<string, unknown> = {}) => ({
  artifact_manifest_digest: `sha256:${"a".repeat(64)}`,
  descriptor_digest: descriptorDigest,
  expected_revision: 0,
  idempotency_key: "idem_aaaaaaaaaaaaaaaa",
  operation: "resolve_world_artifact",
  run_id: "run-one",
  selected_target: selectedTarget,
  version: TARGET_RESOURCE_REQUEST_VERSION,
  ...changes
});

describe("target default journal authority", () => {
  it("caches exact initialized identities and reopens only an existing identity", async () => {
    const access = await createAccess();
    const first = await access.resolveIdentity(identity());
    expect(await access.resolveIdentity(identity())).toBe(first);
    expect((await first.read()).run_id).toBe("run-one");
    expect(await access.resolveExistingIdentity(identity())).not.toBe(first);

    await expect(access.resolveExistingIdentity(identity({ runId: "run-missing" })))
      .rejects.toThrow(TARGET_DEFAULT_AUTHORITIES_ERROR);
  });

  it("fails closed for malformed or cross-context identity requests", async () => {
    const access = await createAccess();
    for (const invalid of [
      identity({ context: "wrong" }),
      identity({ selectedTarget: {} })
    ]) {
      await expect(access.resolveIdentity(invalid)).rejects.toThrow(
        TARGET_DEFAULT_AUTHORITIES_ERROR
      );
      await expect(access.resolveExistingIdentity(invalid)).rejects.toThrow(
        TARGET_DEFAULT_AUTHORITIES_ERROR
      );
    }
  });

  it("resolves validated mutations and rejects selection and hostile envelopes", async () => {
    const access = await createAccess();
    const resolved = await access.resolver.resolve({
      context: "prod_1",
      request: mutation()
    });
    expect(resolved.request.operation).toBe("resolve_world_artifact");
    expect(resolved.selectedTarget).toMatchObject(selectedTarget);
    expect((await resolved.journal.read()).descriptor_digest).toBe(descriptorDigest);

    const selectTarget = {
      idempotency_key: "idem_bbbbbbbbbbbbbbbb",
      operation: "select_target",
      target_reference: "local",
      version: TARGET_RESOURCE_REQUEST_VERSION
    };
    for (const invalid of [
      { context: "wrong", request: mutation() },
      { context: "prod_1", request: {} },
      { context: "prod_1", request: selectTarget },
      { context: "prod_1", extra: true, request: mutation() }
    ]) {
      await expect(access.resolver.resolve(invalid)).rejects.toThrow(
        TARGET_DEFAULT_AUTHORITIES_ERROR
      );
    }
  });
});
