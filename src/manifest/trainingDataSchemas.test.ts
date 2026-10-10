import { describe, expect, it } from "vitest";

import { trainingDatasetSchema, trainingGraderSchema } from "./trainingDataSchemas.js";

const example = {
  id: "ice-shooting.v1",
  at: "2026-10-09T10:20:31+02:00",
  wake: { surface: "moltnet", room: "assignment", from: "brass", text: "@tinkerton ..." }
};
const question = { id: "actor-first", ask: "Is the actor named first?", expected: "yes" };
const label = { id: "ice-headline", output: "labels/ice-headline.json", answers: { "actor-first": "no" } };
const resource = { id: "repo", kind: "git", url: "https://example.test/repo.git", mount: "./repo", mode: "readonly" };
const memory = { id: "self", store: { kind: "memory" } };
const network = { id: "news", provider: "moltnet", rooms: [{ id: "assignment", members: ["writer"] }] };

describe("training datasets", () => {
  it("accepts full declarations using the existing override sections", () => {
    const data = { examples: [{ ...example, resources: [resource], memory: [memory], networks: [network] }] };
    expect(trainingDatasetSchema.parse(data)).toEqual(data);
    expect(trainingDatasetSchema.parse({ examples: [example] })).toEqual({ examples: [example] });
  });

  it.each(["2026-10-09T10:20:31Z", "2026-10-09T10:20:31+02:00", "2026-10-09T10:20:31.123-05:30"])(
    "accepts ISO instant %s", (at) => {
      expect(trainingDatasetSchema.safeParse({ examples: [{ ...example, at }] }).success).toBe(true);
    }
  );

  it.each([
    undefined, "2026-10-09T10:20:31", "2026-10-09", "2026-10-09T10:20:31+24:00",
    "2026-10-09T10:20:31+02:60", "2026-02-30T10:20:31Z", "2026-10-09 10:20:31Z"
  ])("rejects missing or invalid instant %s", (at) => {
    expect(trainingDatasetSchema.safeParse({ examples: [{ ...example, at }] }).success).toBe(false);
  });

  it("requires examples and unique, safe ids", () => {
    expect(trainingDatasetSchema.safeParse({ examples: [] }).success).toBe(false);
    expect(trainingDatasetSchema.safeParse({ examples: [example, example] }).success).toBe(false);
    for (const id of ["", "space id", "bad/id"]) {
      expect(trainingDatasetSchema.safeParse({ examples: [{ ...example, id }] }).success).toBe(false);
    }
  });

  it.each([
    { examples: [example], extra: true },
    { examples: [{ ...example, extra: true }] },
    { examples: [{ ...example, files: [] }] },
    { examples: [{ ...example, environments: [] }] },
    { examples: [{ ...example, wake: { ...example.wake, extra: true } }] },
    { examples: [{ ...example, wake: { ...example.wake, surface: "slack" } }] },
    { examples: [{ ...example, wake: { surface: "moltnet", room: "assignment", text: "hello" } }] }
  ])("rejects unknown keys and malformed wakes", (data) => {
    expect(trainingDatasetSchema.safeParse(data).success).toBe(false);
  });

  it.each([
    { resources: [{ id: "repo" }] },
    { resources: [{ ...resource, branch: "main", tag: "v1" }] },
    { resources: [{ ...resource, unknown: true }] },
    { resources: [{ id: "state", kind: "volume", mount: "./state", mode: "readonly", feed: { directory: "source" } }] },
    { memory: [{ id: "self" }] },
    { memory: [{ ...memory, store: { kind: "memory", path: "/not-allowed" } }] },
    { memory: [{ ...memory, index: { vector: { enabled: true } } }] },
    { networks: [{ id: "news" }] },
    { networks: [{ ...network, rooms: [network.rooms[0], network.rooms[0]] }] },
    { networks: [{ ...network, rooms: [{ ...network.rooms[0], unknown: true }] }] }
  ])("rejects invalid overrides through the existing declaration schemas", (overrides) => {
    expect(trainingDatasetSchema.safeParse({ examples: [{ ...example, ...overrides }] }).success).toBe(false);
  });

  it("preserves normalization and defaults from existing schemas", () => {
    const data = trainingDatasetSchema.parse({
      examples: [{ ...example, memory: [{ id: " self ", store: { kind: "memory" }, index: { lexical: {} } }] }]
    });
    expect(data.examples[0]?.memory?.[0]).toEqual({
      id: "self", store: { kind: "memory" }, index: { lexical: { enabled: true } }
    });
  });
});

describe("training graders", () => {
  it("accepts questions and optional labels without reading output files", () => {
    expect(trainingGraderSchema.parse({ questions: [question] })).toEqual({ questions: [question] });
    const data = { questions: [question], labels: [label] };
    expect(trainingGraderSchema.parse(data)).toEqual(data);
    expect(trainingGraderSchema.safeParse({ questions: [question], labels: [{ ...label, id: "label.v1" }] }).success)
      .toBe(true);
  });

  it.each(["yes", 1, true, false])("accepts scalar expected and answer values %s", (value) => {
    expect(trainingGraderSchema.safeParse({
      questions: [{ ...question, expected: value }], labels: [{ ...label, answers: { "actor-first": value } }]
    }).success).toBe(true);
  });

  it.each([
    { questions: [] },
    { questions: [question, question] },
    { questions: [{ ...question, id: "bad.id" }] },
    { questions: [question], labels: [label, label] },
    { questions: [question], labels: [{ ...label, id: "" }] },
    { questions: [question], labels: [{ ...label, answers: {} }] },
    { questions: [question], labels: [{ ...label, answers: { unknown: "no" } }] },
    { questions: [{ ...question, expected: null }] },
    { questions: [question], labels: [{ ...label, answers: { "actor-first": [] } }] },
    { questions: [question], extra: true },
    { questions: [{ ...question, extra: true }] },
    { questions: [question], labels: [{ ...label, extra: true }] },
    { questions: [question], labels: [{ ...label, output: "" }] }
  ])("rejects malformed questions and labels", (value) => {
    expect(trainingGraderSchema.safeParse(value).success).toBe(false);
  });

  it.each(["/labels/output.json", "C:/labels/output.json", "C:\\labels\\output.json", "labels\\output.json"])(
    "rejects absolute or non-POSIX label output %s", (output) => {
      expect(trainingGraderSchema.safeParse({ questions: [question], labels: [{ ...label, output }] }).success).toBe(false);
    }
  );

  it("names the label and missing question in its diagnostic", () => {
    const result = trainingGraderSchema.safeParse({
      questions: [question], labels: [{ ...label, answers: { missing: "no" } }]
    });
    expect(result.error?.issues[0]).toMatchObject({
      message: "label ice-headline answer references unknown question missing",
      path: ["labels", 0, "answers", "missing"]
    });
  });
});
