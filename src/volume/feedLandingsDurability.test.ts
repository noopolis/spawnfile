import * as fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { readFeedLandings } from "./feedLandings.js";
import { readFeedLanded } from "./feedRecord.js";
import { refreshVolumeFeed } from "./feedRefresh.js";
import { createFeedFixture, writeSourceFiles, type FeedFixture } from "./feedTestKit.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
let fixture: FeedFixture;
afterEach(() => { vi.restoreAllMocks(); fixture?.cleanup(); });
const at = (day: number) => ({ now: () => new Date(`2026-10-0${day}T08:00:00.000Z`) });

it.each(["file", "directory"])("durably reconciles a visible tail after %s fsync fails before recording-off replacement", (failed) => {
  fixture = createFeedFixture({ record: { keepMs: 30 * 86_400_000 } });
  refreshVolumeFeed(fixture.target, at(1));
  writeSourceFiles(fixture.source, { "a.txt": "B\n" });
  const log = path.join(fixture.target.stateDir, "landings.jsonl"), landed = path.join(fixture.target.stateDir, "landed.json");
  const handles = new Map<number, string>(), events: string[] = [];
  const open = fs.openSync, write = fs.writeSync, sync = fs.fsyncSync, rename = fs.renameSync;
  let appended = false, fail = true;
  vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
    const fd = open(file, ...args); handles.set(fd, String(file)); return fd;
  });
  vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Uint8Array) => {
    const written = write(fd, bytes);
    if (handles.get(fd) === log) appended = true;
    return written;
  }) as typeof fs.writeSync);
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const file = handles.get(fd);
    if (fail && appended && file === (failed === "file" ? log : fixture.target.stateDir)) throw new Error(`${failed} fsync failed`);
    sync(fd); events.push(`sync:${file}`);
  });
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { rename(from, to); events.push(`rename:${String(to)}`); });
  expect(() => refreshVolumeFeed(fixture.target, at(2))).toThrow(`${failed} fsync failed`);
  const pending = readFeedLanded(fixture.target.stateDir).record!;
  expect(readFeedLandings(fixture.target.stateDir).entries.at(-1)).toEqual(pending.recording!.landing);
  fixture.target.record = undefined;
  writeSourceFiles(fixture.source, { "a.txt": "C\n" });
  // Matching bytes must retry durability; failure must still forbid replacement.
  expect(() => refreshVolumeFeed(fixture.target, at(3))).toThrow(`${failed} fsync failed`);
  expect(readFeedLanded(fixture.target.stateDir).record).toEqual(pending);
  fail = false; events.length = 0;
  expect(refreshVolumeFeed(fixture.target, at(3)).status).toBe("landed");
  const fileSync = events.indexOf(`sync:${log}`), directorySync = events.indexOf(`sync:${fixture.target.stateDir}`);
  expect(fileSync).toBeGreaterThanOrEqual(0);
  expect(directorySync).toBeGreaterThan(fileSync);
  expect(events.indexOf(`rename:${landed}`)).toBeGreaterThan(directorySync);
  expect(readFeedLanded(fixture.target.stateDir).record).not.toHaveProperty("recording");
  expect(readFeedLandings(fixture.target.stateDir).entries.map((entry) => entry.landed_at)).toEqual([at(1).now().toISOString(), at(2).now().toISOString()]);
});
