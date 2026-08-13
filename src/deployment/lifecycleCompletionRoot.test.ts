import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LIFECYCLE_RECORD_MAX_BYTES } from "./lifecycleCompletionContracts.js";
import {
  existingLifecycleRoot,
  lifecycleRoot,
  openLifecycleAuthorityRoot,
  requireLifecycleRootAuthority,
  revalidateHeldLifecycleRoot,
  revalidateLifecycleRootAuthority,
  syncLifecycleDirectory,
  validateLifecycleRoot
} from "./lifecycleCompletionRoot.js";
import {
  publishLifecycleRecord,
  readLifecycleRecord,
  setLifecycleStoreTestHook
} from "./lifecycleCompletionStore.js";

const originalHome = process.env.SPAWNFILE_HOME;
const roots: string[] = [];

afterEach(async () => {
  setLifecycleStoreTestHook(null);
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

const createHome = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lifecycle-root-unit-"));
  roots.push(root);
  process.env.SPAWNFILE_HOME = root;
  return root;
};

describe("lifecycle completion root authority", () => {
  it("keeps a read-only missing home absent and creates its secure chain on demand", async () => {
    const parent = await createHome();
    const nested = path.join(parent, "missing", "home");
    process.env.SPAWNFILE_HOME = nested;
    await expect(validateLifecycleRoot(false)).resolves.toBeNull();
    await expect(existingLifecycleRoot()).resolves.toBeNull();

    const authority = await validateLifecycleRoot(true);
    const canonical = await realpath(nested);
    expect(authority).toMatchObject({
      canonicalHome: canonical,
      configuredHome: nested,
      root: path.join(canonical, "lifecycle-completions")
    });
    expect(await lifecycleRoot()).toBe(authority?.root);
    expect(await validateLifecycleRoot(true)).toBe(authority);
  });

  it("opens, revalidates, and syncs only the captured root identity", async () => {
    const home = await createHome();
    const authority = await requireLifecycleRootAuthority();
    const handle = await openLifecycleAuthorityRoot(authority);
    try {
      await expect(revalidateHeldLifecycleRoot(authority, handle)).resolves.toBeUndefined();
      await expect(syncLifecycleDirectory(authority.root)).resolves.toBeUndefined();
      await expect(syncLifecycleDirectory(path.join(home, "elsewhere"))).rejects.toThrow(
        /unsafe root/
      );

      const identities = authority.identities.map((identity, index) =>
        index === authority.identities.length - 1
          ? { ...identity, ino: identity.ino + 1 }
          : identity
      );
      const changed = { ...authority, identities };
      await expect(revalidateLifecycleRootAuthority(changed)).rejects.toThrow(/root changed/);
      await expect(revalidateHeldLifecycleRoot(changed, handle)).rejects.toThrow(/root changed/);
    } finally {
      await handle.close();
    }
  });

  it("rejects authority roots whose protected directory mode changes", async () => {
    await createHome();
    const authority = await requireLifecycleRootAuthority();
    await chmod(authority.root, 0o755);
    await expect(revalidateLifecycleRootAuthority(authority)).rejects.toThrow(/unsafe root/);
    await chmod(authority.root, 0o700);
  });

  it("rejects a regular-file home and a canonical-home mismatch", async () => {
    const parent = await createHome();
    const fileHome = path.join(parent, "file-home");
    await writeFile(fileHome, "not a directory", "utf8");
    process.env.SPAWNFILE_HOME = fileHome;
    await expect(validateLifecycleRoot(true)).rejects.toThrow(/unsafe root/);

    process.env.SPAWNFILE_HOME = parent;
    const authority = await requireLifecycleRootAuthority();
    await expect(revalidateLifecycleRootAuthority({
      ...authority,
      canonicalHome: `${authority.canonicalHome}-different`
    })).rejects.toThrow(/root changed/);
  });

  it("rejects unsafe fresh modes but adopts an exact secure preexisting root", async () => {
    const unsafeHome = await createHome();
    await chmod(unsafeHome, 0o755);
    await expect(validateLifecycleRoot(true)).rejects.toThrow(/unsafe root/);

    const publicHome = await createHome();
    await chmod(publicHome, 0o777);
    await expect(validateLifecycleRoot(true)).rejects.toThrow(/unsafe root/);

    const writableHome = await createHome();
    const writableRoot = path.join(writableHome, "lifecycle-completions");
    await mkdir(writableRoot, { mode: 0o700 });
    await chmod(writableRoot, 0o777);
    await expect(validateLifecycleRoot(false)).rejects.toThrow(/unsafe root/);

    const secureHome = await createHome();
    const secureRoot = path.join(secureHome, "lifecycle-completions");
    await mkdir(secureRoot, { mode: 0o700 });
    await expect(validateLifecycleRoot(true)).resolves.toMatchObject({
      root: await realpath(secureRoot)
    });
  });

  it("closes a newly opened root handle when its captured identity changes", async () => {
    await createHome();
    const authority = await requireLifecycleRootAuthority();
    const changed = authority.identities.map((identity, index) =>
      index === authority.identities.length - 1
        ? { ...identity, ino: identity.ino + 1 }
        : identity
    );
    let reads = 0;
    const switching = {
      ...authority,
      get identities() {
        reads += 1;
        return reads === 1 ? authority.identities : changed;
      }
    };
    await expect(openLifecycleAuthorityRoot(switching)).rejects.toThrow(/root changed/);
    expect(reads).toBe(2);
  });
});

describe("lifecycle completion store publication", () => {
  it("publishes once and treats matching or ignored existing records as settled", async () => {
    await createHome();
    const root = await lifecycleRoot();
    const file = "unit.record";
    await expect(publishLifecycleRecord(root, file, "exact\n")).resolves.toBe(true);
    await expect(readLifecycleRecord(path.join(root, file))).resolves.toBe("exact\n");
    await expect(publishLifecycleRecord(root, file, "exact\n")).resolves.toBe(false);
    await expect(publishLifecycleRecord(root, file, "different\n", "ignore"))
      .resolves.toBe(false);
  });

  it("fails closed for foreign roots, paths, and oversized publication bytes", async () => {
    const home = await createHome();
    const root = await lifecycleRoot();
    await expect(publishLifecycleRecord(
      root,
      "oversize.record",
      "x".repeat(LIFECYCLE_RECORD_MAX_BYTES + 1)
    )).rejects.toThrow(/oversize record/);
    await expect(publishLifecycleRecord(home, "foreign.record", "x"))
      .rejects.toThrow(/unsafe root/);
    await expect(readLifecycleRecord(path.join(home, "foreign.record")))
      .rejects.toThrow(/unsafe record/);
  });

  it("returns null before a root exists and detects record replacement before open", async () => {
    const home = await createHome();
    await expect(readLifecycleRecord(path.join(home, "lifecycle-completions", "missing")))
      .resolves.toBeNull();
    const root = await lifecycleRoot();
    await publishLifecycleRecord(root, "replace.record", "original\n");
    const file = path.join(root, "replace.record");
    const prior = `${file}.prior`;
    setLifecycleStoreTestHook(async (point) => {
      if (point !== "before_record_open") return;
      setLifecycleStoreTestHook(null);
      await rename(file, prior);
      await writeFile(file, "replacement\n", { mode: 0o600 });
    });
    await expect(readLifecycleRecord(file)).rejects.toThrow(/record changed/);
  });

  it("rejects a record whose safe mode changes immediately before open", async () => {
    await createHome();
    const root = await lifecycleRoot();
    await publishLifecycleRecord(root, "mode.record", "content\n");
    const file = path.join(root, "mode.record");
    setLifecycleStoreTestHook(async (point) => {
      if (point !== "before_record_open") return;
      setLifecycleStoreTestHook(null);
      await chmod(file, 0o400);
    });
    await expect(readLifecycleRecord(file)).rejects.toThrow(/unsafe record/);
    await chmod(file, 0o600);
  });

  it("handles exact and divergent final-link collision races without overwrite", async () => {
    await createHome();
    const root = await lifecycleRoot();
    const collide = async (file: string, finalContent: string, expected: boolean | "failure") => {
      setLifecycleStoreTestHook(async (point) => {
        if (point !== "before_publish_link") return;
        setLifecycleStoreTestHook(null);
        await writeFile(path.join(root, file), finalContent, { flag: "wx", mode: 0o600 });
      });
      const publication = publishLifecycleRecord(root, file, "expected\n");
      if (expected === "failure") await expect(publication).rejects.toThrow(/publication changed/);
      else await expect(publication).resolves.toBe(expected);
    };
    await collide("exact-race.record", "expected\n", false);
    await collide("different-race.record", "different\n", "failure");
  });

  it("fails when an ignored link-race publication disappears before settlement", async () => {
    await createHome();
    const root = await lifecycleRoot();
    const file = "vanishing-race.record";
    const final = path.join(root, file);
    setLifecycleStoreTestHook(async (point) => {
      if (point === "before_publish_link") {
        await writeFile(final, "collision\n", { flag: "wx", mode: 0o600 });
      }
      if (point === "before_publish_unlink") {
        await rm(final);
        setLifecycleStoreTestHook(null);
      }
    });
    await expect(publishLifecycleRecord(root, file, "expected\n", "ignore"))
      .rejects.toThrow(/publication changed/);
  });
});
