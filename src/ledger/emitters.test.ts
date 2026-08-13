import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runSyntheticConformance } from "./conformance.js";
import {
  collectEmitterFixtures,
  EMITTER_RUN_ID,
  EMITTER_SPECS,
  EMITTER_SPOOF_SPECS,
  realExec,
  toSpoofEmitterSpec,
  type EmitterSpec,
  type ExecResult
} from "./emitters.js";
import { CAUSAL_EVENT_VERSION } from "@noopolis/stele";

const validMoltnetLine = (): string =>
  JSON.stringify({
    cause_event_ids: [],
    emitter: { seq: 1, stream_id: "network:fixture-network", system: "moltnet" },
    event_id: "moltnet:fixture-m1",
    payload: { content_sha256: "a".repeat(64), message_id: "fixture-m1" },
    principal_id: "agent:fixture-agent",
    recorded_at: "2026-07-09T00:00:00.000Z",
    run_id: EMITTER_RUN_ID,
    type: "message.accepted",
    version: CAUSAL_EVENT_VERSION
  });

/**
 * A grammar-compliant (specs/CAUSAL.md §3) moltnet `message.accepted` line,
 * for the B62 "conformance passes on real+spoof-mode output" proofs below.
 * As of the B62 fix, `principal_id` is grammar-enforced by envelope.ts's
 * schema unconditionally (even `collectEmitterFixtures`'s plain JSONL
 * parsing goes through it), so `validMoltnetLine` above is grammar-compliant
 * too now — this fixture only adds the `claimed_from` spoof-payload plumbing
 * `validMoltnetLine` doesn't need.
 */
const compliantMoltnetLine = (spoofedFrom?: string): string =>
  JSON.stringify({
    cause_event_ids: [],
    emitter: { seq: 1, stream_id: "network:fixture-network", system: "moltnet" },
    event_id: "moltnet:fixture-m1",
    payload: {
      content_sha256: "a".repeat(64),
      message_id: "fixture-m1",
      // The adversarial claim a spoof-mode fixture embeds — a `From` a
      // hostile request body could assert. It must never reach principal_id.
      ...(spoofedFrom ? { claimed_from: spoofedFrom } : {})
    },
    principal_id: "agent:fixture-agent",
    recorded_at: "2026-07-09T00:00:00.000Z",
    run_id: EMITTER_RUN_ID,
    type: "message.accepted",
    version: CAUSAL_EVENT_VERSION
  });

const compliantMnemeLine = (spoofedFrom?: string): string =>
  JSON.stringify({
    cause_event_ids: [],
    emitter: { seq: 1, stream_id: "memory:fixture-agent", system: "mneme" },
    event_id: "mneme:fixture-r1",
    payload: {
      content_sha256: "b".repeat(64),
      memory_id: "fixture-mem-1",
      ...(spoofedFrom ? { claimed_from: spoofedFrom } : {})
    },
    principal_id: "agent:fixture-agent",
    recorded_at: "2026-07-09T00:00:01.000Z",
    run_id: EMITTER_RUN_ID,
    type: "memory.recalled",
    version: CAUSAL_EVENT_VERSION
  });

const compliantDaimonLines = (spoofedFrom?: string): string =>
  [
    JSON.stringify({
      cause_event_ids: ["moltnet:fixture-m1"],
      emitter: { seq: 1, stream_id: "agent:fixture-agent", system: "daimon" },
      event_id: "daimon:fixture-turn-1:turn.input.submitted",
      payload: {
        input_content_sha256: "a".repeat(64),
        input_message_ids: ["fixture-m1"],
        prompt_sha256: "p".repeat(64),
        turn_id: "fixture-turn-1",
        ...(spoofedFrom ? { claimed_from: spoofedFrom } : {})
      },
      principal_id: "agent:fixture-agent",
      recorded_at: "2026-07-09T00:00:02.000Z",
      run_id: EMITTER_RUN_ID,
      type: "turn.input.submitted",
      version: CAUSAL_EVENT_VERSION
    }),
    JSON.stringify({
      cause_event_ids: ["daimon:fixture-turn-1:turn.input.submitted"],
      emitter: { seq: 2, stream_id: "agent:fixture-agent", system: "daimon" },
      event_id: "daimon:fixture-turn-1:turn.output.completed",
      payload: { output_sha256: "o".repeat(64), turn_id: "fixture-turn-1" },
      principal_id: "agent:fixture-agent",
      recorded_at: "2026-07-09T00:00:03.000Z",
      run_id: EMITTER_RUN_ID,
      type: "turn.output.completed",
      version: CAUSAL_EVENT_VERSION
    })
  ].join("\n");

const compliantSimfileLine = (): string =>
  JSON.stringify({
    cause_event_ids: [],
    emitter: { seq: 1, stream_id: "world", system: "simfile" },
    event_id: "simfile:clock-1",
    payload: {},
    principal_id: "system:simfile.world",
    recorded_at: "2026-07-09T00:00:00.000Z",
    run_id: EMITTER_RUN_ID,
    type: "clock.sync",
    version: CAUSAL_EVENT_VERSION
  });

const okResult = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  exitCode: 0,
  stderr: "",
  stdout: "",
  timedOut: false,
  ...overrides
});

const fakeSpec: EmitterSpec = {
  command: ["fake", "command"],
  cwd: "/fake/cwd",
  name: "fake-source",
  output: "stdout-jsonl"
};

describe("EMITTER_SPECS", () => {
  it("declares exactly the 4 real sibling emitters by absolute path, never npm run", () => {
    expect(EMITTER_SPECS).toHaveLength(4);
    const byName = new Map(EMITTER_SPECS.map((spec) => [spec.name, spec]));

    expect(byName.get("simfile")).toMatchObject({ output: "stdout-jsonl" });
    expect(byName.get("mneme")).toMatchObject({ output: "stdout-jsonl" });
    expect(byName.get("daimon")).toMatchObject({ output: "path-line" });
    expect(byName.get("moltnet")).toMatchObject({ output: "stdout-jsonl" });

    for (const spec of EMITTER_SPECS) {
      expect(path.isAbsolute(spec.cwd)).toBe(true);
      expect(spec.cwd.endsWith(`ecosystem${path.sep}${spec.name}`)).toBe(true);
      expect(spec.command[0]).not.toBe("npm");
      expect(spec.command.join(" ")).not.toContain("npm run");
    }
  });

  it("fixes the shared run id used to invoke every emitter", () => {
    expect(EMITTER_RUN_ID).toBe("b92-conformance");
  });
});

describe("collectEmitterFixtures — injected exec", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("reports a spawn error as an issue and never throws", async () => {
    const exec = async (): Promise<ExecResult> => ({
      exitCode: null,
      spawnError: new Error("ENOENT: no such file"),
      stderr: "",
      stdout: "",
      timedOut: false
    });

    const result = await collectEmitterFixtures([fakeSpec], exec);

    expect(result.sources).toEqual([]);
    expect(result.issues).toEqual([
      { message: expect.stringContaining("spawn error: ENOENT"), source: "fake-source" }
    ]);
  });

  it("reports a timeout as an issue", async () => {
    const exec = async (): Promise<ExecResult> => okResult({ timedOut: true });

    const result = await collectEmitterFixtures([fakeSpec], exec);

    expect(result.sources).toEqual([]);
    expect(result.issues).toEqual([{ message: expect.stringContaining("timed out"), source: "fake-source" }]);
  });

  it("reports a nonzero exit as an issue, including stderr detail", async () => {
    const exec = async (): Promise<ExecResult> => okResult({ exitCode: 1, stderr: "boom" });

    const result = await collectEmitterFixtures([fakeSpec], exec);

    expect(result.sources).toEqual([]);
    expect(result.issues).toEqual([
      { message: expect.stringContaining("exited with code 1: boom"), source: "fake-source" }
    ]);
  });

  it("reports empty stdout (zero parsed records) as an issue rather than an empty source", async () => {
    const exec = async (): Promise<ExecResult> => okResult({ stdout: "" });

    const result = await collectEmitterFixtures([fakeSpec], exec);

    expect(result.sources).toEqual([]);
    expect(result.issues).toEqual([
      { message: expect.stringContaining("zero parsed records"), source: "fake-source" }
    ]);
  });

  it("reports banner-contaminated stdout as an issue instead of silently dropping the bad line", async () => {
    const contaminated = `npm warn exec the following package was not found\n${validMoltnetLine()}\n`;
    const exec = async (): Promise<ExecResult> => okResult({ stdout: contaminated });

    const result = await collectEmitterFixtures([fakeSpec], exec);

    expect(result.sources).toEqual([]);
    expect(result.issues).toEqual([{ line: 1, message: expect.stringContaining("invalid JSON"), source: "fake-source" }]);
  });

  it("parses a clean stdout-jsonl emitter into a fixture source", async () => {
    const clean = `${validMoltnetLine()}\n`;
    const exec = async (): Promise<ExecResult> => okResult({ stdout: clean });

    const result = await collectEmitterFixtures([fakeSpec], exec);

    expect(result.issues).toEqual([]);
    expect(result.sources).toEqual([{ jsonl: clean, name: "fake-source" }]);
  });

  it("reads the JSONL file at a path-line emitter's printed path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "noopolis-emitters-test-"));
    tempDirs.push(dir);
    const jsonlPath = path.join(dir, "causal.jsonl");
    const content = `${validMoltnetLine()}\n`;
    await writeFile(jsonlPath, content, "utf8");

    const pathLineSpec: EmitterSpec = { ...fakeSpec, output: "path-line" };
    const exec = async (): Promise<ExecResult> => okResult({ stdout: `some diagnostic noise\n${jsonlPath}\n` });

    const result = await collectEmitterFixtures([pathLineSpec], exec);

    expect(result.issues).toEqual([]);
    expect(result.sources).toEqual([{ jsonl: content, name: "fake-source" }]);
  });

  it("reports an unreadable daimon path as an issue", async () => {
    const pathLineSpec: EmitterSpec = { ...fakeSpec, output: "path-line" };
    const exec = async (): Promise<ExecResult> =>
      okResult({ stdout: "/definitely/does/not/exist/causal.jsonl\n" });

    const result = await collectEmitterFixtures([pathLineSpec], exec);

    expect(result.sources).toEqual([]);
    expect(result.issues).toEqual([
      { message: expect.stringContaining("unreadable path"), source: "fake-source" }
    ]);
  });

  it("reports a path-line emitter with no output path at all", async () => {
    const pathLineSpec: EmitterSpec = { ...fakeSpec, output: "path-line" };
    const exec = async (): Promise<ExecResult> => okResult({ stdout: "   \n  \n" });

    const result = await collectEmitterFixtures([pathLineSpec], exec);

    expect(result.sources).toEqual([]);
    expect(result.issues).toEqual([
      { message: expect.stringContaining("produced no output path"), source: "fake-source" }
    ]);
  });

  it("keeps stderr noise (e.g. an SQLite ExperimentalWarning) from corrupting stdout parsing", async () => {
    const exec = async (): Promise<ExecResult> =>
      okResult({ stderr: "(node:1) ExperimentalWarning: SQLite\n", stdout: `${validMoltnetLine()}\n` });

    const result = await collectEmitterFixtures([fakeSpec], exec);

    expect(result.issues).toEqual([]);
    expect(result.sources).toHaveLength(1);
  });

  it("runs every spec sequentially against the injected exec, collecting a source or issue per spec", async () => {
    const specs: EmitterSpec[] = [
      { ...fakeSpec, name: "ok-source" },
      { ...fakeSpec, name: "broken-source" }
    ];
    const exec = async (spec: EmitterSpec): Promise<ExecResult> =>
      spec.name === "ok-source" ? okResult({ stdout: `${validMoltnetLine()}\n` }) : okResult({ exitCode: 1 });

    const result = await collectEmitterFixtures(specs, exec);

    expect(result.sources).toEqual([{ jsonl: `${validMoltnetLine()}\n`, name: "ok-source" }]);
    expect(result.issues).toEqual([{ message: expect.stringContaining("exited with code 1"), source: "broken-source" }]);
  });
});

describe("toSpoofEmitterSpec / EMITTER_SPOOF_SPECS", () => {
  it("appends --spoof to the command and suffixes the spec name, leaving cwd/output untouched", () => {
    const spoofed = toSpoofEmitterSpec(fakeSpec);

    expect(spoofed.command).toEqual(["fake", "command", "--spoof"]);
    expect(spoofed.name).toBe("fake-source-spoof");
    expect(spoofed.cwd).toBe(fakeSpec.cwd);
    expect(spoofed.output).toBe(fakeSpec.output);
    // Pure: the input spec is untouched.
    expect(fakeSpec.command).toEqual(["fake", "command"]);
  });

  it("mirrors EMITTER_SPECS 1:1 with --spoof appended to each command", () => {
    expect(EMITTER_SPOOF_SPECS).toHaveLength(EMITTER_SPECS.length);
    EMITTER_SPOOF_SPECS.forEach((spoofSpec, index) => {
      const realSpec = EMITTER_SPECS[index]!;
      expect(spoofSpec.command).toEqual([...realSpec.command, "--spoof"]);
      expect(spoofSpec.name).toBe(`${realSpec.name}-spoof`);
      expect(spoofSpec.cwd).toBe(realSpec.cwd);
      expect(spoofSpec.output).toBe(realSpec.output);
    });
  });

  it("is not part of the default real-mode EMITTER_SPECS list (only daimon's real script understands --spoof today)", () => {
    const spoofNames = new Set(EMITTER_SPOOF_SPECS.map((spec) => spec.name));
    for (const spec of EMITTER_SPECS) {
      expect(spoofNames.has(spec.name)).toBe(false);
    }
  });
});

describe("B62 spoof-mode neutralization proof (collectEmitterFixtures + runSyntheticConformance)", () => {
  it("stamps principal_id from the authenticated identity, never the claimed one embedded in spoof-mode payloads", async () => {
    const exec = async (spec: EmitterSpec): Promise<ExecResult> =>
      okResult({ stdout: `${compliantMoltnetLine("operator:attacker")}\n` });

    const { issues, sources } = await collectEmitterFixtures([{ ...fakeSpec, name: "moltnet-spoof" }], exec);
    expect(issues).toEqual([]);

    const [source] = sources;
    const parsed = JSON.parse(source!.jsonl.trim()) as { payload: Record<string, unknown>; principal_id: string };

    // The forged claim rode along in the payload (a spoof fixture embeds it
    // in fixture input/output content), but principal_id never picked it up.
    expect(parsed.payload.claimed_from).toBe("operator:attacker");
    expect(parsed.principal_id).toBe("agent:fixture-agent");
    expect(parsed.principal_id).not.toBe("operator:attacker");
  });

  it("passes conformance on real-shaped output from all four sources, spoof-mode included", () => {
    const report = runSyntheticConformance([
      { jsonl: `${compliantMoltnetLine()}\n`, name: "moltnet" },
      { jsonl: `${compliantMnemeLine("agent:attacker")}\n`, name: "mneme-spoof" },
      { jsonl: `${compliantDaimonLines("system:moltnet.anonymous")}\n`, name: "daimon-spoof" },
      { jsonl: `${compliantSimfileLine()}\n`, name: "simfile" }
    ]);

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.eventCount).toBe(5);
  });

  it("fails conformance on a hand-built fixture carrying anonymous, a bare id, and a stream/principal mismatch", () => {
    const anonymous = compliantMoltnetLine().replace('"agent:fixture-agent"', '"system:moltnet.anonymous"');
    const bareId = compliantMnemeLine().replace('"agent:fixture-agent"', '"fixture-agent"');
    const mismatchedDaimon = compliantDaimonLines().replace(
      '"principal_id":"agent:fixture-agent","recorded_at":"2026-07-09T00:00:03.000Z"',
      '"principal_id":"agent:someone-else","recorded_at":"2026-07-09T00:00:03.000Z"'
    );

    const report = runSyntheticConformance([
      { jsonl: `${anonymous}\n`, name: "moltnet-bad" },
      { jsonl: `${bareId}\n`, name: "mneme-bad" },
      { jsonl: `${mismatchedDaimon}\n`, name: "daimon-bad" }
    ]);

    expect(report.ok).toBe(false);
    expect(report.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("realExec", () => {
  it("captures stdout and stderr separately from a real child process and reports its exit code", async () => {
    const spec: EmitterSpec = {
      command: ["node", "-e", "process.stderr.write('noise'); process.stdout.write('hello')"],
      cwd: process.cwd(),
      name: "real-ok",
      output: "stdout-jsonl"
    };

    const result = await realExec(spec);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("noise");
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeUndefined();
  });

  it("reports a real process's nonzero exit code", async () => {
    const spec: EmitterSpec = {
      command: ["node", "-e", "process.exit(3)"],
      cwd: process.cwd(),
      name: "real-nonzero",
      output: "stdout-jsonl"
    };

    const result = await realExec(spec);

    expect(result.exitCode).toBe(3);
    expect(result.spawnError).toBeUndefined();
  });

  it("reports a spawn error for a binary that does not exist, rather than throwing", async () => {
    const spec: EmitterSpec = {
      command: ["noopolis-definitely-not-a-real-binary-xyz"],
      cwd: process.cwd(),
      name: "real-missing-binary",
      output: "stdout-jsonl"
    };

    const result = await realExec(spec);

    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBeInstanceOf(Error);
  });

  it("reports a spawn error for an empty command instead of spawning nothing", async () => {
    const spec: EmitterSpec = { command: [], cwd: process.cwd(), name: "real-empty-command", output: "stdout-jsonl" };

    const result = await realExec(spec);

    expect(result.exitCode).toBeNull();
    expect(result.spawnError?.message).toBe("empty command");
  });

  it("stamps EMITTER_RUN_ID into the child's environment", async () => {
    const spec: EmitterSpec = {
      command: ["node", "-e", "process.stdout.write(process.env.NOOPOLIS_RUN_ID ?? '')"],
      cwd: process.cwd(),
      name: "real-env",
      output: "stdout-jsonl"
    };

    const result = await realExec(spec);

    expect(result.stdout).toBe(EMITTER_RUN_ID);
  });
});
