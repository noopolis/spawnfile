import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
  createPiProviderId,
  renderPiModelsConfig,
  resolvePiHarnessModel
} from "./modelConfig.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-models-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("maps OpenAI Codex model intent to Pi's subscription provider", () => {
  assert.deepEqual(resolvePiHarnessModel({
    auth: { method: "codex" },
    name: "gpt-5.4-mini",
    provider: "openai"
  }), {
    model: {
      name: "gpt-5.4-mini",
      provider: "openai-codex"
    },
    modelsConfig: {
      providers: {}
    }
  });
});

test("renders Ollama-compatible local models with a deterministic provider id", async () => {
  const model = {
    auth: { method: "none" as const },
    endpoint: {
      baseUrl: "http://127.0.0.1:11434/v1",
      compatibility: "openai" as const
    },
    name: "llama3.2",
    provider: "local"
  };
  const providerId = createPiProviderId(model);
  const config = JSON.parse(renderPiModelsConfig([model])) as {
    providers: Record<string, { apiKey: string; baseUrl: string; models: Array<{ id: string }> }>;
  };

  assert.match(providerId, /^local-openai-llama3-2-[a-f0-9]{8}$/);
  assert.deepEqual(config.providers[providerId], {
    api: "openai-completions",
    apiKey: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [
      {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
        contextWindow: 128000,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0
        },
        id: "llama3.2",
        input: ["text"],
        maxTokens: 16384,
        name: "llama3.2",
        reasoning: false
      }
    ]
  });

  const root = await tempDir();
  const modelsPath = path.join(root, "models.json");
  await writeFile(modelsPath, renderPiModelsConfig([model]));
  const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
  const resolved = resolvePiHarnessModel(model).model;
  assert.equal(registry.find(resolved.provider, resolved.name)?.baseUrl, "http://127.0.0.1:11434/v1");
});

test("renders custom API-key endpoint models with env-backed auth", () => {
  const model = {
    auth: {
      keyEnv: "CUSTOM_LLM_KEY",
      method: "api_key" as const
    },
    endpoint: {
      baseUrl: "https://llm.example.com/v1",
      compatibility: "openai" as const
    },
    name: "custom-chat",
    provider: "custom"
  };

  const providerId = createPiProviderId(model);
  const config = JSON.parse(renderPiModelsConfig([model])) as {
    providers: Record<string, { apiKey: string }>;
  };

  assert.equal(config.providers[providerId].apiKey, "$CUSTOM_LLM_KEY");
});

test("rejects subscription auth for endpoint-backed models", () => {
  assert.throws(
    () => resolvePiHarnessModel({
      auth: { method: "codex" },
      endpoint: {
        baseUrl: "http://127.0.0.1:11434/v1",
        compatibility: "openai"
      },
      name: "llama3.2",
      provider: "local"
    }),
    /only support none or api_key auth/
  );
});

test("uses distinct provider ids for different endpoint backends", () => {
  const left = createPiProviderId({
    auth: { method: "none" },
    endpoint: {
      baseUrl: "http://127.0.0.1:11434/v1",
      compatibility: "openai"
    },
    name: "llama3.2",
    provider: "local"
  });
  const right = createPiProviderId({
    auth: { method: "none" },
    endpoint: {
      baseUrl: "http://127.0.0.1:1234/v1",
      compatibility: "openai"
    },
    name: "llama3.2",
    provider: "local"
  });

  assert.notEqual(left, right);
});
