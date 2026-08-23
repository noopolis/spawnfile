import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPreparedEvidenceHelperKey,
  initializePreparedEvidenceHelperAuthorityStore,
  newPreparedEvidenceHelperCompletionRecord,
  newPreparedEvidenceHelperPendingRecord,
  parsePreparedEvidenceHelperReceipt,
} from "./preparedAuthority.js";

const roots: string[] = [];
const digest = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;
const facts = Object.freeze({
  base_config_digest: digest("a"),
  base_image: "node:22-bookworm-slim",
  context: "local_dev",
  daemon_digest: digest("b"),
  endpoint_digest: digest("c"),
  platform: Object.freeze({ architecture: "arm64" as const, os: "linux" as const }),
  recipe_digest: digest("d"),
});
const key = createPreparedEvidenceHelperKey({
  baseConfigDigest: facts.base_config_digest,
  context: facts.context,
  daemonDigest: facts.daemon_digest,
  endpointDigest: facts.endpoint_digest,
  platform: facts.platform,
  recipeDigest: facts.recipe_digest,
});

const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prepared-authority-")));
  roots.push(root);
  const privateRoot = path.join(root, "state");
  const pending = newPreparedEvidenceHelperPendingRecord(facts);
  return { pending, privateRoot };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("prepared evidence helper authority", () => {
  it("converges independently opened stores on one deterministic fsynced reservation", async () => {
    const value = await fixture();
    const stores = await Promise.all(Array.from({ length: 8 }, () =>
      initializePreparedEvidenceHelperAuthorityStore(value.privateRoot)));
    const reservations = await Promise.all(stores.map((store) => store.reserve(key, value.pending)));
    expect(reservations).toEqual(Array.from({ length: 8 }, () => value.pending));
    const completion = newPreparedEvidenceHelperCompletionRecord(value.pending, digest("e"));
    const completions = await Promise.all(stores.map((store) => store.complete(key, completion)));
    expect(completions).toEqual(Array.from({ length: 8 }, () => completion));
    expect(await readdir(value.privateRoot)).toEqual([`${key}.complete.json`, `${key}.pending.json`]);
    await expect(stat(path.join(value.privateRoot, `${key}.pending.json`)))
      .resolves.toMatchObject({ nlink: 1 });
    await expect(stat(path.join(value.privateRoot, `${key}.complete.json`)))
      .resolves.toMatchObject({ nlink: 1 });
  });

  it("makes the public opaque receipt change with the accepted config identity", async () => {
    const value = await fixture();
    const accepted = newPreparedEvidenceHelperCompletionRecord(value.pending, digest("e"));
    const changed = newPreparedEvidenceHelperCompletionRecord(value.pending, digest("f"));
    expect(changed.receipt.handle).not.toBe(accepted.receipt.handle);
    expect(changed.receipt.digest).not.toBe(accepted.receipt.digest);
    expect(changed.accepted_image_config_digest).toBe(digest("f"));
  });

  it("rejects a conflicting pending record rather than adopting a nearby base tag", async () => {
    const value = await fixture();
    const store = await initializePreparedEvidenceHelperAuthorityStore(value.privateRoot);
    await store.reserve(key, value.pending);
    await expect(store.reserve(key, { ...value.pending, base_image: "node:22-alpine" }))
      .rejects.toThrow("Prepared evidence-export helper failed");
  });

  it("rejects accessor and proxy public receipts without reading them", () => {
    let reads = 0;
    const accessor = {
      handle: `opaque_${"a".repeat(64)}`,
      version: "spawnfile.target-evidence-export-helper.prepared.v1",
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "digest", {
      enumerable: true,
      get: () => { reads += 1; return digest("b"); },
    });
    expect(() => parsePreparedEvidenceHelperReceipt(accessor)).toThrow("Prepared evidence-export helper failed");
    expect(() => parsePreparedEvidenceHelperReceipt(new Proxy({
      digest: digest("b"), handle: `opaque_${"a".repeat(64)}`,
      version: "spawnfile.target-evidence-export-helper.prepared.v1",
    }, {}))).toThrow("Prepared evidence-export helper failed");
    expect(reads).toBe(0);
  });
});
