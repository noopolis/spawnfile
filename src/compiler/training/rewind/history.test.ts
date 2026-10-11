import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { momentRecordSchema } from "./contract.js";
import { History, historyKey, openHistory, safeSegment } from "./history.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-rewind-history-")));
  roots.push(root);
  const directory = path.join(root, "history"), outside = path.join(root, "outside");
  await mkdir(directory); await mkdir(outside);
  await writeFile(path.join(outside, "secret"), "outside bytes");
  return { root, directory, outside, history: (await openHistory(directory))! };
};
const record = { version: "spawnfile.moment-record.v1", agent: "agent:writer",
  wake: { at: "2026-10-09T08:20:31Z", surface: "moltnet", room: "assignment", from: "brass" },
  recordedAt: "2026-10-09T08:20:31Z", resources: [], feeds: [], memory: [], moltnet: [], volumes: [] };

describe("history containment and strict reads", () => {
  it("allows missing history and entries but rejects non-directory roots and non-file reads", async () => {
    const { directory, history } = await fixture();
    expect(await openHistory()).toBeUndefined();
    expect(await history.path("missing/file")).toBeNull();
    expect(await history.bytes("missing")).toBeNull();
    expect(await history.jsonl("missing", z.object({}).strict())).toBeNull();
    await writeFile(path.join(directory, "file"), "bytes");
    await expect(openHistory(path.join(directory, "file"))).rejects.toThrow(/must be a directory/u);
    await expect(history.text(".")).rejects.toThrow(/regular file/u);
  });

  it.each(["../outside/secret", "child/../../outside/secret", "/etc/passwd", "bad\\path", "bad\0path"])(
    "refuses lexical escape or invalid history path %s", async (name) => {
      const { history } = await fixture();
      await expect(history.text(name)).rejects.toThrow(/escapes root|Unsafe history path/u);
    }
  );

  it("rejects outside symlinks, including missing descendants and outside links back inside", async () => {
    const { root, directory, outside, history } = await fixture();
    await writeFile(path.join(directory, "inside"), "retained");
    await symlink(path.join(outside, "secret"), path.join(directory, "escape"));
    await symlink(outside, path.join(directory, "external-directory"));
    await symlink(path.join(directory, "inside"), path.join(root, "back-inside"));
    for (const name of ["escape", "external-directory/secret", "external-directory/missing"]) {
      await expect(history.bytes(name)).rejects.toThrow(/History symlink escape/u);
    }
    await expect(history.bytes("../back-inside")).rejects.toThrow(/History path escapes root/u);
  });

  it("distinguishes dangling links from missing data and permits contained links", async () => {
    const { directory, history } = await fixture();
    await writeFile(path.join(directory, "real"), "retained");
    await symlink("real", path.join(directory, "alias"));
    await symlink("missing", path.join(directory, "dangling"));
    expect(await history.text("alias")).toBe("retained");
    await expect(history.text("dangling")).rejects.toThrow(/Dangling history symlink/u);
  });

  it.each(["{broken", '{"id":"second","unknown":true}', ""])(
    "names the exact malformed JSONL line for %j", async (second) => {
      const { directory, history } = await fixture();
      await writeFile(path.join(directory, "records.jsonl"), `{"id":"first"}\n${second}\n`);
      await expect(history.jsonl("records.jsonl", z.object({ id: z.string() }).strict()))
        .rejects.toThrow(/Invalid history records.jsonl:2:/u);
    }
  );

  it("loads every moment JSONL filename and ignores other files", async () => {
    const { directory, history } = await fixture();
    await mkdir(path.join(directory, "moments"));
    await writeFile(path.join(directory, "moments/z-any-name.jsonl"), `${JSON.stringify(record)}\n`);
    await writeFile(path.join(directory, "moments/a-capture.jsonl"), `${JSON.stringify({ ...record, agent: "agent:other" })}\n`);
    await writeFile(path.join(directory, "moments/ignore.txt"), "not JSON");
    expect((await history.records()).map((entry) => entry.agent)).toEqual(["agent:other", "agent:writer"]);
  });

  it.each([
    { ...record, unexpected: true },
    { ...record, wake: { ...record.wake, text: "not in the record format" } },
    { ...record, resources: [{ id: "same", kind: "git", commit: "one" }, { id: "same", kind: "git", commit: "two" }] }
  ])("strictly validates record fields and identities", async (invalid) => {
    const { directory, history } = await fixture();
    await writeFile(path.join(directory, "invalid.jsonl"), `${JSON.stringify(invalid)}\n`);
    await expect(history.jsonl("invalid.jsonl", momentRecordSchema)).rejects.toThrow(/invalid.jsonl:1:/u);
  });

  it("checks nested repository entries before granting a repository path", async () => {
    const { directory, outside, history } = await fixture();
    await mkdir(path.join(directory, "repo", "objects"), { recursive: true });
    await symlink(path.join(outside, "secret"), path.join(directory, "repo", "objects", "escape"));
    await expect(history.repository("repo")).rejects.toThrow(/History symlink escape/u);
  });

  it("copies retained bytes, executable mode, and internal relative links through the boundary", async () => {
    const { root, directory, history } = await fixture();
    await mkdir(path.join(directory, "tree"));
    await writeFile(path.join(directory, "tree", "script"), "retained bytes\n");
    await chmod(path.join(directory, "tree", "script"), 0o755);
    await symlink("script", path.join(directory, "tree", "alias"));
    const destination = path.join(root, "copy");
    await history.copyTree("tree", destination);
    expect(await readFile(path.join(destination, "script"), "utf8")).toBe("retained bytes\n");
    expect((await stat(path.join(destination, "script"))).mode & 0o777).toBe(0o755);
    expect(await readlink(path.join(destination, "alias"))).toBe("script");
  });

  it("encodes declaring node IDs and rejects unsafe input segments", () => {
    expect(historyKey({ declaredBy: "agent:writer", id: "archive" })).toBe("agent%3Awriter/archive");
    for (const value of ["", ".", "..", "a/b", "a\\b", "bad\0id"]) expect(() => safeSegment(value)).toThrow(/Unsafe history identity/u);
    expect(safeSegment("archive-1")).toBe("archive-1");
    expect(new History("/fixture").root).toBe("/fixture");
  });
});
