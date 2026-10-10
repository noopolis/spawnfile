import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { materializeInlineAgentManifest } from "./inlineAgentMember.js";
import { renderSpawnfile } from "./renderSpawnfile.js";
import { isInlineAgentMember, manifestSchema } from "./schemas.js";
import { trainingDeclarationSchema, trainingTargetSchema } from "./trainingSchemas.js";

const target = {
  files: ["AGENTS.md", "skills/write/SKILL.md"],
  grader: "writing",
  datasets: { train: "training/train.yaml", validation: "training/validation.yaml", test: "training/test.yaml" }
};

const declaration = {
  record: { keep: "30d", volumes: ["edition-state"] },
  optimizer: { method: "gepa", model: "claude-opus-5-5", variants: 8, keep: 3, budget: { rounds: 10 } },
  graders: { writing: "training/writing.grader.yaml" },
  targets: [target]
};

describe("training declarations", () => {
  it("accepts the complete signed authoring surface without adding defaults", () => {
    expect(trainingDeclarationSchema.parse(declaration)).toEqual(declaration);
    expect(trainingDeclarationSchema.parse({})).toEqual({});
    expect(trainingDeclarationSchema.parse({ record: {}, optimizer: { budget: {} }, targets: [] }))
      .toEqual({ record: {}, optimizer: { budget: {} }, targets: [] });
  });

  it("allows optimizer declarations to be partial until graph resolution", () => {
    expect(trainingDeclarationSchema.parse({ optimizer: { budget: { rounds: 30 } } }))
      .toEqual({ optimizer: { budget: { rounds: 30 } } });
    expect(trainingDeclarationSchema.safeParse({ targets: [target] }).success).toBe(true);
    expect(trainingDeclarationSchema.safeParse({ optimizer: { keep: 10, variants: 1 } }).success).toBe(true);
  });

  it.each(["1m", "12h", "30d"])("accepts duration %s", (keep) => {
    expect(trainingDeclarationSchema.safeParse({ record: { keep } }).success).toBe(true);
  });

  it.each(["0d", "01d", "-1h", "1.5h", "30s", "30D", " 30d", "30d ", ""])("rejects duration %s", (keep) => {
    expect(trainingDeclarationSchema.safeParse({ record: { keep } }).success).toBe(false);
  });

  it.each([
    { unknown: true },
    { record: { unknown: true } },
    { optimizer: { unknown: true } },
    { optimizer: { budget: { unknown: true } } },
    { targets: [{ ...target, unknown: true }] },
    { targets: [{ ...target, datasets: { ...target.datasets, unknown: true } }] },
    { files: ["AGENTS.md"] },
    { environments: "training/environments.yaml" }
  ])("rejects unknown keys at every declaration object", (value) => {
    expect(trainingDeclarationSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { record: { volumes: [""] } },
    { record: { volumes: ["state", "state"] } },
    { optimizer: { method: "" } },
    { optimizer: { model: "" } },
    { optimizer: { variants: 0 } },
    { optimizer: { variants: 1.5 } },
    { optimizer: { keep: 0 } },
    { optimizer: { keep: 1.5 } },
    { optimizer: { budget: { rounds: 0 } } },
    { optimizer: { budget: { rounds: 1.5 } } },
    { graders: { "bad.name": "grader.yaml" } },
    { graders: { writing: "" } }
  ])("rejects malformed record, optimizer, and graders", (value) => {
    expect(trainingDeclarationSchema.safeParse(value).success).toBe(false);
  });

  it.each(["/outside.md", "C:/outside.md", "C:\\outside.md", "\\\\server\\share\\outside.md", "relative\\file.md"])(
    "rejects absolute or non-POSIX paths %s in every path position", (path) => {
      expect(trainingDeclarationSchema.safeParse({ graders: { writing: path } }).success).toBe(false);
      expect(trainingTargetSchema.safeParse({ ...target, files: [path] }).success).toBe(false);
      for (const role of ["train", "validation", "test"]) {
        expect(trainingTargetSchema.safeParse({ ...target, datasets: { ...target.datasets, [role]: path } }).success)
          .toBe(false);
      }
    }
  );

  it("keeps relative parent paths for ownership checks during resolution", () => {
    expect(trainingTargetSchema.safeParse({ ...target, files: ["../AGENTS.md"] }).success).toBe(true);
    expect(trainingDeclarationSchema.safeParse({ graders: { writing: "../training/grader.yaml" } }).success).toBe(true);
  });

  it.each([
    { ...target, files: [] },
    { ...target, files: ["AGENTS.md", "AGENTS.md"] },
    { ...target, files: ["AGENTS.txt"] },
    { ...target, files: ["AGENTS.MD"] },
    { ...target, files: [""] },
    { ...target, grader: "bad.name" },
    { ...target, datasets: { train: "train.yaml" } },
    { ...target, datasets: { test: "test.yaml" } }
  ])("rejects invalid targets", (value) => {
    expect(trainingTargetSchema.safeParse(value).success).toBe(false);
  });
});

describe("training manifest placement", () => {
  it("retains training through agent and shared/inline team rendering", () => {
    const manifests = [
      { spawnfile_version: "0.1", kind: "agent", name: "writer", training: declaration },
      {
        spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm",
        shared: { training: declaration },
        members: [{ id: "writer", workspace: { docs: { system: "AGENTS.md" } }, training: declaration }]
      }
    ];
    for (const source of manifests) {
      const manifest = manifestSchema.parse(source);
      expect(manifestSchema.parse(YAML.parse(renderSpawnfile(manifest)) as unknown)).toEqual(manifest);
    }
  });

  it("allows agent, shared team, and inline member declarations", () => {
    const agent = manifestSchema.parse({
      spawnfile_version: "0.1", kind: "agent", name: "writer", training: declaration
    });
    expect(agent.kind === "agent" && agent.training).toEqual(declaration);
    const team = manifestSchema.parse({
      spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm",
      shared: { training: declaration },
      members: [{ id: "writer", workspace: { docs: { system: "AGENTS.md" } }, training: declaration }]
    });
    if (team.kind !== "team") throw new Error("expected team");
    expect(team.shared?.training).toEqual(declaration);
    const member = team.members[0];
    if (!member || !isInlineAgentMember(member)) throw new Error("expected inline member");
    expect(materializeInlineAgentManifest(team, member).training).toEqual(declaration);
  });

  it("rejects team top-level and referenced-member training", () => {
    const team = { spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm", members: [] };
    expect(manifestSchema.safeParse({ ...team, training: declaration }).success).toBe(false);
    expect(manifestSchema.safeParse({
      ...team, members: [{ id: "writer", ref: "./writer", training: declaration }]
    }).success).toBe(false);
  });
});
