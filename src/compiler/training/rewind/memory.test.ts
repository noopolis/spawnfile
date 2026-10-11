import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHistory } from "./history.js";
import { materializeMemory, parseMemoryLedger, selectMemoryGeneration, selectMemoryPrefix } from "./memory.js";
import { AT, BEFORE, FUTURE, emptyRecord, jsonl, memoryEvent } from "./fixtures.test-helper.js";
import type { InputContext, RewindInput } from "./types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const setup = async (): Promise<InputContext> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rewind-memory-")); roots.push(root);
  const input: RewindInput = { section: "memory", id: "self", declaredBy: "agent:a", declarationBase: root,
    declaration: { id: "self", store: { kind: "memory" } }, overridden: false };
  return { input, at: AT, record: null, history: await openHistory(root), destination: path.join(root, "out") };
};
const base = "memory/agent%3Aa/self";
const ledger = (...events: unknown[]) => parseMemoryLedger(events.map((e) => JSON.stringify(e)).join("\n") + "\n");

describe("memory rewind", () => {
  it("cuts at the first future event and never filters a clock regression back into the bank", () => {
    const source = ledger(memoryEvent(1), memoryEvent(2, FUTURE), memoryEvent(3));
    expect(selectMemoryPrefix(source, AT).events.map((event) => event.seq)).toEqual([1]);
    expect(() => selectMemoryPrefix(source, AT, 3)).toThrow(/later than/);
  });
  it("refuses seq gaps, prefix time regressions, invalid framing, strict unknown fields and resumed legacy runs", () => {
    expect(() => selectMemoryPrefix(ledger(memoryEvent(2)), AT)).toThrow(/contiguous/);
    expect(() => selectMemoryPrefix(ledger(memoryEvent(1, AT), memoryEvent(2)), AT)).toThrow(/regresses/);
    expect(() => parseMemoryLedger(JSON.stringify(memoryEvent(1)))).toThrow(/LF/);
    expect(() => ledger({ ...memoryEvent(1), extra: true })).toThrow(/invalid Mneme event/);
    expect(() => selectMemoryPrefix(ledger(memoryEvent(1), { ...memoryEvent(2), seq: undefined }), AT)).toThrow(/leading run/);
    expect(selectMemoryPrefix(ledger({ ...memoryEvent(1), seq: undefined }, memoryEvent(2)), AT).events).toHaveLength(2);
  });
  it("rejects malformed JSON, invalid createdAt instants and duplicate JSON keys", () => {
    expect(() => parseMemoryLedger("{broken}\n")).toThrow(/memory\/events.jsonl:1: invalid Mneme event/);
    expect(() => ledger({ ...memoryEvent(1), createdAt: "not an instant" })).toThrow(/createdAt/);
    expect(() => parseMemoryLedger(`${JSON.stringify(memoryEvent(1))}\n\n`)).toThrow(/memory\/events.jsonl:2/);
    const payload = JSON.stringify(memoryEvent(1));
    for (const duplicate of [payload.replace('"seq":1', '"seq":2,"s\\u0065q":1'),
      payload.replace('"agentId":"a"', '"agentId":"b","agentId":"a"')]) {
      expect(() => parseMemoryLedger(`${duplicate}\n`)).toThrow(/duplicate JSON key/);
    }
  });
  it("materializes an exact record prefix without an index or a Mneme runtime dependency", async () => {
    const context = await setup();
    await jsonl(context.history!.root, `${base}/events.jsonl`, [memoryEvent(1), memoryEvent(2, AT)]);
    context.record = { ...emptyRecord(), memory: [{ id: "self", declaredBy: "agent:a", seq: 1, generation: 0 }] };
    const result = await materializeMemory(context);
    expect(result).toMatchObject({ fidelity: "exact", basis: "record", source: { seq: 1, generation: 0 } });
    expect(await readdir(path.join(context.destination, "memory"))).toEqual(["events.jsonl"]);
    expect(await readFile(path.join(context.destination, "memory/events.jsonl"), "utf8")).toBe(`${JSON.stringify(memoryEvent(1))}\n`);
    expect(result.notes.join(" ")).toContain("without a Mneme runtime dependency");
    expect(result.notes.join(" ")).toContain("Checksum verification is skipped");
  });
  it("includes the boundary and labels the timestamp prefix approximate", async () => {
    const context = await setup();
    await jsonl(context.history!.root, `${base}/events.jsonl`, [memoryEvent(1, AT), memoryEvent(2, FUTURE)]);
    expect(await materializeMemory(context)).toMatchObject({ fidelity: "approximate", basis: "created-at-prefix", source: { seq: 1 } });
  });
  it("selects an archived generation before a switch and refuses a missing archive", async () => {
    const context = await setup();
    await jsonl(context.history!.root, `${base}/generations.jsonl`, [
      { generation: 3, switchedAt: BEFORE, ledger: "archive/g3.jsonl" },
      { generation: 4, switchedAt: FUTURE, ledger: "events.jsonl" }
    ]);
    await jsonl(context.history!.root, `${base}/events.jsonl`, [memoryEvent(1, FUTURE)]);
    await expect(materializeMemory(context)).rejects.toThrow(/Missing memory ledger.*g3/);
    await jsonl(context.history!.root, `${base}/archive/g3.jsonl`, [memoryEvent(1)]);
    expect(await materializeMemory(context)).toMatchObject({ source: { generation: 3, seq: 1 } });
    expect(() => selectMemoryGeneration([{ generation: 4, switchedAt: FUTURE, ledger: "events.jsonl" }], AT)).toThrow(/archived ledger/);
    expect(() => selectMemoryGeneration(null, AT, 3)).toThrow(/disagrees/);
  });
  it("creates an empty override without history and refuses a missing non-overridden bank", async () => {
    const context = await setup();
    await expect(materializeMemory(context)).rejects.toThrow(/Missing memory ledger/);
    context.history = undefined;
    await expect(materializeMemory(context)).rejects.toThrow(/requires --history/);
    context.input.overridden = true;
    expect(await materializeMemory(context)).toMatchObject({ fidelity: "overridden", source: { seq: 0 } });
    expect(await readFile(path.join(context.destination, "memory/events.jsonl"), "utf8")).toBe("");
  });
  it("validates malformed suffix history even when the selected prefix would be empty", async () => {
    const context = await setup();
    await jsonl(context.history!.root, `${base}/events.jsonl`, [memoryEvent(1, FUTURE), { bad: true }]);
    await expect(materializeMemory(context)).rejects.toThrow(/events.jsonl:2/);
  });
});
