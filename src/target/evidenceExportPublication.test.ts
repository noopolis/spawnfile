import { chmod, chown, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runLifecycleExport, header, type LifecycleExportFixture, type LifecycleExportInput, cleanupTestRoots } from "./evidenceExportOperationsTestKit.js";
import { isEvidenceExportIncomplete } from "./evidenceExport.js";
import { canonicalEvidenceArchive } from "./evidenceExportArchive.js";

afterEach(async () => cleanupTestRoots());

const completeSameProcess = async (fixture: LifecycleExportFixture, destination?: string): Promise<void> => {
  const first = fixture.execute(destination);
  const duplicate = fixture.execute(destination);
  const [primary, duplicateResult] = await Promise.all([first, duplicate]);
  expect(duplicateResult).toMatchObject(primary as object);
  expect(fixture.getExportCalls()).toBe(1);
  expect(fixture.getRemoveCalls()).toBe(1);
};

const onceFail = (): (() => Promise<void>) => {
  let first = true;
  return async () => {
    if (!first) return;
    first = false;
    throw new Error("simulated boundary failure");
  };
};

describe("evidence export helper container lifecycle", () => {
  it("creates absent helper containers and removes them after successful export", async () => {
    const fixture = await runLifecycleExport();
    const result = await fixture.execute();
    expect(result).toMatchObject({ index: { item_count: 1 }, receipt: { result_handle: expect.any(String) } });
    const publicResult = result as {
      index: { files: unknown; source: { state: string } };
      receipt: { evidence_index: unknown };
    };
    expect(publicResult.index.files).toEqual([{
      bytes: 4, path: "ball",
      sha256: "sha256:0db10f2c2f332cd27cf1407fa16c686337b2b23f46125d6e17740dbfc6df427e"
    }]);
    expect(publicResult.index.source.state).toBe("preserved");
    expect(publicResult.receipt.evidence_index).toEqual(publicResult.index);
    expect(fixture.calls.filter((args) => args[2] === "container" && args[3] === "create")).toHaveLength(1);
    expect(fixture.calls.filter((args) => args[2] === "container" && args[3] === "inspect")).toHaveLength(1);
    expect(fixture.getExportCalls()).toBe(1);
    expect(fixture.getRemoveCalls()).toBe(1);
    expect((result as { index: { evidence_digest: string } }).index.evidence_digest).toMatch(/^sha256:/u);
  });

  it("removes the helper when create succeeds but container inspect is invalid", async () => {
    const fixture = await runLifecycleExport({ foreignInspect: "projection" });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.getExportCalls()).toBe(0);
    expect(fixture.getRemoveCalls()).toBe(1);
    expect(fixture.getRemoveArgs()).toEqual([[ "--context", "test_context", "container", "rm", "-f", fixture.getContainerName() ?? "spfe" ]]);
  });

  it("removes the helper when create succeeds but container inspect transport fails", async () => {
    const fixture = await runLifecycleExport({ foreignInspect: "transport" });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.getExportCalls()).toBe(0);
    expect(fixture.getRemoveCalls()).toBe(1);
    expect(fixture.getRemoveArgs()).toEqual([[ "--context", "test_context", "container", "rm", "-f", fixture.getContainerName() ?? "spfe" ]]);
  });

  it("adopts exact helper collisions after create transport ambiguity", async () => {
    const fixture = await runLifecycleExport({ createShouldFail: true });
    const result = await fixture.execute();
    expect(result).toMatchObject({ index: { item_count: 1 }, receipt: { result_handle: expect.any(String) } });
    expect(fixture.getExportCalls()).toBe(1);
    expect(fixture.getRemoveCalls()).toBe(1);
    expect(fixture.getRemoveArgs()).toEqual([[ "--context", "test_context", "container", "rm", "-f", fixture.getContainerName() ?? "spfe" ]]);
  });

  it("retains foreign helper collisions when create transport ambiguity is invalid", async () => {
    const fixture = await runLifecycleExport({ createShouldFail: true, foreignInspect: "projection" });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.getExportCalls()).toBe(0);
    expect(fixture.getRemoveCalls()).toBe(0);
    expect(fixture.getRemoveArgs()).toHaveLength(0);
  });

  it("removes helper container when export start fails", async () => {
    const fixture = await runLifecycleExport({ startShouldFail: true });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.getExportCalls()).toBe(1);
    expect(fixture.getRemoveCalls()).toBe(1);
    expect(fixture.getRemoveArgs()).toEqual([[ "--context", "test_context", "container", "rm", "-f", fixture.getContainerName() ?? "spfe" ]]);
  });

  it("returns failure when cleanup removal fails", async () => {
    const fixture = await runLifecycleExport({ cleanupShouldFail: true });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.getExportCalls()).toBe(1);
    expect(fixture.getRemoveCalls()).toBe(1);
    expect(fixture.getRemoveArgs()).toEqual([[ "--context", "test_context", "container", "rm", "-f", fixture.getContainerName() ?? "spfe" ]]);
  });

  it("hard-fails when an existing destination is present without committed index, then retries as incomplete", async () => {
    const fixture = await runLifecycleExport();
    const destination = path.join(fixture.directory, "preexisting.tar");
    await writeFile(destination, Buffer.from("preexisting"));
    const beforeRevision = await fixture.readJournalRevision();
    const beforeExports = fixture.getExportCalls();
    await expect(fixture.execute(destination)).rejects.toThrow("Evidence-volume export failed");
    expect(await fixture.readJournalRevision()).toBe(beforeRevision);
    expect(fixture.getExportCalls()).toBe(beforeExports);
    await expect(fixture.execute(destination)).rejects.toSatisfy(isEvidenceExportIncomplete);
    expect(await fixture.readJournalRevision()).toBe(beforeRevision);
    expect(fixture.getExportCalls()).toBe(beforeExports);
  });
});

describe("evidence export publication boundaries", () => {
  it("runs the index-load hook before the private index read", async () => {
    let loaded = false;
    const fixture = await runLifecycleExport({
      boundaryFailures: { beforeIndexLoad: () => expect(loaded).toBe(false) },
      onLoadIndex: () => { loaded = true; }
    });
    await fixture.execute();
    expect(loaded).toBe(true);
  });

  it("does not remove a foreign temp collision when exclusive creation fails", async () => {
    let collision = "";
    const fixture = await runLifecycleExport({
      boundaryFailures: {
        beforePublishTempOpen: async (temporary) => {
          collision = temporary;
          await writeFile(temporary, "foreign-temp", { mode: 0o600 });
        }
      }
    });
    await expect(fixture.execute()).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(collision, "utf8")).toBe("foreign-temp");
    expect(fixture.getRemoveCalls()).toBe(1);
  });

  it("resumes an exact deterministic pending publication", async () => {
    const raw = new Uint8Array([...header("ball", Buffer.from("kick")), ...Buffer.from("kick"), ...Buffer.alloc(508), ...Buffer.alloc(1024)]);
    const expected = canonicalEvidenceArchive(raw).bytes;
    let pending = "";
    const fixture = await runLifecycleExport({
      boundaryFailures: {
        beforePublishTempOpen: async (temporary) => {
          pending = temporary;
          await writeFile(temporary, expected, { mode: 0o600 });
        }
      }
    });
    await expect(fixture.execute()).resolves.toBeDefined();
    await expect(readFile(pending)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(fixture.directory, "match.tar"))).toEqual(Buffer.from(expected));
  });

  it("rejects a destination directory that is not exact 0700", async () => {
    const fixture = await runLifecycleExport();
    const output = path.join(fixture.directory, "public-output");
    await mkdir(output, { mode: 0o755 });
    await chmod(output, 0o755);
    await expect(fixture.execute(path.join(output, "match.tar"))).rejects.toThrow("Evidence-volume export failed");
    expect(fixture.getExportCalls()).toBe(0);
  });

  it("rejects a foreign-owned private destination directory when ownership can be changed", async () => {
    if ((process.getuid?.() ?? -1) !== 0) return;
    const fixture = await runLifecycleExport();
    const output = path.join(fixture.directory, "foreign-output");
    await mkdir(output, { mode: 0o700 });
    await chown(output, 1, -1);
    try {
      await expect(fixture.execute(path.join(output, "match.tar"))).rejects.toThrow("Evidence-volume export failed");
      expect(fixture.getExportCalls()).toBe(0);
    } finally { await chown(output, 0, -1); }
  });

  it("coalesces in-process exact repeated requests", async () => {
    const fixture = await runLifecycleExport();
    await completeSameProcess(fixture);
  });

  it("rejects conflicting destination values for the same in-process idempotency key", async () => {
    const fixture = await runLifecycleExport();
    const primary = fixture.execute(path.join(fixture.directory, "first.tar"));
    await expect(fixture.execute(path.join(fixture.directory, "second.tar"))).rejects.toThrow("Evidence-volume export failed");
    await expect(primary).resolves.toBeDefined();
  });

  it.each([
    "beforeBindAdmission",
    "beforeBindDestination",
    "beforeRequireDestination",
    "beforeIndexLoad",
    "beforeIndexBind",
    "beforeArchive",
    "beforePublishTempWrite",
    "beforePublishTempSync",
    "beforePublishFinalLink",
    "beforePublishDirectorySync",
    "beforeJournalComplete"
  ] as const)(
    "hard-fails at %s on first call, then retries with incomplete without additional effects",
    async (hook) => {
      const failure = onceFail();
      const fixture = await runLifecycleExport({
        boundaryFailures: { [hook]: failure } as LifecycleExportInput["boundaryFailures"]
      });
      const destination = path.join(fixture.directory, `${hook}.tar`);
      const beforeRevision = await fixture.readJournalRevision();
      const beforeExports = fixture.getExportCalls();
      const beforeRemoves = fixture.getRemoveCalls();
      await expect(fixture.execute(destination)).rejects.toThrow("Evidence-volume export failed");
      expect(await fixture.readJournalRevision()).toBe(beforeRevision);
      expect(fixture.getExportCalls()).toBeGreaterThanOrEqual(beforeExports);
      expect(fixture.getRemoveCalls()).toBeGreaterThanOrEqual(beforeRemoves);
      const afterExports = fixture.getExportCalls();
      const afterRemoves = fixture.getRemoveCalls();
      await expect(fixture.execute(destination)).rejects.toSatisfy(isEvidenceExportIncomplete);
      expect(fixture.getExportCalls()).toBe(afterExports);
      expect(fixture.getRemoveCalls()).toBe(afterRemoves);
      expect(await fixture.readJournalRevision()).toBe(beforeRevision);
    }
  );

  it("writes exported files with exact 0600 permissions even with permissive umask", async () => {
    const previous = process.umask(0o027);
    try {
      const fixture = await runLifecycleExport();
      const destination = path.join(fixture.directory, "umask.tar");
      await fixture.execute(destination);
      expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("does not overwrite a committed destination candidate when metadata does not match", async () => {
    const fixture = await runLifecycleExport();
    const destination = path.join(fixture.directory, "committed.tar");
    await fixture.execute(destination);
    await chmod(destination, 0o644);
    const beforeRevision = await fixture.readJournalRevision();
    await expect(fixture.execute(destination)).rejects.toThrow("Evidence-volume export failed");
    expect(await fixture.readJournalRevision()).toBe(beforeRevision);
  });

  it("reuses committed destination bytes when metadata and digest are exact", async () => {
    const fixture = await runLifecycleExport();
    const destination = path.join(fixture.directory, "candidate.tar");
    const first = await fixture.execute(destination);
    expect(first).toHaveProperty("index");
    const beforeExports = fixture.getExportCalls();
    const second = await fixture.execute(destination);
    expect(second).toMatchObject({ index: (first as { readonly index: unknown }).index });
    expect(fixture.getExportCalls()).toBe(beforeExports);
    expect(fixture.getRemoveCalls()).toBe(1);
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
  });

  it("hard-fails for hostile destination symlink parents before completion and then returns incomplete on retry", async () => {
    const fixture = await runLifecycleExport();
    const real = path.join(fixture.directory, "drift");
    await mkdir(real);
    const link = path.join(fixture.directory, "drift-link");
    await symlink(real, link);
    const destination = path.join(link, "drift.tar");
    const beforeRevision = await fixture.readJournalRevision();
    const beforeExports = fixture.getExportCalls();
    await expect(fixture.execute(destination)).rejects.toThrow("Evidence-volume export failed");
    expect(await fixture.readJournalRevision()).toBe(beforeRevision);
    expect(fixture.getExportCalls()).toBe(beforeExports);
    await expect(fixture.execute(destination)).rejects.toSatisfy(isEvidenceExportIncomplete);
    expect(await fixture.readJournalRevision()).toBe(beforeRevision);
    expect(fixture.getExportCalls()).toBe(beforeExports);
  });
});
