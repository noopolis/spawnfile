import { describe, expect, it } from "vitest";

import type { ExecutionBlock } from "../manifest/index.js";

import {
  listEffectiveExecutionModelTargets,
  listExecutionModelProviders,
  listExecutionModelSecretNames,
  resolveEffectiveModelTarget,
  resolveExecutionModelAuthMethods,
  resolveModelProviderEnvName
} from "./modelEnv.js";

describe("modelEnv", () => {
  it("defaults built-in providers to api_key auth", () => {
    const execution: ExecutionBlock = {
      model: {
        primary: {
          name: "gpt-5.4",
          provider: "openai"
        }
      }
    };

    expect(resolveExecutionModelAuthMethods(execution)).toEqual({
      openai: "api_key"
    });
    expect(listExecutionModelSecretNames(execution)).toEqual(["OPENAI_API_KEY"]);
  });

  it("defaults local providers to none auth", () => {
    const execution: ExecutionBlock = {
      model: {
        primary: {
          endpoint: {
            base_url: "http://host.docker.internal:11434/v1",
            compatibility: "openai"
          },
          name: "qwen2.5:14b",
          provider: "local"
        }
      }
    };

    expect(listEffectiveExecutionModelTargets(execution)).toEqual([
      {
        auth: {
          method: "none"
        },
        endpoint: {
          base_url: "http://host.docker.internal:11434/v1",
          compatibility: "openai"
        },
        name: "qwen2.5:14b",
        provider: "local"
      }
    ]);
    expect(listExecutionModelSecretNames(execution)).toEqual([]);
  });

  it("inherits legacy auth maps when inline auth is omitted", () => {
    const execution: ExecutionBlock = {
      model: {
        auth: {
          methods: {
            anthropic: "claude-code",
            openai: "codex"
          }
        },
        fallback: [
          {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        ],
        primary: {
          name: "gpt-5.4",
          provider: "openai"
        }
      }
    };

    expect(resolveExecutionModelAuthMethods(execution)).toEqual({
      anthropic: "claude-code",
      openai: "codex"
    });
  });

  it("uses explicit auth.key for custom api_key models", () => {
    const execution: ExecutionBlock = {
      model: {
        primary: {
          auth: {
            key: "CUSTOM_API_KEY",
            method: "api_key"
          },
          endpoint: {
            base_url: "https://llm.example.com/v1",
            compatibility: "anthropic"
          },
          name: "foo-large",
          provider: "custom"
        }
      }
    };

    expect(listExecutionModelSecretNames(execution)).toEqual(["CUSTOM_API_KEY"]);
  });

  it("rejects custom models without declared auth", () => {
    expect(() =>
      resolveEffectiveModelTarget(
        {
          endpoint: {
            base_url: "https://llm.example.com/v1",
            compatibility: "openai"
          },
          name: "foo-large",
          provider: "custom"
        },
        undefined
      )
    ).toThrow(/must declare auth\.method/);
  });

  it("rejects conflicting auth methods for the same provider", () => {
    const execution: ExecutionBlock = {
      model: {
        fallback: [
          {
            auth: {
              method: "api_key"
            },
            name: "gpt-4.1-mini",
            provider: "openai"
          }
        ],
        primary: {
          auth: {
            method: "codex"
          },
          name: "gpt-5.4",
          provider: "openai"
        }
      }
    };

    expect(() => resolveExecutionModelAuthMethods(execution)).toThrow(
      /conflicting auth methods/
    );
  });

  it("lists unique providers in sorted order", () => {
    const execution: ExecutionBlock = {
      model: {
        fallback: [
          {
            name: "claude-opus-4-6",
            provider: "anthropic"
          },
          {
            name: "gpt-4.1-mini",
            provider: "openai"
          }
        ],
        primary: {
          name: "gpt-5.4",
          provider: "openai"
        }
      }
    };

    expect(listExecutionModelProviders(execution)).toEqual(["anthropic", "openai"]);
  });

  it("formats provider env names for unknown providers", () => {
    expect(resolveModelProviderEnvName("my-proxy")).toBe("MY_PROXY_API_KEY");
  });
});
