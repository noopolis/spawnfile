import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BundleTarWriter } from "../../workspaceBundleTar.js";
import { materializeGit } from "./git.js";
import { commitTestGit, gitTestRoot, initTestGit, testMomentRecord } from "./git.test-helper.js";
import { History } from "./history.js";
import { verifyRecordedBundle } from "./recordedBundle.js";
import type { InputContext } from "./types.js";

const AT = "2026-10-09T08:20:31Z", EARLY = "2026-10-09T07:00:00Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await gitTestRoot(); roots.push(root);
  const historyRoot = path.join(root, "history"), archive = path.join(root, "bundle.tar");
  await mkdir(path.join(historyRoot, "bundles"), { recursive: true });
  const writer = await BundleTarWriter.create(archive);
  await writer.begin("tools/run", 6, 0o755); await writer.data(Buffer.from("saved\n")); await writer.end(); await writer.finish();
  const bytes = await readFile(archive), sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const context: InputContext = { at: AT, destination: path.join(root, "out"), history: new History(historyRoot),
    record: { ...testMomentRecord(), resources: [{ id: "tools", kind: "bundle", sha256 }] },
    input: { section: "resources", id: "tools", declaredBy: "agent:writer", declarationBase: root, overridden: false,
      declaration: { id: "tools", kind: "bundle", mode: "readonly", mount: "./tools", source: "never-read-current.tar" } } };
  return { root, historyRoot, context, bytes, sha256 };
};

describe("recorded bundle archive", () => {
  it("is exact only from the matching retained tar without a repository", async () => {
    const f = await fixture();
    await writeFile(path.join(f.historyRoot, `bundles/${f.sha256.slice(7)}.tar`), f.bytes);
    expect(await materializeGit(f.context)).toMatchObject({ fidelity: "exact", basis: "record", source: { sha256: f.sha256 } });
    expect(await readFile(path.join(f.context.destination, "tools/run"), "utf8")).toBe("saved\n");
    await verifyRecordedBundle(f.context.history, f.sha256, f.context.destination);
    await writeFile(path.join(f.context.destination, "tools/run"), "other\n");
    await expect(verifyRecordedBundle(f.context.history, f.sha256, f.context.destination)).rejects.toThrow("Recorded bundle entry mismatch");
  });

  it.each(["missing", "mismatch"])("falls back approximately when a recorded digest is %s even with a pinned source commit", async (kind) => {
    const f = await fixture(), repository = path.join(f.historyRoot, "git/agent%3Awriter/tools");
    await initTestGit(repository);
    const commit = await commitTestGit(repository, { "source.txt": "historical source\n" }, EARLY);
    f.context.input.declaration = { id: "tools", kind: "bundle", mode: "readonly", mount: "./tools", build: { files: { root: repository, ref: commit } } };
    if (kind === "mismatch") await writeFile(path.join(f.historyRoot, `bundles/${f.sha256.slice(7)}.tar`), Buffer.concat([f.bytes, Buffer.alloc(512)]));
    const result = await materializeGit(f.context);
    expect(result).toMatchObject({ fidelity: "approximate", source: { commit }, notes: expect.arrayContaining([expect.stringContaining("could not be reproduced")]) });
    expect(await readFile(path.join(f.context.destination, "source.txt"), "utf8")).toBe("historical source\n");
  });

  it("refuses a prebuilt resource when its recorded archive is unavailable", async () => {
    const f = await fixture();
    await expect(materializeGit(f.context)).rejects.toThrow("could not be reproduced");
  });

  it.each(["escape", "symlink", "hardlink", "device"])("refuses a digest-matching tar with a %s entry before writing output", async (kind) => {
    const f = await fixture(), bytes = Buffer.from(f.bytes);
    if (kind === "escape") { bytes.fill(0, 0, 100); bytes.write("../../escape", 0); }
    else bytes[156] = { symlink: 50, hardlink: 49, device: 51 }[kind]!;
    bytes.fill(32, 148, 156);
    const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    f.context.record!.resources = [{ id: "tools", kind: "bundle", sha256 }];
    await writeFile(path.join(f.historyRoot, `bundles/${sha256.slice(7)}.tar`), bytes);
    await expect(materializeGit(f.context)).rejects.toThrow(/unsafe tar entry/);
    await expect(readdir(f.context.destination)).rejects.toThrow();
  });
});
