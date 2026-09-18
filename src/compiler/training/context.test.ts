import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTrainingContext } from "./context.js";
import { trainingContextJsonSchema, trainingContextSchema } from "./contract.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const directories: string[] = [];
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(async () => {
  vi.mocked(readFile).mockImplementation(actual.readFile);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function project(team = false): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-context-")));
  directories.push(root);
  await mkdir(path.join(root, "agents/author"), { recursive: true });
  await mkdir(path.join(root, "skills/reporting"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "Root system\n");
  await writeFile(path.join(root, "SOUL.md"), "Inherited soul\n");
  await writeFile(path.join(root, "agents/author/AGENTS.md"), "Local author system\n");
  await writeFile(path.join(root, "skills/reporting/SKILL.md"), "---\nname: reporting\ndescription: Report evidence.\n---\nRead carefully.\n");
  const workspace = { docs: { system: "AGENTS.md", soul: "SOUL.md" }, skills: [{ ref: "./skills/reporting" }] };
  const declaration = team ? {
    spawnfile_version: "0.1", kind: "team", name: "publication", mode: "hierarchical", lead: "author",
    shared: { workspace, environment: { env: { SECRET_LIKE_VALUE: "must-not-be-in-receipt" } } },
    members: [{ id: "author", ref: "./agents/author" }, { id: "reviewer", runtime: "daimon", workspace: { docs: { system: "AGENTS.md" } } }]
  } : { spawnfile_version: "0.1", kind: "agent", name: "author", runtime: "daimon", workspace };
  await writeFile(path.join(root, "Spawnfile"), stringify(declaration));
  if (team) await writeFile(path.join(root, "agents/author/Spawnfile"), stringify({
    spawnfile_version: "0.1", kind: "agent", name: "author",
    runtime: { name: "daimon", options: { engine: "codex" } },
    execution: { model: { primary: { provider: "openai", name: "gpt-5.5" }, auth: { method: "codex" } } },
    workspace: { docs: { system: "AGENTS.md" }, resources: [
      { id: "source", kind: "git", url: "https://user:private-token@example.invalid/code.git", ref: "a".repeat(40), mount: "./source", mode: "readonly" },
      { id: "moving", kind: "git", url: "https://example.invalid/other.git", branch: "main", mount: "./moving", mode: "readonly" },
      { id: "tools", kind: "bundle", source: "missing-but-uncompiled.tar", sha256: hash("tools"), mount: "./tools", mode: "readonly" },
      { id: "state", kind: "volume", name: "never-attach", mount: "./state", mode: "mutable", sharing: "team" }
    ] }
  }));
  return root;
}

describe("canonical training context", () => {
  it("pins the full graph and preserves effective inherited docs, skills and model auth", async () => {
    const root = await project(true);
    const context = await createTrainingContext(root, { agent: "agent:author", packageVersion: "0.1.17" });
    expect(context.agent).toEqual({ id: "agent:author", name: "author", source: path.join(root, "agents/author/Spawnfile"),
      runtime: "daimon", engine: "codex", model: { provider: "openai", name: "gpt-5.5", authMethod: "codex" } });
    expect(context.documents.map((document) => [document.role, document.destinationPath])).toEqual([
      ["system", "agents/author/AGENTS.md"], ["soul", "SOUL.md"]
    ]);
    expect(context.skills[0]).toMatchObject({ name: "reporting", destinationPath: "skills/reporting/SKILL.md" });
    expect(context.sources.map((source) => source.destinationPath)).toEqual([
      "AGENTS.md", "SOUL.md", "Spawnfile", "agents/author/AGENTS.md", "agents/author/Spawnfile", "skills/reporting/SKILL.md"
    ]);
    expect(context.project.sourceDigest).toBe(hash(JSON.stringify(context.sources.map(({ destinationPath, sha256 }) => ({ destinationPath, sha256 })))));
    expect(context.resources.map((resource) => [resource.id, resource.pin])).toEqual([
      ["moving", null], ["source", "a".repeat(40)], ["state", null], ["tools", hash("tools")]
    ]);
    expect(JSON.stringify(context)).not.toMatch(/must-not-be-in-receipt|private-token|never-attach|example\.invalid/u);
    expect(context.requirements).toEqual({ nativeCompilation: true, isolatedPreparation: true });
    expect(await actual.readdir(root)).not.toContain(".spawn");
  });

  it("infers only a single agent and retains unknown runtime defaults", async () => {
    const context = await createTrainingContext(await project(), { packageVersion: "0.1.17" });
    expect(context.agent).toMatchObject({ id: "agent:author", engine: null, model: null });
    expect(trainingContextSchema.parse(context)).toEqual(context);
    expect(trainingContextJsonSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(trainingContextSchema.safeParse({ ...context, environment: { secret: "no" } }).success).toBe(false);
    expect(trainingContextSchema.safeParse({ ...context, sources: [{ ...context.sources[0], destinationPath: "../escape" }] }).success).toBe(false);
  });

  it("selects an inline member through its actual parent manifest", async () => {
    const root = await project(true);
    const context = await createTrainingContext(root, { agent: "agent:reviewer", packageVersion: "0.1.17" });
    expect(context.agent.source).toBe(path.join(root, "Spawnfile"));
    expect(context.documents.find((document) => document.role === "system")?.destinationPath).toBe("AGENTS.md");
    expect(context.resources).toEqual([]);
  });

  it("rejects omitted, fuzzy, team and unknown selections in a multi-agent graph", async () => {
    const root = await project(true);
    for (const agent of [undefined, "author", "team:publication", "agent:missing"]) {
      await expect(createTrainingContext(root, { agent, packageVersion: "0.1.17" })).rejects.toThrow(/--agent|No canonical agent/u);
    }
  });

  it("makes changed source bytes visible in the fingerprint without absolute-root dependence", async () => {
    const root = await project();
    const initial = await createTrainingContext(root, { packageVersion: "0.1.17" });
    const clone = await project();
    expect((await createTrainingContext(clone, { packageVersion: "0.1.17" })).project.sourceDigest).toBe(initial.project.sourceDigest);
    await writeFile(path.join(root, "AGENTS.md"), "Updated system\n");
    const updated = await createTrainingContext(root, { packageVersion: "0.1.17" });
    expect(updated.project.sourceDigest).not.toBe(initial.project.sourceDigest);
    expect(updated.documents.find((document) => document.role === "system")?.sha256).toBe(hash("Updated system\n"));
  });

  it("rejects a symlink escaping the project", async () => {
    const root = await project(), outside = await project();
    await rm(path.join(root, "AGENTS.md"));
    await symlink(path.join(outside, "AGENTS.md"), path.join(root, "AGENTS.md"));
    await expect(createTrainingContext(root, { packageVersion: "0.1.17" })).rejects.toThrow(/inside the canonical project root|Symlinks are not allowed/u);
  });

  it("rejects a referenced agent outside the canonical project root", async () => {
    const root = await project(), outside = await project();
    await writeFile(path.join(root, "Spawnfile"), stringify({ spawnfile_version: "0.1", kind: "team", name: "external", mode: "swarm",
      members: [{ id: "author", ref: path.relative(root, outside) }] }));
    await expect(createTrainingContext(root, { packageVersion: "0.1.17" })).rejects.toThrow(/inside the canonical project root|escapes/u);
  });

  it.each(["AGENTS.md", "Spawnfile"])("rejects %s changing during capture", async (name) => {
    const root = await project();
    let reads = 0;
    const target = path.join(root, name);
    vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
      if (String(args[0]) === target && ++reads === (name === "Spawnfile" ? 3 : 2)) {
        await writeFile(target, name === "Spawnfile" ? `${await actual.readFile(target, "utf8")}# changed\n` : "Changed during resolution\n");
      }
      return actual.readFile(...args);
    }) as typeof readFile);
    await expect(createTrainingContext(root, { packageVersion: "0.1.17" })).rejects.toThrow(/changed/u);
  });

  it("rejects a manifest changed before its first pin instead of pairing old resolution with new bytes", async () => {
    const root = await project(), target = path.join(root, "Spawnfile");
    let reads = 0;
    vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
      if (String(args[0]) === target && ++reads === 2) {
        await writeFile(target, (await actual.readFile(target, "utf8")).replace("name: author", "name: changed"));
      }
      return actual.readFile(...args);
    }) as typeof readFile);
    await expect(createTrainingContext(root, { packageVersion: "0.1.17" })).rejects.toThrow("between canonical resolution");
  });

  it("keeps the documented JSON schema identical to the exported contract", async () => {
    const doc = await actual.readFile(new URL("../../../specs/TRAINING.md", import.meta.url), "utf8");
    const schema = doc.match(/<!-- training-context-schema:start -->\n```json\n([\s\S]*?)\n```/u)?.[1];
    expect(JSON.parse(schema!)).toEqual(trainingContextJsonSchema);
  });
});
