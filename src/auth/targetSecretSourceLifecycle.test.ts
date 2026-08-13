import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceLifecycle } from "./index.js";

const handle = (value: number) => parseTargetSecretSourceOpaqueHandle(`opaque_${value.toString(16).padStart(2, "0").repeat(16)}`);
const originalHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];
afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const publicGrant = () => ({
  descriptor_digest: `sha256:${"a".repeat(64)}`,
  name: "token",
  run_id: "run-1",
  scope: "world",
  selected_target: {
    fingerprint: `sha256:${"b".repeat(32)}`,
    handle: handle(9),
    version: "spawnfile.target-resource.selected-target.v1"
  },
  source_handle: handle(1)
});

describe("targetSecretSourceLifecycle", () => {
  it("exposes only public lifecycle results and the unchanged resolver", async () => {
    const calls: unknown[] = [];
    const resolver = { resolve: vi.fn() };
    const lifecycle = await initializeTargetSecretSourceLifecycle({
      author: { authorVersion: vi.fn(async () => ({ source_handle: handle(1) })) },
      grant: { grantSource: vi.fn(async (input) => { calls.push(input); return { source_handle: input.source_handle }; }) },
      resolver,
      revoke: {
        revokeGrant: vi.fn(async () => ({ kind: "grant" as const, source_handle: handle(1) })),
        revokeVersion: vi.fn(async () => ({ kind: "version" as const, source_handle: handle(1) }))
      },
      rotate: { rotateSource: vi.fn(async () => ({ source_handle: handle(2) })) }
    });
    expect(await lifecycle.author(new Uint8Array([1]))).toEqual({ source_handle: handle(1) });
    expect(await lifecycle.grant(publicGrant())).toEqual({ source_handle: handle(1) });
    expect(await lifecycle.rotate(handle(1), new Uint8Array([2]))).toEqual({ source_handle: handle(2) });
    expect(await lifecycle.revokeGrant(handle(1))).toEqual({ kind: "grant", source_handle: handle(1) });
    expect(await lifecycle.revokeVersion(handle(1))).toEqual({ kind: "version", source_handle: handle(1) });
    expect(lifecycle.resolver).toBe(resolver);
    expect(Object.isFrozen(lifecycle)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("source_version_handle");
    expect(JSON.stringify(calls)).not.toContain("publication_handle");
  });

  it("rejects hostile or private grant input before invoking the lifecycle grant", async () => {
    const grantSource = vi.fn();
    const lifecycle = await initializeTargetSecretSourceLifecycle({
      author: { authorVersion: vi.fn() },
      grant: { grantSource },
      resolver: { resolve: vi.fn() },
      revoke: { revokeGrant: vi.fn(), revokeVersion: vi.fn() },
      rotate: { rotateSource: vi.fn() }
    });
    const privateInput = { ...publicGrant(), source_version_handle: handle(2) };
    await expect(lifecycle.grant(privateInput)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    let reads = 0;
    const accessor = { ...publicGrant() };
    Object.defineProperty(accessor, "name", { enumerable: true, get: () => { reads += 1; return "token"; } });
    await expect(lifecycle.grant(accessor)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(reads).toBe(0);
    expect(grantSource).not.toHaveBeenCalled();
  });

  it("initializes repeatedly and sequentially against one fresh auth home", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-lifecycle-"));
    cleanup.push(home);
    process.env.SPAWNFILE_HOME = home;
    await expect(initializeTargetSecretSourceLifecycle()).resolves.toBeDefined();
    await expect(initializeTargetSecretSourceLifecycle()).resolves.toBeDefined();
  });

  it("revalidates and projects owner-service results before exposing them", async () => {
    const lifecycle = await initializeTargetSecretSourceLifecycle({
      author: { authorVersion: vi.fn(async () => ({ source_handle: handle(1), source_version_handle: handle(2) } as never)) },
      grant: { grantSource: vi.fn() },
      resolver: { resolve: vi.fn() },
      revoke: { revokeGrant: vi.fn(), revokeVersion: vi.fn() },
      rotate: { rotateSource: vi.fn() }
    });
    await expect(lifecycle.author(new Uint8Array([1]))).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });
});
