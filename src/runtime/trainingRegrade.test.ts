import { mkdtemp, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testBankYaml, testJudge, testMaterial, testReplies } from "../training/questionnaire/index.js";
import { regradeTraining } from "./trainingRegrade.js";

import { runCli } from "../cli/runCli.js";
import { contentDigest, openExperimentStore, readTrialEval, runStoredTrial, snapshotCandidate, storedJsonDigest } from "../training/index.js";
import { complete, setup } from "../training/experiments/trials/fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const project = async (outputs: unknown[] = [{ id: "a", candidate: "baseline", case: "c", output: "article.json", context: { evidence: "evidence.json", assignment: "assignment.txt" } }]) => {
  const root = await mkdtemp(path.join(tmpdir(), "regrade-"));
  roots.push(root);
  await mkdir(path.join(root, "in"));
  const file = (name: string, text: string) => writeFile(path.join(root, "in", name), text);
  await file("bank.yaml", testBankYaml);
  await file("article.json", JSON.stringify(testMaterial.output));
  await file("evidence.json", JSON.stringify(testMaterial.context.evidence));
  await file("assignment.txt", testMaterial.context.assignment);
  await writeFile(path.join(root, "outside.json"), "{}");
  await file("regrade.json", JSON.stringify({ schema: "spawnfile.training.regrade.v1",
    check: { id: "house", eval: "questionnaire", bank: "bank.yaml", input: "artifact:output", context: { evidence: "context:evidence", assignment: "context:assignment" } },
    judges: { strong: { provider: "codex-subscription", model: "m", reasoning_effort: "medium" } }, outputs }));
  return { root, manifest: path.join(root, "in", "regrade.json"), out: path.join(root, "out") };
};
const streams = () => { const lines: string[] = []; return { lines, stdout: (line: string) => { lines.push(line); }, stderr: (line: string) => { lines.push(line); } }; };

describe("training regrade", () => {
  it("writes one result per output and the report, then resumes without asking again", async () => {
    const { manifest, out } = await project();
    const judge = testJudge([testReplies[0], testReplies[1]]);
    const io = streams();
    expect(await regradeTraining({ manifest, out, streams: io, provider: () => judge.provider })).toBe(0);
    expect(JSON.parse(await readFile(path.join(out, "results", "a.json"), "utf8"))).toMatchObject({ id: "a", status: "pass", score: 0.6875 });
    expect(JSON.parse(await readFile(path.join(out, "REGRADE.json"), "utf8"))).toMatchObject({ judgeCalls: 2, candidates: { baseline: { score: 0.6875, scoreHidden: 0.75 } } });
    const markdown = await readFile(path.join(out, "REGRADE.md"), "utf8");
    expect(markdown).toContain("| baseline | 1 | 0 | 1 | 0 | 0 | 0.688 | 0.667 | 0.750 | -0.083 |");
    expect(markdown).toContain("no subject trial ran");
    expect(io.lines.at(-1)).toContain('"judgeCalls":2');
    const again = testJudge([]);
    await writeFile(path.join(out, "results", "notes.txt"), "ignored");
    expect(await regradeTraining({ manifest, out, streams: streams(), provider: () => again.provider })).toBe(0);
    expect(again.prompts).toHaveLength(0);
  });
  it("exits nonzero and asks again when a judge did not answer", async () => {
    const { manifest, out } = await project();
    expect(await regradeTraining({ manifest, out, streams: streams(), provider: () => testJudge([new Error("down"), testReplies[1]]).provider })).toBe(1);
    const retry = testJudge([testReplies[0], testReplies[1]]);
    expect(await regradeTraining({ manifest, out, streams: streams(), provider: () => retry.provider })).toBe(0);
    expect(retry.prompts).toHaveLength(2);
  });
  it("renders calibration and refuses a failing calibration set", async () => {
    const { root, manifest, out } = await project([
      { id: "base", candidate: "baseline", case: "c", output: "article.json", context: { evidence: "evidence.json", assignment: "assignment.txt" } },
      { id: "variant", candidate: "calibration", case: "c", output: "article.json", calibration: true, context: { evidence: "evidence.json", assignment: "assignment.txt" } }]);
    await writeFile(path.join(root, "in", "expect.json"), JSON.stringify([{ id: "variant", base: "base", defect: "figure", targets: ["figures"], gate_must_fail: true }]));
    const raw = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
    await writeFile(manifest, JSON.stringify({ ...raw, calibration: "expect.json" }));
    const judge = testJudge([testReplies[0], testReplies[1], testReplies[0], testReplies[1]]);
    expect(await regradeTraining({ manifest, out, streams: streams(), provider: () => judge.provider })).toBe(1);
    expect(await readFile(path.join(out, "REGRADE.md"), "utf8")).toContain("Verdict: **fail**. Defects caught 0 of 1; required gates failed 0 of 1; clean bases failing 0 of 1; clean false alarms 0.\n\n- figure: MISSED, gate pass to pass; figures \"yes\" to \"yes\"");
  });
  it("reviews recorded candidate prompts, keeps each review and asks again only for a failed one", async () => {
    const { root, manifest, out } = await project([]);
    for (const [name, text] of Object.entries({ "base.md": "Report the rows.\n", "one.md": "Report the rows.\nWrite 200 to 400 words.\n", "WRITING.md": "Length follows the facts.", "case.txt": "AfD nominated Tobias Rausch." })) {
      await writeFile(path.join(root, "in", name), text);
    }
    const raw = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
    await writeFile(manifest, JSON.stringify({ ...raw, critic: { judge: "strong", guide: ["WRITING.md"], train_cases: [{ id: "landtag", file: "case.txt" }], baseline: { "AGENTS.md": "base.md" }, candidates: { "candidate-1": { "AGENTS.md": "one.md" } } } }));
    expect(await regradeTraining({ manifest, out, streams: streams(), provider: () => testJudge(["not json"]).provider })).toBe(1);
    const block = { summary: "quota", findings: [{ category: "check_only_rule", quoted_line: "Write 200 to 400 words.", guide_ref: "", why: "No guide basis.", severity: "high", case: "landtag" },
      { category: "case_specific", quoted_line: "Invented line.", guide_ref: "", why: "x", severity: "low" }] };
    const judge = testJudge([block]);
    expect(await regradeTraining({ manifest, out, streams: streams(), provider: () => judge.provider })).toBe(0);
    expect(judge.prompts).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(out, "critic", "candidate-1.json"), "utf8"))).toMatchObject({ verdict: "block" });
    const markdown = await readFile(path.join(out, "REGRADE.md"), "utf8");
    expect(markdown).toContain("## Prompt critic: candidate-1\n\nVerdict: **block** (blocks on high). quota");
    expect(markdown).toContain('- check_only_rule, high, case landtag: "Write 200 to 400 words.". No guide basis.');
    expect(markdown).toContain('- case_specific, low, quote not found in the prompt: "Invented line.". x');
    const again = testJudge([]);
    await writeFile(path.join(out, "critic", "notes.txt"), "ignored");
    expect(await regradeTraining({ manifest, out, streams: streams(), provider: () => again.provider })).toBe(0);
    expect(again.prompts).toHaveLength(0);
  });
  it("refuses a missing or invalid manifest, an unknown provider and an input outside the manifest directory", async () => {
    const { root, manifest, out } = await project();
    await expect(regradeTraining({ manifest: path.join(root, "none.json"), out, streams: streams() })).rejects.toThrow(/does not exist/u);
    const raw = JSON.parse(await readFile(manifest, "utf8")) as { judges: { strong: { provider: string } }; outputs: { output: string }[]; schema: string };
    await writeFile(manifest, JSON.stringify({ ...raw, schema: "other" }));
    await expect(regradeTraining({ manifest, out, streams: streams() })).rejects.toThrow(/Regrade manifest: schema/u);
    await writeFile(manifest, JSON.stringify({ ...raw, judges: { strong: { provider: "nobody", model: "m" } } }));
    await expect(regradeTraining({ manifest, out, streams: streams() })).rejects.toThrow();
    await writeFile(manifest, JSON.stringify({ ...raw, outputs: [{ ...raw.outputs[0], output: "gone.json" }] }));
    await expect(regradeTraining({ manifest, out, streams: streams(), provider: () => testJudge([]).provider })).rejects.toThrow(/does not exist: gone.json/u);
  });
});

it('moves a private multi-turn eval out of the store and regrades its trace offline', async () => {
  const task = await setup(async (subject, turn) => {
    await writeFile(path.join(subject.workspacePath, 'file.txt'), turn.text);
    await writeFile(path.join(subject.runtimeHomePath, 'credentials.json'), 'PRIVATE-CREDENTIAL');
    await subject.onObservation({ id: turn.id, trialId: subject.trialId, wakeId: turn.id, source: turn.id,
      seq: 1, timestamp: '2026-01-01T00:00:00Z', type: 'tool.dispatch', tool: 'file', callId: turn.id,
      args: { path: 'file.txt' }, native: { transcript: 'PRIVATE-TRANSCRIPT' } });
    await subject.onObservation({ id: turn.id + '-log', trialId: subject.trialId, wakeId: turn.id, source: turn.id,
      seq: 2, timestamp: '2026-01-01T00:00:00Z', type: 'diagnostic', text: 'PRIVATE-DIAGNOSTIC' });
    return complete;
  });
  const root = task.options.root;
  await writeFile(path.join(root, 'instructions'), 'Write a file');
  const candidate = await snapshotCandidate({ sourceRoot: root, resources: [{ id: 'instructions', sourcePath: 'instructions',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'locked' }] });
  const storeRoot = path.join(root, 'out');
  const record = task.options.record;
  delete record.input;
  record.outputs = { article: 'file.txt' };
  record.turns = ['first', 'second'].map(id => ({ id, input: { prompt: id }, checks: [{ id: 'text', eval: 'equals', input: 'output.text', value: 'DONE' }] }));
  await writeFile(path.join(root, 'brief.txt'), 'original input bytes');
  record.turns[0]!.input.files = [{ resource: 'packet', path: 'brief.txt', sha256: contentDigest('original input bytes') }];
  record.effectiveStages = [{ id: 'terminal', checks: [{ id: 'filed', eval: 'tool-count', tool: 'file', phase: 'dispatch', exactly: 2 },
    { id: 'words', eval: 'word-count', input: 'output.text', min: 1 },
    { id: 'shape', eval: 'json-schema', input: 'output.text', schema: 'shape.json' }] }];
  task.options.evaluation.readText = async name => {
    expect(name).toBe('shape.json');
    return '{"type":"string"}';
  };
  const report = await runStoredTrial({ ...task.options, record, resources: { packet: root }, storeRoot, root: path.join(storeRoot, 'trials'),
    store: await openExperimentStore(storeRoot), candidate, datasetId: 'suite' });
  expect(report.status).toBe('pass');
  const file = path.join(storeRoot, 'evals', 'trial.eval');
  expect(report.evalFile).toBe('evals/trial.eval');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const moved = path.join(root, 'moved.eval');
  await rename(file, moved);
  await rm(path.join(root, 'brief.txt'));
  await rm(storeRoot, { recursive: true });
  const bytes = await readFile(moved, 'utf8');
  expect(bytes).not.toMatch(/PRIVATE-|credentials\.json/);
  const envelope = JSON.parse(bytes);
  expect(envelope.payload.inputs).toEqual([{ id: 'first', input: 'first\n\nInput files:\ninputs/packet/brief.txt' }, { id: 'second', input: 'second' }]);
  const frozen = await readTrialEval(moved);
  expect(frozen.report.snapshot.inputFiles).toEqual({ 'inputs/packet/brief.txt': 'original input bytes' });
  expect(frozen.task.turns).toEqual(record.turns);
  expect(frozen.report.snapshot.artifacts.article.bytes).toBe('second');
  expect(frozen.report.turns.map(turn => turn.native.text)).toEqual(['DONE', 'DONE']);
  expect(frozen.report.evaluation.checks.words?.mechanicalEvidence).toEqual({ count: 1 });
  expect(frozen.report.turns.map(turn => turn.checks[0]?.status)).toEqual(['pass', 'pass']);
  const out = path.join(root, 'graded');
  const stderr: string[] = [];
  const run = () => runCli(['train', '--regrade', moved, '--out', out], {
    streams: { stdout() {}, stderr: line => stderr.push(line) } });
  expect(await run(), stderr.join('\n')).toBe(0);
  expect(JSON.parse(await readFile(path.join(out, 'REGRADE.json'), 'utf8'))).toMatchObject({
    scope: 'final-stages', status: 'pass', evaluation: { checks: { filed: { status: 'pass' } } } });
  envelope.payload.report.snapshot.artifacts.article.bytes = 'tampered';
  await writeFile(moved, JSON.stringify(envelope));
  expect(await run()).not.toBe(0);
  expect(stderr.join('\n')).toMatch(/digest|integrity/i);
  envelope.digest = storedJsonDigest(envelope.payload);
  await writeFile(moved, JSON.stringify(envelope));
  await expect(readTrialEval(moved)).rejects.toThrow('artifact digest mismatch');
});
