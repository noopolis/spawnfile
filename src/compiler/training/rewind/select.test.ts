import { describe, expect, it } from "vitest";
import type { TrainingPlan } from "../plan/index.js";
import type { MomentRecord } from "../../../recording/index.js";
import { selectMomentRecord, selectTrainingExample } from "./select.js";

const at = "2026-10-09T08:20:31Z";
const record = (): MomentRecord => ({
  version: "spawnfile.moment-record.v1", agent: "agent:writer",
  wake: { at, startedAt: at, executionId: "execution-17", deliveries: [{ deliveryId: "delivery-17", kind: "message", occurredAt: at }], surface: "moltnet", room: "assignment", from: "brass" }, recordedAt: at, exact: true,
  resources: [{ id: "repo", kind: "git", commit: "a".repeat(40) }],
  feeds: [{ id: "news", revision: "rev", tree: "tree", commit: "b".repeat(40), paths: ["published"], landedAt: at }],
  memory: [{ id: "self", declaredBy: "agent:writer", seq: 2, generation: 0 }],
  moltnet: [{ network: "network", cursor: at }], volumes: [{ id: "state", snapshot: "snapshot" }]
});
const dataset = (name: string, id: string) => ({ sourcePath: `/project/${name}.yaml`, path: `${name}.yaml`,
  examples: [{ id, at, wake: { surface: "moltnet" as const, room: "assignment", from: "brass", text: "write" }, overrides: [] }] });
const plan = (): TrainingPlan => ({
  version: "spawnfile.training-plan.v1", producer: { package: "spawnfile", version: "test" },
  project: { root: "/project", manifest: "/project/Spawnfile" }, agent: { id: "agent:writer", name: "writer" },
  record: null, optimizer: null, graders: [], targets: [{ declaredBy: "agent:writer", grader: "writing",
    files: [{ sourcePath: "/project/AGENTS.md", path: "AGENTS.md", consumers: ["agent:writer"] }],
    datasets: { train: dataset("train", "example"), validation: null, test: dataset("test", "held-out") }
  }]
});

describe("pure rewind record selection", () => {
  it("matches equal instants across offsets and ignores capture time and unused wake payload", () => {
    const first = record(), second = structuredClone(first);
    second.wake = { ...second.wake, at: "2026-10-09T10:20:31+02:00", room: "other", messageId: "later-capture" };
    second.recordedAt = "2026-10-11T00:00:00Z";
    second.feeds[0]!.landedAt = "2026-10-09T10:20:31.000000000+02:00";
    expect(selectMomentRecord([first, second], "agent:writer", "2026-10-09T03:20:31-05:00")).toBe(first);
  });

  it("requires exact agent and wake instant, including sub-millisecond differences", () => {
    expect(selectMomentRecord([record()], "writer", at)).toBeNull();
    expect(selectMomentRecord([record()], "agent:writer", "2026-10-09T08:20:31.000000001Z")).toBeNull();
    expect(selectMomentRecord([], "agent:writer", at)).toBeNull();
  });

  it.each([false, true])("refuses effective pin/fallback disagreements in either order (reverse=%s)", (reverse) => {
    for (const section of ["memory", "resources", "networks"] as const) {
      const id = section === "memory" ? "self" : section === "resources" ? "news" : "network";
      const first = record(), second = record();
      second.exact = false; second.errors = [`${section} ${id}: capture failed`];
      const copies = reverse ? [second, first] : [first, second];
      expect(() => selectMomentRecord(copies, "agent:writer", at, [{ section, id, declaredBy: "agent:writer" }]))
        .toThrow(new RegExp(`Conflicting moment records.*${section} agent:writer/${id}.*effective pin/fallback`, "u"));
    }
  });

  it.each([false, true])("compares fallback fidelity when exact differs (reverse=%s)", (reverse) => {
    const first = record(), second = record(); second.exact = false;
    const inputs = [{ section: "resources" as const, id: "absent-feed", declaredBy: "agent:writer" }];
    expect(() => selectMomentRecord(reverse ? [second, first] : [first, second], "agent:writer", at, inputs))
      .toThrow(/absent-feed.*effective pin\/fallback/u);
  });

  it("ignores unrelated errors and exact flags for healthy pins, and compares usable rather than errored pins", () => {
    const first = record(), second = record();
    second.exact = false; second.errors = ["volume unrelated: failed", "memory self (team:other): failed"];
    const inputs = [{ section: "memory" as const, id: "self", declaredBy: "agent:writer" }];
    expect(selectMomentRecord([first, second], "agent:writer", at, inputs)).toBe(first);
    first.exact = false; first.errors = ["memory self: failed"];
    second.errors = ["memory self: another failure"]; second.memory[0]!.seq = 99;
    expect(selectMomentRecord([first, second], "agent:writer", at, inputs)).toBe(first);
  });

  const changes: Array<[string, (value: MomentRecord) => void]> = [
    ["resource commit", (value) => { value.resources[0] = { id: "repo", kind: "git", commit: "c".repeat(40) }; }],
    ["feed revision", (value) => { value.feeds[0]!.revision = "different"; }],
    ["feed paths", (value) => { value.feeds[0]!.paths = ["private"]; }],
    ["memory sequence", (value) => { value.memory[0]!.seq = 3; }],
    ["memory generation", (value) => { value.memory[0]!.generation = 1; }],
    ["network cursor", (value) => { value.moltnet[0]!.cursor = "2026-10-10T00:00:00Z"; }],
    ["volume snapshot", (value) => { value.volumes[0]!.snapshot = "different"; }]
  ];
  it.each(changes)("refuses conflicting %s fields", (_name, change) => {
    const first = record(), second = structuredClone(first);
    change(second);
    expect(() => selectMomentRecord([first, second], "agent:writer", at)).toThrow(/Conflicting moment records.*agent:writer/u);
  });

  it("compares only inputs being used and retains memory declaring-node identity", () => {
    const first = record(), second = structuredClone(first);
    second.resources[0] = { id: "repo", kind: "git", commit: "c".repeat(40) };
    second.memory.push({ id: "self", declaredBy: "team:other", generation: 9, seq: 88 });
    const selected = [{ section: "memory" as const, id: "self", declaredBy: "agent:writer" }];
    expect(selectMomentRecord([first, second], "agent:writer", at, selected)).toBe(first);
    second.memory[0]!.seq = 3;
    expect(() => selectMomentRecord([first, second], "agent:writer", at, selected)).toThrow(/Conflicting/u);
  });

  it("accepts reordered record entries without mutating its inputs", () => {
    const first = record();
    first.resources.push({ id: "another", kind: "bundle", sha256: `sha256:${"d".repeat(64)}` });
    const second = structuredClone(first);
    second.resources.reverse();
    const before = structuredClone([first, second]);
    expect(selectMomentRecord([first, second], "agent:writer", at)).toBe(first);
    expect([first, second]).toEqual(before);
  });

  it("refuses conflicting bundle digests even when the declared source has a full commit pin", () => {
    const first = record(), second = record();
    first.resources = [{ id: "tools", kind: "bundle", sha256: `sha256:${"a".repeat(64)}` }];
    second.resources = [{ id: "tools", kind: "bundle", sha256: `sha256:${"b".repeat(64)}` }];
    expect(() => selectMomentRecord([first, second], "agent:writer", at, [{
      section: "resources", id: "tools", declaredBy: "agent:writer", overridden: false, declarationBase: "/project",
      declaration: { id: "tools", kind: "bundle", mode: "readonly", mount: "./tools", build: { files: { root: ".", ref: "c".repeat(40) } } }
    }])).toThrow("Conflicting moment records");
  });

  it("does not compare record fields superseded by a full commit pin or another resource kind", () => {
    const first = record(), second = structuredClone(first);
    second.resources[0] = { id: "repo", kind: "git", commit: "c".repeat(40) };
    second.feeds[0]!.revision = "other";
    expect(selectMomentRecord([first, second], "agent:writer", at, [{
      section: "resources", id: "repo", declaredBy: "agent:writer", overridden: false, declarationBase: "/project",
      declaration: { id: "repo", kind: "git", mode: "readonly", mount: "./repo", url: "/repo", ref: "a".repeat(40) }
    }, {
      section: "resources", id: "news", declaredBy: "agent:writer", overridden: false, declarationBase: "/project",
      declaration: { id: "news", kind: "volume", mode: "mutable", mount: "./news" }
    }])).toBe(first);
  });
});

describe("pure rewind example selection", () => {
  it.each(["example", "train:example"])("selects %s and deduplicates repeated target references", (selector) => {
    const source = plan();
    source.targets.push(structuredClone(source.targets[0]!));
    const before = structuredClone(source);
    expect(selectTrainingExample(source, selector)).toMatchObject({ id: "example", role: "train", dataset: "train.yaml" });
    expect(source).toEqual(before);
  });

  it("lists ambiguous roles and permits an exact role qualifier", () => {
    const source = plan();
    source.targets[0]!.datasets.test = dataset("test", "example");
    expect(() => selectTrainingExample(source, "example")).toThrow(
      "Ambiguous training example example; candidates: test:example (test.yaml), train:example (train.yaml)"
    );
    expect(selectTrainingExample(source, "test:example").dataset).toBe("test.yaml");
  });

  it("still refuses a qualified id shared by distinct datasets and lists both candidates", () => {
    const source = plan(), other = structuredClone(source.targets[0]!);
    other.datasets.train = dataset("another-train", "example");
    source.targets.push(other);
    expect(() => selectTrainingExample(source, "train:example")).toThrow(
      "candidates: train:example (another-train.yaml), train:example (train.yaml)"
    );
  });

  it.each(["missing", "validation:example", "train:", "other:example"])("refuses unknown selector %s", (selector) => {
    expect(() => selectTrainingExample(plan(), selector)).toThrow(`No training example matches ${selector}`);
  });
});
