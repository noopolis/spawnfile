import { describe, expect, it } from "vitest";

import {
  filterDockerAuthE2EScenarios,
  listDockerAuthE2EScenarios
} from "./scenarios.js";

describe("listDockerAuthE2EScenarios", () => {
  it("includes the supported runtime/auth matrix plus the team smoke", () => {
    expect(listDockerAuthE2EScenarios().map((scenario) => scenario.id)).toEqual([
      "openclaw-api_key",
      "openclaw-codex",
      "openclaw-claude-code",
      "picoclaw-api_key",
      "picoclaw-codex",
      "picoclaw-claude-code",
      "tinyclaw-codex",
      "tinyclaw-claude-code",
      "team-multi-runtime"
    ]);
  });

  it("does not include unsupported tinyclaw api_key coverage", () => {
    expect(listDockerAuthE2EScenarios().some((scenario) => scenario.id === "tinyclaw-api_key")).toBe(
      false
    );
  });
});

describe("filterDockerAuthE2EScenarios", () => {
  it("filters by runtime across single-agent and team scenarios", () => {
    expect(
      filterDockerAuthE2EScenarios({ runtimes: ["tinyclaw"] }).map((scenario) => scenario.id)
    ).toEqual(["tinyclaw-codex", "tinyclaw-claude-code", "team-multi-runtime"]);
  });

  it("filters by auth method", () => {
    expect(
      filterDockerAuthE2EScenarios({ authMethods: ["api_key"] }).map((scenario) => scenario.id)
    ).toEqual(["openclaw-api_key", "picoclaw-api_key", "team-multi-runtime"]);
  });
});
