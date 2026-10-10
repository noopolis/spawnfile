import { describe, expect, it } from "vitest";

import { trainingDatasetSchema } from "./trainingDataSchemas.js";

const example = {
  id: "ice-shooting.v1",
  at: "2026-10-09T10:20:31+02:00",
  wake: { surface: "moltnet", room: "assignment", from: "brass", text: "@tinkerton ..." }
};
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
