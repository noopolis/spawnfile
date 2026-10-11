import { lstat, lutimes, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
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
  ["future report atime", "file-time", async () => {}],
  ["future report mtime", "file-time", async () => {}],
  ["future file atime", "file-time", async (fixture) => { await writeFile(path.join(fixture.options.out, "future"), "future"); }],
  ["future directory atime", "file-time", async (fixture) => { await mkdir(path.join(fixture.options.out, "new-directory")); }],
  ["future symlink atime", "file-time", async (fixture) => { await symlink("moment.json", path.join(fixture.options.out, "new-link")); }],
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
    const file = path.join(inputPath(fixture, moment, "memory"), "memory/events.jsonl");
    const event = JSON.parse((await readFile(file, "utf8")).trim());
    await writeFile(file, `${JSON.stringify({ ...event, createdAt: FUTURE })}\n`);
  }],
  ["memory seq gap", "memory-event", async (fixture, moment) => {
    await writeFile(path.join(inputPath(fixture, moment, "memory"), "memory/events.jsonl"), `${JSON.stringify(memoryEvent(3))}\n`);
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

const intendedFinding = (name: string, fixture: Fixture, moment: MaterializedMoment): { path: string; detail: string | RegExp } => {
  const relative = (kind: string) => moment.inputs.find((input) => input.kind === kind)!.path!;
  if (name.startsWith("future ") && /[am]time$/u.test(name)) return {
    path: name.includes("report") ? "moment.json" : name.includes("directory") ? "new-directory" : name.includes("symlink") ? "new-link" : "future",
    detail: `${name.endsWith("atime") ? "Access" : "Modification"} time is later than the moment`
  };
  const findings: Record<string, { path: string; detail: string | RegExp }> = {
    "extra unreachable future commit": { path: relative("git"), detail: `Object ${fixture.futureCommit} is not reachable from ${fixture.commit}` },
    "extra tag": { path: relative("git"), detail: "Exactly one branch and HEAD must name the materialized commit" },
    "extra remote": { path: relative("git"), detail: "Forbidden git configuration remote.leaked.url" },
    "reachable commit future author only": { path: relative("git"), detail: /^Commit [a-f0-9]+ has a future author date$/u },
    "reachable commit future committer only": { path: relative("git"), detail: /^Commit [a-f0-9]+ has a future committer date$/u },
    "future memory event": { path: relative("memory"), detail: "Future memory event at line 1" },
    "memory seq gap": { path: relative("memory"), detail: "Noncontiguous memory sequence at line 1" },
    "memory audit state": { path: relative("memory"), detail: "Unexpected payload entry index.sqlite" },
    "future Moltnet message": { path: `${relative("moltnet")}/state.json`, detail: "Message future is later than the moment" },
    "future Moltnet event": { path: `${relative("moltnet")}/state.json`, detail: "Attachment event future is later than the moment" },
    "future Moltnet room": { path: `${relative("moltnet")}/state.json`, detail: "Room future is later than the moment" },
    "escaping symlink": { path: "escape", detail: 'Unsafe symlink target "../outside"' },
    "absolute symlink": { path: "escape", detail: `Unsafe symlink target ${JSON.stringify(fixture.root)}` },
    "future dated path": { path: "edition-2026-10-11", detail: "Calendar date 2026-10-11 is later than the latest possible local date 2026-10-09" },
    "tampered snapshot": { path: relative("volume"), detail: "Snapshot digest mismatch for saved.txt" },
    "future feed landing": { path: relative("feed"), detail: "Feed landed_at is later than the moment" },
    "feed current outside its volume": { path: relative("feed"), detail: "Feed current does not point to its tree inside the volume" }
  };
  return findings[name]!;
};

describe("independent disk leak check mutation guarantees", () => {
  it.each(cases)("refuses %s with class %s", async (name, expectedClass, mutate) => {
    const fixture = await rewindFixture();
    const moment = await materializeTrainingMoment(fixture.options);
    expect(moment.status).toBe("materialized");
    await mutate(fixture, moment);
    const expected = intendedFinding(name, fixture, moment);
    // Restore every parent and unrelated entry; time mutations change only the intended field on the target.
    await stampTree(fixture.options.out, AT, AT);
    if (expectedClass === "file-time") {
      const target = path.join(fixture.options.out, expected.path);
      const setTimes = (await lstat(target)).isSymbolicLink() ? lutimes : utimes;
      await setTimes(target, new Date(name.endsWith("atime") ? FUTURE : AT), new Date(name.endsWith("mtime") ? FUTURE : AT));
    }
    const check = await leakCheckTrainingMoment(fixture.options.out, { historyDir: fixture.historyDir });
    expect(check.ok).toBe(false);
    expect(check.findings).toContainEqual(expect.objectContaining({ class: expectedClass, path: expected.path,
      detail: typeof expected.detail === "string" ? expected.detail : expect.stringMatching(expected.detail) }));
    if (expectedClass === "file-time") expect(check.findings.filter((finding) => finding.class === "file-time"))
      .toEqual([expect.objectContaining({ class: expectedClass, ...expected })]);
    const out = path.join(fixture.root, "rejected");
    const refused = await finalizeTrainingMoment(fixture.options.out, out, { historyDir: fixture.historyDir });
    expect(refused.status).toBe("refused");
    expect(refused.leakCheck.ok).toBe(false);
    expect(refused.inputs.every((input) => input.path === null)).toBe(true);
    expect(await readdir(out)).toEqual(["leak-check.json", "moment.json"]);
  });
});
