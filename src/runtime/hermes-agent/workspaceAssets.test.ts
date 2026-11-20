import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hermesWorkspaceAssetFiles, hermesWorkspaceCaptureCommand } from "./workspaceAssets.js";
import { hermesWorkspaceReconciler } from "./workspaceReconciler.js";

const moltnet = ".moltnet/config.json";
const moltnetSkill = ".agents/skills/moltnet/SKILL.md";
const skill = "skills/research/SKILL.md";

async function put(root: string, name: string, content: string): Promise<void> {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe("Hermes durable workspace assets", () => {
  it("lists only declared assets and captures after the assembled workspace is available", () => {
    const files = hermesWorkspaceAssetFiles([{ path: "workspace/AGENTS.md", content: "fixture" }]);
    expect(JSON.parse(files[0]!.content)).toEqual(["AGENTS.md"]);
    expect(hermesWorkspaceCaptureCommand).toContain('capture "$instance/workspace"');
  });

  it("adds Moltnet to a reused workspace, updates or removes owned files and keeps local changes", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hermes-workspace-assets-"));
    const image = path.join(base, "image");
    const live = path.join(base, "live");
    const program = path.join(base, "reconcile.py");
    const manifest = path.join(base, "manifest.json");
    const read = (file: string) => readFile(path.join(live, file), "utf8");
    const capture = (files: string[]) => {
      execFileSync("python3", ["-c", "import json,sys; open(sys.argv[1], 'w').write(json.dumps(sys.argv[2:]))", manifest, ...files]);
      execFileSync("python3", [program, "capture", image, manifest]);
    };
    const restore = () => execFileSync("python3", [program, live, "/usr/bin/printf", "gateway starts"], { encoding: "utf8" });
    try {
      await writeFile(program, hermesWorkspaceReconciler);
      await put(live, "AGENTS.md", "preexisting local instructions");
      await put(live, "draft.md", "operator work");
      await put(image, "AGENTS.md", "compiled instructions");
      await put(image, "draft.md", "not a declared asset");
      await put(image, skill, "compiler skill 1");
      await put(image, moltnet, '{"rooms":["test"]}');
      await put(image, moltnetSkill, "compiler Moltnet skill");
      capture(["AGENTS.md", skill]);
      expect(restore()).toBe("gateway starts");
      expect(await read(moltnet)).toBe('{"rooms":["test"]}');
      expect(await read(moltnetSkill)).toBe("compiler Moltnet skill");
      expect(await read(skill)).toBe("compiler skill 1");
      expect(await read("AGENTS.md")).toBe("preexisting local instructions");
      expect(await read("draft.md")).toBe("operator work");

      await put(image, moltnet, '{"rooms":["relay"]}');
      await put(image, skill, "compiler skill 2");
      await put(live, skill, "operator skill update");
      capture(["AGENTS.md", skill]);
      expect(restore()).toBe("gateway starts");
      expect(await read(moltnet)).toBe('{"rooms":["relay"]}');
      expect(await read(skill)).toBe("operator skill update");

      await rm(path.join(image, moltnet));
      await rm(path.join(image, moltnetSkill));
      capture([]);
      expect(restore()).toBe("gateway starts");
      await expect(read(moltnet)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(read(moltnetSkill)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await read(skill)).toBe("operator skill update");
      expect(await read("draft.md")).toBe("operator work");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("preserves symlinks, existing user-written Moltnet files and locally deleted owned files", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hermes-workspace-safe-"));
    const image = path.join(base, "image");
    const live = path.join(base, "live");
    const outside = path.join(base, "outside");
    const program = path.join(base, "reconcile.py");
    const manifest = path.join(base, "manifest.json");
    const restore = () => execFileSync("python3", [program, live, "/usr/bin/true"]);
    try {
      await writeFile(program, hermesWorkspaceReconciler);
      await writeFile(manifest, JSON.stringify([skill]));
      await put(live, moltnet, "local config");
      await put(outside, "skills/moltnet/SKILL.md", "outside skill");
      await symlink(outside, path.join(live, ".agents"));
      await put(image, moltnet, "compiled config");
      await put(image, moltnetSkill, "compiled Moltnet skill");
      await put(image, skill, "compiled research skill");
      execFileSync("python3", [program, "capture", image, manifest]);
      restore();
      await rm(path.join(live, skill));
      restore();
      expect(await readFile(path.join(live, moltnet), "utf8")).toBe("local config");
      expect(await readFile(path.join(outside, "skills/moltnet/SKILL.md"), "utf8")).toBe("outside skill");
      await expect(readFile(path.join(live, skill))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
