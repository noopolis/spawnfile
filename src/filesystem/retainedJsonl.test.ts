import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendRetainedJsonl, entryAt, readRetainedJsonl, retainEntries } from "./retainedJsonl.js";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

interface Entry { at: string; id: string }
const isEntry = (value: unknown): value is Entry => Boolean(value && typeof value === "object"
  && typeof (value as Entry).id === "string" && Number.isFinite(Date.parse((value as Entry).at)));
const timeOf = (entry: Entry) => entry.at;
const entry = (day: number, id = String(day)): Entry => ({ at: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, id });
const dayMs = 24 * 60 * 60_000;

describe("retained JSONL", () => {
  let directory: string, file: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "spawnfile-recording-")); file = path.join(directory, "history.jsonl"); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
  const append = (value: Entry, keepMs = 2 * dayMs) => appendRetainedJsonl(file, value, { keepMs, now: new Date(value.at), timeOf, isEntry });

  it("looks up inclusive instants, orders by timestamp and breaks ties by append order", () => {
    const entries = [entry(3), entry(1), entry(2, "earlier"), entry(2, "last")];
    expect(entryAt(entries, entry(2).at, timeOf)?.id).toBe("last");
    expect(entryAt(entries, new Date("2026-10-01T23:59:59.999Z"), timeOf)?.id).toBe("1");
    expect(entryAt(entries, "2026-09-30T23:59:59.999Z", timeOf)).toBeNull();
    expect(() => entryAt(entries, "invalid", timeOf)).toThrow(/instant/u);
    expect(retainEntries(entries, Date.parse(entry(2).at), timeOf)).toEqual([entries[0], entries[3]]);
  });

  it("retains the newest at or before cutoff even across a long gap", () => {
    append(entry(1)); append(entry(2)); append(entry(3)); append(entry(10));
    expect(readRetainedJsonl(file, isEntry)).toEqual({ entries: [entry(3), entry(10)], errors: [] });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(["history.jsonl"]);
  });

  it("performs each append in one write followed by fsync", () => {
    const write = vi.spyOn(fs, "writeSync"), sync = vi.spyOn(fs, "fsyncSync");
    append(entry(1));
    expect(write).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(write.mock.calls[0]![1])).toBe(true);
    expect(String(write.mock.calls[0]![1])).toBe(`${JSON.stringify(entry(1))}\n`);
    expect(sync).toHaveBeenCalledWith(write.mock.calls[0]![0]);
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[0]!);
  });

  it("reports corrupt lines and preserves them through retention", () => {
    expect(readRetainedJsonl(file, isEntry)).toEqual({ entries: [], errors: [] });
    fs.writeFileSync(file, `${JSON.stringify(entry(1))}\ninvalid\n{}\n\n${JSON.stringify(entry(2))}\n`);
    append(entry(10));
    const result = readRetainedJsonl(file, isEntry);
    expect(result.entries).toEqual([entry(2), entry(10)]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("line 1");
    expect(fs.readFileSync(file, "utf8")).toContain("invalid\n{}\n\n");
    expect(readRetainedJsonl(directory, isEntry).errors).toHaveLength(1);
    expect(readRetainedJsonl(file, (_): _ is Entry => { throw new Error("schema"); }).errors).toHaveLength(5);
  });

  it("refuses a torn tail, a short write, invalid entries, and invalid retention", () => {
    fs.writeFileSync(file, "{torn");
    expect(() => append(entry(1))).toThrow(/incomplete final line/u);
    expect(fs.readFileSync(file, "utf8")).toBe("{torn");
    fs.rmSync(file);
    const write = vi.spyOn(fs, "writeSync").mockReturnValueOnce(1);
    expect(() => append(entry(1))).toThrow(/Short/u);
    write.mockRestore();
    expect(() => appendRetainedJsonl(file, { at: "invalid", id: "bad" }, {
      keepMs: dayMs, now: new Date(entry(1).at), timeOf, isEntry
    })).toThrow(/invalid recording entry/u);
    expect(() => append(entry(1), 0)).toThrow(/retention/u);
  });

  it("leaves appended history intact if pruning cannot rename", () => {
    append(entry(1)); append(entry(2));
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("rename failed"); });
    expect(() => append(entry(10))).toThrow("rename failed");
    expect(readRetainedJsonl(file, isEntry).entries).toEqual([entry(1), entry(2), entry(10)]);
    expect(fs.readdirSync(directory)).toEqual(["history.jsonl"]);
  });
});
