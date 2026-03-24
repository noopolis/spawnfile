import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { isAgentManifest, isTeamManifest, loadManifest } from "../manifest/index.js";

import { addAgentProject, addSubagentProject } from "./addProjectNode.js";
import { initProject } from "./initProject.js";
import {
  addProjectModelFallback,
  clearProjectModelFallbacks,
  setProjectPrimaryModel
} from "./updateProjectModels.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("setProjectPrimaryModel", () => {
  it("sets the primary model and rewrites manifests to inline auth", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-set-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });

    const manifestPath = path.join(directory, "Spawnfile");
    const originalSource = await readUtf8File(manifestPath);
    await expect(originalSource).not.toContain("auth:");

    const result = await setProjectPrimaryModel({
      authMethod: "claude-code",
      name: "claude-opus-4-6",
      path: directory,
      provider: "anthropic"
    });

    const nextSource = await readUtf8File(manifestPath);
    const nextManifest = await loadManifest(manifestPath);

    expect(result.updatedFiles).toEqual([manifestPath]);
    expect(nextSource).toContain("      provider: anthropic");
    expect(nextSource).toContain("      name: claude-opus-4-6");
    expect(nextSource).toContain("      auth:\n        method: claude-code");
    expect(nextSource).not.toContain("\n    auth:\n");
    expect(isAgentManifest(nextManifest.manifest)).toBe(true);
    if (!isAgentManifest(nextManifest.manifest)) {
      throw new Error("expected agent manifest");
    }
    expect(nextManifest.manifest.execution?.model?.primary.auth?.method).toBe("claude-code");
  });

  it("updates a whole team graph recursively", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-set-recursive-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await addAgentProject({ id: "writer", path: directory });
    await addSubagentProject({ id: "critic", path: path.join(directory, "agents", "writer") });

    const result = await setProjectPrimaryModel({
      authMethod: "codex",
      name: "gpt-5.4",
      path: directory,
      provider: "openai",
      recursive: true
    });

    const rootManifest = await loadManifest(path.join(directory, "Spawnfile"));
    const writerManifest = await loadManifest(path.join(directory, "agents", "writer", "Spawnfile"));
    const criticManifest = await loadManifest(
      path.join(directory, "agents", "writer", "subagents", "critic", "Spawnfile")
    );

    expect(result.updatedFiles).toEqual([
      path.join(directory, "agents", "writer", "Spawnfile"),
      path.join(directory, "agents", "writer", "subagents", "critic", "Spawnfile")
    ]);
    expect(isTeamManifest(rootManifest.manifest)).toBe(true);
    expect(rootManifest.manifest.execution).toBeUndefined();
    expect(writerManifest.manifest.execution?.model?.primary.name).toBe("gpt-5.4");
    expect(criticManifest.manifest.execution?.model?.primary.auth?.method).toBe("codex");
  });

  it("rejects non-recursive model updates on team manifests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-team-error-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });

    await expect(
      setProjectPrimaryModel({
        authMethod: "claude-code",
        name: "claude-opus-4-6",
        path: directory,
        provider: "anthropic"
      })
    ).rejects.toThrow(/use --recursive to update descendant agents of a team project/);
  });

  it("rejects invalid auth and endpoint option combinations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-set-guards-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });

    await expect(
      setProjectPrimaryModel({
        authMethod: "claude-code",
        name: "claude-opus-4-6",
        path: directory,
        provider: "claude-code"
      })
    ).rejects.toThrow(/provider must not be an auth method: claude-code/i);

    await expect(
      setProjectPrimaryModel({
        authKey: "OPENAI_API_KEY",
        authMethod: "codex",
        name: "gpt-5.4",
        path: directory,
        provider: "openai"
      })
    ).rejects.toThrow(/only valid with api_key auth/);

    await expect(
      setProjectPrimaryModel({
        endpointBaseUrl: "https://llm.example.com/v1",
        endpointCompatibility: "openai",
        name: "gpt-5.4",
        path: directory,
        provider: "openai"
      })
    ).rejects.toThrow(/Only custom and local models accept --base-url and --compat/);

    await expect(
      setProjectPrimaryModel({
        endpointBaseUrl: "https://llm.example.com/v1",
        endpointCompatibility: "anthropic",
        name: "foo-large",
        path: directory,
        provider: "custom"
      })
    ).rejects.toThrow(/Custom models require --auth/);

    await expect(
      setProjectPrimaryModel({
        authMethod: "api_key",
        endpointBaseUrl: "http://host.docker.internal:11434/v1",
        endpointCompatibility: "openai",
        name: "qwen2.5:14b",
        path: directory,
        provider: "local"
      })
    ).rejects.toThrow(/local api_key auth requires --key/);
  });
});

describe("addProjectModelFallback", () => {
  it("adds a fallback and normalizes legacy auth to inline auth", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-fallback-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });

    const manifestPath = path.join(directory, "Spawnfile");
    const source = [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: my-agent",
      "",
      "runtime: openclaw",
      "",
      "execution:",
      "  model:",
      "    auth:",
      "      method: api_key",
      "    primary:",
      "      provider: anthropic",
      "      name: claude-opus-4-6",
      "",
      "docs:",
      "  identity: IDENTITY.md",
      "  soul: SOUL.md",
      "  system: AGENTS.md",
      ""
    ].join("\n");
    await writeUtf8File(manifestPath, source);

    const result = await addProjectModelFallback({
      authMethod: "none",
      endpointBaseUrl: "http://host.docker.internal:11434/v1",
      endpointCompatibility: "openai",
      name: "qwen2.5:14b",
      path: directory,
      provider: "local"
    });

    const nextSource = await readUtf8File(manifestPath);
    const nextManifest = await loadManifest(manifestPath);

    expect(result.updatedFiles).toEqual([manifestPath]);
    expect(nextSource).toContain("      auth:\n        method: api_key");
    expect(nextSource).not.toContain("\n    auth:\n");
    expect(nextSource).toContain("      - provider: local");
    expect(nextManifest.manifest.execution?.model?.fallback).toContainEqual({
      auth: {
        method: "none"
      },
      endpoint: {
        base_url: "http://host.docker.internal:11434/v1",
        compatibility: "openai"
      },
      name: "qwen2.5:14b",
      provider: "local"
    });
  });

  it("skips manifests without a primary model during recursive fallback updates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-fallback-recursive-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await addAgentProject({ id: "writer", path: directory });

    const result = await addProjectModelFallback({
      authMethod: "claude-code",
      name: "claude-opus-4-6",
      path: directory,
      provider: "anthropic",
      recursive: true
    });

    const rootSource = await readUtf8File(path.join(directory, "Spawnfile"));
    const writerManifest = await loadManifest(path.join(directory, "agents", "writer", "Spawnfile"));
    const rootManifest = await loadManifest(path.join(directory, "Spawnfile"));

    expect(result.updatedFiles).toEqual([path.join(directory, "agents", "writer", "Spawnfile")]);
    expect(rootManifest.manifest.execution).toBeUndefined();
    expect(rootSource).not.toContain("fallback:");
    expect(writerManifest.manifest.execution?.model?.fallback?.[0]?.auth?.method).toBe(
      "claude-code"
    );
  });

  it("treats duplicate fallback additions as a no-op", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-fallback-noop-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "openclaw" });
    await addProjectModelFallback({
      authMethod: "claude-code",
      name: "claude-opus-4-6",
      path: directory,
      provider: "anthropic"
    });

    const result = await addProjectModelFallback({
      authMethod: "claude-code",
      name: "claude-opus-4-6",
      path: directory,
      provider: "anthropic"
    });

    expect(result.updatedFiles).toEqual([]);
  });
});

describe("clearProjectModelFallbacks", () => {
  it("clears fallback models while preserving the inline primary model", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-clear-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, runtime: "picoclaw" });
    await addProjectModelFallback({
      authMethod: "claude-code",
      name: "claude-opus-4-6",
      path: directory,
      provider: "anthropic"
    });

    const result = await clearProjectModelFallbacks({ path: directory });
    const nextSource = await readUtf8File(path.join(directory, "Spawnfile"));

    expect(result.updatedFiles).toEqual([path.join(directory, "Spawnfile")]);
    expect(nextSource).not.toContain("fallback:");
    expect(nextSource).toContain("provider: anthropic");
  });

  it("errors outside recursive mode when no execution model exists", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-clear-error-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });

    await expect(clearProjectModelFallbacks({ path: directory })).rejects.toThrow(
      /use --recursive to update descendant agents of a team project/
    );
  });

  it("skips manifests without execution models during recursive clear", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-model-clear-skip-"));
    temporaryDirectories.push(directory);

    await initProject({ directory, team: true });
    await addAgentProject({ id: "writer", path: directory });

    const result = await clearProjectModelFallbacks({ path: directory, recursive: true });

    expect(result.updatedFiles).toEqual([path.join(directory, "agents", "writer", "Spawnfile")]);
  });
});
