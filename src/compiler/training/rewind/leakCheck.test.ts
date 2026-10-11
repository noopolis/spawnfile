import { appendFile, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTrainingProjects } from "../plan/fixtures.test-helper.js";
import type { MaterializedMoment, LeakFinding } from "./contract.js";
import { AT, FUTURE, memoryEvent, rewindFixture, testGit } from "./fixtures.test-helper.js";
import { leakCheckTrainingMoment } from "./leakCheck.js";
import { finalizeTrainingMoment, materializeTrainingMoment } from "./materialize.js";
import { rewindGit } from "./gitProcess.js";
import { stampTree } from "./timestamps.js";

afterEach(cleanTrainingProjects);
type Fixture = Awaited<ReturnType<typeof rewindFixture>>;
type Mutation = (fixture: Fixture, moment: MaterializedMoment) => Promise<void>;
const inputPath = (fixture: Fixture, moment: MaterializedMoment, kind: string) =>
  path.join(fixture.options.out, moment.inputs.find((input) => input.kind === kind)!.path!);
const patchNetwork = async (fixture: Fixture, moment: MaterializedMoment, patch: (state: Record<string, any>) => void) => {
  const file = path.join(inputPath(fixture, moment, "moltnet"), "state.json");
  const state = JSON.parse(await readFile(file, "utf8")); patch(state); await writeFile(file, JSON.stringify(state));
};
const cases: Array<[string, LeakFinding["class"], Mutation]> = [
  ["future file mtime", "file-time", async (fixture) => { await writeFile(path.join(fixture.options.out, "future"), "future"); }],
  ["future directory mtime", "file-time", async (fixture) => { await mkdir(path.join(fixture.options.out, "new-directory")); }],
  ["future symlink mtime", "file-time", async (fixture) => { await symlink("moment.json", path.join(fixture.options.out, "new-link")); }],
  ["extra unreachable future commit", "git-object", async (fixture, moment) => {
    const code = inputPath(fixture, moment, "git");
    const pack = await rewindGit(fixture.gitRepo, ["pack-objects", "--revs", "--stdout"], Buffer.from(`${fixture.futureCommit}\n`));
    await rewindGit(code, ["index-pack", "--stdin"], pack);
  }],
  ["extra tag", "git-object", async (fixture, moment) => { testGit(inputPath(fixture, moment, "git"), ["tag", "leaked", fixture.commit]); }],
  ["extra remote", "git-object", async (fixture, moment) => { testGit(inputPath(fixture, moment, "git"), ["remote", "add", "leaked", fixture.gitRepo]); }],
  ["reachable commit future author only", "git-object", async (fixture, moment) => {
    const code = inputPath(fixture, moment, "git");
    testGit(code, ["commit", "--quiet", "--allow-empty", "--date=2026-10-10T00:00:00Z", "-m", "future author"]);
    moment.inputs.find((input) => input.kind === "git")!.source.commit = testGit(code, ["rev-parse", "HEAD"]);
    await writeFile(path.join(fixture.options.out, "moment.json"), JSON.stringify(moment));
  }],
  ["reachable commit future committer only", "git-object", async (fixture, moment) => {
    const code = inputPath(fixture, moment, "git");
    testGit(code, ["commit", "--quiet", "--allow-empty", "--date=2026-10-09T07:00:00Z", "-m", "future committer"], "2026-10-10T00:00:00Z");
    moment.inputs.find((input) => input.kind === "git")!.source.commit = testGit(code, ["rev-parse", "HEAD"]);
    await writeFile(path.join(fixture.options.out, "moment.json"), JSON.stringify(moment));
  }],
  ["future memory event", "memory-event", async (fixture, moment) => {
    await appendFile(path.join(inputPath(fixture, moment, "memory"), "memory/events.jsonl"), `${JSON.stringify(memoryEvent(2, FUTURE))}\n`);
  }],
  ["memory seq gap", "memory-event", async (fixture, moment) => {
    await appendFile(path.join(inputPath(fixture, moment, "memory"), "memory/events.jsonl"), `${JSON.stringify(memoryEvent(3))}\n`);
  }],
  ["memory audit state", "memory-event", async (fixture, moment) => {
    await writeFile(path.join(inputPath(fixture, moment, "memory"), "memory/index.sqlite"), "future derived state");
  }],
  ["future Moltnet message", "moltnet-message", async (fixture, moment) => patchNetwork(fixture, moment, (state) => {
    state.room_messages.assignment = [{ id: "future", network_id: "news", target: { kind: "room", room_id: "assignment" },
      from: { type: "agent", id: "writer" }, parts: [{ kind: "text", text: "future message" }], created_at: FUTURE }];
  })],
  ["future Moltnet event", "moltnet-event", async (fixture, moment) => patchNetwork(fixture, moment, (state) => {
    state.attachment_delivery_events = [{ id: "future", type: "test", network_id: "news", created_at: FUTURE }];
  })],
  ["future Moltnet room", "moltnet-room", async (fixture, moment) => patchNetwork(fixture, moment, (state) => {
    state.rooms.future = { id: "future", name: "Future", created_at: FUTURE };
  })],
  ["escaping symlink", "symlink-escape", async (fixture) => { await symlink("../outside", path.join(fixture.options.out, "escape")); }],
  ["absolute symlink", "symlink-escape", async (fixture) => { await symlink(fixture.root, path.join(fixture.options.out, "escape")); }],
  ["future dated path", "dated-path", async (fixture) => { await mkdir(path.join(fixture.options.out, "edition-2026-10-11")); }],
  ["tampered snapshot", "snapshot", async (fixture, moment) => { await writeFile(path.join(inputPath(fixture, moment, "volume"), "saved.txt"), "tampered"); }],
  ["future feed landing", "feed-identity", async (fixture, moment) => {
    const file = path.join(inputPath(fixture, moment, "feed"), ".spawnfile-feed.json");
    const identity = JSON.parse(await readFile(file, "utf8")); identity.landed_at = FUTURE; await writeFile(file, JSON.stringify(identity));
  }],
  ["feed current outside its volume", "feed-identity", async (fixture, moment) => {
    const link = path.join(inputPath(fixture, moment, "feed"), "current");
    await rm(link); await symlink("../code", link);
  }]
];

describe("independent disk leak check mutation guarantees", () => {
  it.each(cases)("refuses %s with class %s", async (_name, expectedClass, mutate) => {
    const fixture = await rewindFixture();
    const moment = await materializeTrainingMoment(fixture.options);
    expect(moment.status).toBe("materialized");
    await mutate(fixture, moment);
    // Non-time violations must be detected from content even when their filesystem timestamps look old.
    if (expectedClass !== "file-time") await stampTree(fixture.options.out, AT, AT);
    else await utimes(path.join(fixture.options.out, "moment.json"), new Date(AT), new Date(AT));
    const check = await leakCheckTrainingMoment(fixture.options.out, { historyDir: fixture.historyDir });
    expect(check.ok).toBe(false);
    expect(check.findings.map((finding) => finding.class)).toContain(expectedClass);
    const out = path.join(fixture.root, "rejected");
    const refused = await finalizeTrainingMoment(fixture.options.out, out, { historyDir: fixture.historyDir });
    expect(refused.status).toBe("refused");
    expect(refused.leakCheck.ok).toBe(false);
    expect(refused.inputs.every((input) => input.path === null)).toBe(true);
    expect(await readdir(out)).toEqual(["leak-check.json", "moment.json"]);
  });
});
