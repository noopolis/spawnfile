import { afterEach, expect, it, vi } from "vitest";

import type { ResolvedAuthProfile } from "../auth/index.js";
import * as registry from "./registry.js";
import { resolveRuntimeHomeImports } from "./runtimeHomeImports.js";

const profile: ResolvedAuthProfile = {
  name: "fixture", authHome: "/auth", profileDirectory: "/auth/fixture", profilePath: "/auth/fixture/profile.json",
  version: 1, env: {},
  imports: {
    codex: { kind: "codex", path: "/auth/fixture/codex" },
    "claude-code": { kind: "claude-code", path: "/auth/fixture/claude" }
  }
};

const instance = (runtime: string, method?: string, homePath: string | null = `/state/${runtime}/home`) => {
  const model_auth_methods: Record<string, string> = method ? { provider: method } : {};
  return { home_path: homePath, id: runtime, runtime, model_auth_methods };
};

afterEach(() => vi.restoreAllMocks());

it("mounts selected profile imports only into the runtime homes that requested them", () => {
  expect(resolveRuntimeHomeImports([
    instance("openclaw", "codex"),
    instance("picoclaw", "claude-code"),
    instance("daimon")
  ], profile)).toEqual([
    { method: "claude-code", source: "/auth/fixture/claude", targets: ["/state/picoclaw/home/.claude"] },
    { method: "codex", source: "/auth/fixture/codex", targets: ["/state/openclaw/home/.codex"] }
  ]);
});

it("refuses a shared container if an external runtime has not requested the raw import", () => {
  expect(() => resolveRuntimeHomeImports([
    instance("openclaw", "codex"), instance("external-harness")
  ], profile)).toThrow(/Use separate deployments with matching credential requirements or omit the import/u);
});

it("leaves mixed deployments without selected raw imports usable", () => {
  expect(resolveRuntimeHomeImports([instance("openclaw", "api_key"), instance("external-harness")], profile)).toEqual([]);
  expect(resolveRuntimeHomeImports([instance("external-harness", "codex")], profile)).toEqual([]);
});

it("allows an external runtime that supports and requests the same raw import", () => {
  const registered = registry.getRuntimeAdapter;
  const hasRuntime = registry.hasRuntimeAdapter;
  const openclaw = registered("openclaw");
  vi.spyOn(registry, "hasRuntimeAdapter").mockImplementation((name) => name === "external-harness" || hasRuntime(name));
  vi.spyOn(registry, "getRuntimeAdapter").mockImplementation((name) => name === "external-harness"
    ? { ...openclaw, name, container: { ...openclaw.container, rawHomeAuthImports: ["codex"] } }
    : registered(name));

  expect(resolveRuntimeHomeImports([
    instance("openclaw", "codex"), instance("external-harness", "codex")
  ], profile)).toEqual([{
    method: "codex", source: "/auth/fixture/codex",
    targets: ["/state/openclaw/home/.codex", "/state/external-harness/home/.codex"]
  }]);
  expect(() => resolveRuntimeHomeImports([
    instance("openclaw", "claude-code"), instance("external-harness", "claude-code")
  ], profile)).toThrow(/does not request or support the claude-code import/u);
});

it("does not use aggregate home or model facts when the receiving instance is ambiguous", () => {
  expect(() => resolveRuntimeHomeImports([
    instance("openclaw", "codex", "/state/shared"), instance("picoclaw", "api_key", "/state/shared/nested")
  ], profile)).toThrow(/shares a home/u);
  expect(() => resolveRuntimeHomeImports([instance("openclaw", "codex", null)], profile)).toThrow(/without a home/u);
  expect(() => resolveRuntimeHomeImports([instance("openclaw", "codex", "/")], profile)).toThrow(/Invalid runtime home/u);
});
