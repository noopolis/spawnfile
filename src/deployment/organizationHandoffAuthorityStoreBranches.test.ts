import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeOrganizationHandoffAuthorityStore,
  type OrganizationHandoffAuthorityStore,
} from "./organizationHandoffAuthorityStore.js";
import {
  createOrganizationHandoff,
  parseCanonicalSha256Digest,
} from "./organizationHandoffTypes.js";

const previousHome = process.env.SPAWNFILE_HOME;
const homes: string[] = [];
const authorities: OrganizationHandoffAuthorityStore[] = [];
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const selectedTarget = {
  fingerprint: `sha256:${"a".repeat(32)}`,
  handle: `opaque_${"b".repeat(16)}`,
  version: "spawnfile.target-resource.selected-target.v1",
} as const;
const selectedTargetDigest = digest(JSON.stringify(selectedTarget));
const labels = {
  "com.spawnfile.compile_fingerprint": "sf1.abc",
  "com.spawnfile.deployment": "organization",
  "com.spawnfile.project": "organization",
  "com.spawnfile.run_id": "run-one",
  "com.spawnfile.unit": "organization-container",
  "com.spawnfile.version": "0.1",
};
const reservation = () => ({
  bindingDigest: `sha256:${"d".repeat(64)}`,
  containerName: "organization",
  deploymentLabels: labels,
  descriptorDigest: `sha256:${"c".repeat(64)}`,
  handoff: createOrganizationHandoff("run-one", {
    bindingDigest: parseCanonicalSha256Digest(`sha256:${"d".repeat(64)}`),
    networkAttachmentHandle: `opaque_${"e".repeat(16)}` as never,
    selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedTargetDigest),
  }),
  selectedTarget,
  selectedTargetReceiptDigest: selectedTargetDigest,
});

const initialize = async (): Promise<OrganizationHandoffAuthorityStore> => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-handoff-branches-"));
  homes.push(home);
  process.env.SPAWNFILE_HOME = home;
  const authority = await initializeOrganizationHandoffAuthorityStore();
  authorities.push(authority);
  return authority;
};

afterEach(async () => {
  await Promise.all(authorities.splice(0).map((authority) => authority.dispose()));
  if (previousHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = previousHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

describe("organization handoff authority public validation branches", () => {
  it("makes disposal idempotent and rejects later authority use", async () => {
    const authority = await initialize();
    await authority.dispose();
    await expect(authority.dispose()).resolves.toBeUndefined();
    await expect(authority.reserve(reservation())).rejects.toThrow(
      "Organization handoff authority failed",
    );
  });

  it("rejects invalid, unknown, and mismatched finalization identities", async () => {
    const authority = await initialize();
    const pending = await authority.reserve(reservation());
    const container = { containerId: "1".repeat(64), deploymentLabels: labels };
    for (const key of [null, "", "g".repeat(64)]) {
      await expect(authority.finalize(key, container)).rejects.toThrow();
    }
    await expect(authority.finalize(pending.pending_key, null as never)).rejects.toThrow();
    await expect(
      authority.finalize("a".repeat(64), container),
    ).rejects.toThrow();
    await expect(
      authority.finalize(pending.pending_key, {
        ...container,
        deploymentLabels: { ...labels, "com.spawnfile.unit": "other" },
      }),
    ).rejects.toThrow();
    await expect(
      authority.finalize(pending.pending_key, { ...container, containerId: "invalid" }),
    ).rejects.toThrow();
  });

  it("rejects invalid observation keys and distinguishes absent recovery records", async () => {
    const authority = await initialize();
    const pending = await authority.reserve(reservation());
    await expect(authority.readDockerMutation(null)).rejects.toThrow();
    await expect(authority.readDockerMutation("a".repeat(64))).resolves.toBeNull();
    await expect(
      authority.observeDockerMutation(pending.pending_key, {
        containerId: "1".repeat(64),
        deploymentLabels: labels,
        imageId: `sha256:${"2".repeat(64)}`,
      }),
    ).rejects.toThrow();
    await expect(
      authority.observeDockerMutation("a".repeat(64), {
        containerId: "1".repeat(64),
        deploymentLabels: labels,
        imageId: `sha256:${"2".repeat(64)}`,
      }),
    ).rejects.toThrow();
  });

  it("rejects malformed close requests before reading authority leaves", async () => {
    const authority = await initialize();
    for (const value of [null, [], {}, { expectedHandoff: {} }, {
      expectedHandoff: {},
      extra: true,
      organizationHandoffHandle: `opaque_${"f".repeat(16)}`,
    }]) {
      await expect(authority.close(value as never)).rejects.toThrow();
    }
  });

  it("rejects aborted and malformed resolution requests", async () => {
    const authority = await initialize();
    const controller = new AbortController();
    controller.abort();
    await expect(
      authority.resolver.resolve({ authorization: null, signal: controller.signal }),
    ).rejects.toThrow();
    await expect(authority.resolver.resolve({ authorization: null })).rejects.toThrow();
  });
});
