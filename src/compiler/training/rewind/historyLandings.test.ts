import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as volume from "../../../volume/index.js";
import { materializeFeed } from "./feed.js";
import { gitTestRoot } from "./git.test-helper.js";
import { History } from "./history.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const AT = "2026-10-09T08:20:31Z", BEFORE = "2026-10-09T08:00:00Z";
const fixture = async () => {
  const root = await gitTestRoot(); roots.push(root);
  const key = "feeds/agent%3Awriter/news", directory = path.join(root, key), retained = path.join(directory, "retained");
  await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, "news.txt"), "past\n");
  const revision = volume.digestDirectory(retained), tree = path.join(directory, "trees", revision);
  await mkdir(tree, { recursive: true }); await writeFile(path.join(tree, "news.txt"), "past\n");
  const row: volume.FeedLanding = { version: "spawnfile.volume-feed-landing.v1", resource: "news", volume: "news",
    revision, tree: `trees/${revision}`, source: { kind: "directory", directory: "/never-read" }, switching_at: BEFORE, landed_at: BEFORE };
  const history = new History(root);
  const log = (rows: unknown[]) => writeFile(path.join(directory, "landings.jsonl"), rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const materialize = (at = AT) => materializeFeed({ at, history, record: null, destination: path.join(root, "out"), input: {
    section: "resources", id: "news", declaredBy: "agent:writer", declarationBase: root, overridden: false,
    declaration: { id: "news", kind: "volume", mode: "mutable", mount: "./news", name: "news", feed: { directory: "/never-read" } }
  } });
  return { history, key, row, log, materialize };
};

describe("merged feed landing readers in rewind", () => {
  it.each(["2026-10-09T08:20:30Z", AT, "2026-10-09T08:20:32Z"])("uses the merged inclusive ambiguity window at %s", async (at) => {
    const f = await fixture(), read = vi.spyOn(volume, "readFeedLandings"), lookup = vi.spyOn(volume, "feedLandingAt");
    const incoming = { ...f.row, switching_at: "2026-10-09T08:20:30Z", landed_at: "2026-10-09T08:20:32Z" };
    await f.log([f.row, incoming]);
    expect(await f.materialize(at)).toMatchObject({ fidelity: "approximate", basis: "landing-log",
      source: { switchingAt: incoming.switching_at, landedAt: incoming.landed_at }, notes: [expect.stringContaining("ambiguous")] });
    expect(read).toHaveBeenCalledOnce(); expect(lookup).toHaveBeenCalledWith([f.row, incoming], at);
  });

  it("selects the newest transition even when an older overlapping window was appended last", async () => {
    const f = await fixture();
    const newer = { ...f.row, switching_at: "2026-10-09T08:20:30Z", landed_at: "2026-10-09T08:20:32Z" };
    const older = { ...f.row, switching_at: "2026-10-09T08:20:29Z", landed_at: "2026-10-09T08:20:33Z" };
    await f.log([newer, older]);
    expect(await f.materialize()).toMatchObject({ fidelity: "approximate", source: { landedAt: newer.landed_at } });
  });

  it.each([false, true])("uses the last appended landing outside windows (reverse=%s)", async (reverse) => {
    const f = await fixture(), second = { ...f.row, volume: "second", landed_at: "2026-10-09T10:00:00+02:00" };
    const rows = reverse ? [second, f.row] : [f.row, second]; await f.log(rows);
    const result = await f.materialize();
    expect(result).toMatchObject({ fidelity: "exact", basis: "landing-log", source: { landedAt: rows[1]!.landed_at } });
  });

  it("keeps a zero-duration window ambiguous at its exact instant", async () => {
    const f = await fixture(); await f.log([f.row]);
    expect(await f.materialize(BEFORE)).toMatchObject({ fidelity: "approximate", basis: "landing-log" });
  });

  it.each(["missing boundary", "reversed boundary", "wrong tree", "wrong resource", "invalid line"])("refuses %s with its line number", async (change) => {
    const f = await fixture();
    const bad = { ...f.row, ...(change === "missing boundary" ? { switching_at: undefined } : {}),
      ...(change === "reversed boundary" ? { switching_at: AT } : {}),
      ...(change === "wrong tree" ? { tree: f.row.revision } : {}), ...(change === "wrong resource" ? { resource: "other" } : {}) };
    await f.log([f.row, change === "invalid line" ? {} : bad]);
    await expect(f.materialize()).rejects.toThrow(/landings.jsonl:2:/u);
  });

  it("keeps history containment before invoking the host reader", async () => {
    const f = await fixture();
    await expect(f.history.feedLandings("../escape", "news")).rejects.toThrow("escapes root");
  });
});
