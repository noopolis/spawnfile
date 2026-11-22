import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { hermesAuthValidatorSource, validHermesAuthStore } from "./authStore.js";

const codex = "openai-codex";
const xai = "xai-oauth";
const minimax = "minimax-oauth";
const nous = "nous";
const pair = { access_token: "fixture-access", refresh_token: "fixture-refresh" };
const later = { access_token: "new-fixture-access", refresh_token: "new-fixture-refresh" };
const pool = (add: Record<string, unknown> = {}) => ({ id: "e78fca", label: "fixture", source: "manual:device_code",
  auth_type: "oauth", priority: 0, request_count: 0, ...pair, ...add });
const withPool = (route: string, ...rows: unknown[]) => ({ version: 1, providers: {}, credential_pool: { [route]: rows } });
const singleton = (route: string, state: unknown) => ({ version: 1, providers: { [route]: state }, active_provider: route });
const codexState = { auth_mode: "chatgpt", tokens: pair };
const minimaxBase = "https://api.minimax.io";
const minState = { provider: minimax, region: "global", portal_base_url: minimaxBase, inference_base_url: `${minimaxBase}/anthropic`,
  client_id: "78257093-7e40-4613-99e0-527b14b39113", expires_at: "2026-05-04T18:00:00+00:00", ...pair };

describe("Hermes Agent native auth store", () => {
  it.each([
    [codex, withPool(codex, pool({ base_url: "https://chatgpt.com/backend-api/codex" }))],
    [xai, withPool(xai, pool({ base_url: "https://api.x.ai/v1" }))],
    [codex, singleton(codex, codexState)],
    [xai, singleton(xai, { auth_mode: "oauth_device_code", tokens: pair })],
    [nous, { ...singleton(nous, { ...pair, client_id: "hermes-cli", portal_base_url: "https://portal.nousresearch.com" }),
      credential_pool: { nous: [pool({ source: "device_code" })] } }],
    [minimax, { ...singleton(minimax, minState), credential_pool: { [minimax]: [pool({ source: "manual:minimax_oauth" })] } }],
    [minimax, { ...singleton(minimax, { ...minState, ...later }), credential_pool: { [minimax]: [pool({ source: "oauth", expires_at_ms: Date.parse("2026-05-04T17:00:00Z") })] } }]
  ])("accepts the pinned %s format in-process and in the embedded predicate", (route, store) => {
    expect(validHermesAuthStore(store, route)).toBe(true);
    const child = spawnSync(process.execPath, ["-e", `const store = JSON.parse(process.argv[1]); process.exit(${hermesAuthValidatorSource}(store, ${JSON.stringify(route)}) ? 0 : 1)`,
      JSON.stringify(store)], { encoding: "utf8" });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
  });

  it.each([
    [codex, {}], [codex, singleton(codex, { auth_mode: "chatgpt", tokens: { refresh_token: pair.refresh_token } })],
    [codex, withPool(codex, pool({ auth_type: "api_key" }))], [xai, withPool(codex, pool())],
    [codex, withPool(codex, pool({ refresh_token: "fixture refresh" }))],
    [codex, withPool(codex, pool({ last_status: "dead" }))],
    [codex, withPool(codex, pool({ base_url: "https://unrelated.invalid" }))],
    [codex, { ...singleton(codex, codexState), credential_pool: { [xai]: [pool()] } }],
    [codex, { ...singleton(codex, codexState), credential_pool: { [codex]: [pool(later)] } }],
    [codex, { ...singleton(codex, codexState), suppressed_sources: { [codex]: ["device_code"] } }],
    [codex, { ...singleton(codex, codexState), active_provider: xai }],
    [codex, withPool(codex, pool(), pool({ id: "foreign-id", ...later }))],
    [minimax, singleton(minimax, { ...minState, portal_base_url: "https://unrelated.invalid" })],
    [nous, singleton(nous, { ...pair, auth_method: "anonymous" })],
    [minimax, withPool(minimax, pool({ source: "manual:minimax_oauth" }))]
  ])("rejects corrupted, wrong or ambiguous %s stores", (route, store) => {
    expect(validHermesAuthStore(store, route)).toBe(false);
  });

  it("checks known account and subject identities before accepting a stale seeded row", () => {
    const jwt = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-org" } })).toString("base64url")}.fixture`;
    const store = singleton(codex, { ...codexState, tokens: { ...pair, access_token: jwt("current-member") } });
    const row = pool({ source: "device_code", ...later, access_token: jwt("different-member") });
    expect(validHermesAuthStore({ ...store, credential_pool: { [codex]: [row] } }, codex)).toBe(false);
    row.access_token = jwt("current-member");
    expect(validHermesAuthStore({ ...store, credential_pool: { [codex]: [row] } }, codex)).toBe(true);
  });
});
