/** Self-contained so the same validator runs when sealing a login and in the runtime image. */
export function validHermesAuthStore(input: unknown, route: string): boolean {
  const helpers = {
    object(value: unknown) {
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
    },
    token(value: unknown): value is string {
      return typeof value === "string" && /^[^\s\x00-\x1f\x7f]+$/u.test(value);
    },
    pair(entry: Record<string, unknown> | undefined) {
      return token(entry?.access_token) && token(entry?.refresh_token);
    },
    claims(value: unknown) {
      if (!token(value)) return undefined;
      const parts = value.split(".");
      if (parts.length !== 3) return undefined;
      try { return object(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))); }
      catch { return undefined; }
    },
    account(entry: Record<string, unknown>) {
      const jwt = claims(entry.access_token);
      const codex = object(jwt?.["https://api.openai.com/auth"]);
      return {
        account: entry.account_id ?? codex?.chatgpt_account_id ?? jwt?.account_id ?? entry.org_id ?? jwt?.org_id,
        subject: entry.user_id ?? jwt?.sub
      };
    },
    allowed(value: unknown, bases: readonly string[]) {
      return value === undefined || value === null ||
        (typeof value === "string" && bases.includes(value.replace(/\/$/u, "")));
    }
  };
  const { object, token, pair, claims, account, allowed } = helpers;
  const urls: Record<string, readonly string[]> = {
    "openai-codex": ["https://chatgpt.com/backend-api/codex"],
    "xai-oauth": ["https://api.x.ai/v1"],
    nous: ["https://inference-api.nousresearch.com/v1"],
    "minimax-oauth": ["https://api.minimax.io/anthropic", "https://api.minimaxi.com/anthropic"]
  };
  const store = object(input);
  const sections = ["version", "updated_at", "active_provider", "providers", "credential_pool", "suppressed_sources"];
  if (!store || !Object.hasOwn(urls, route) || store.version !== 1 ||
      (store.active_provider != null && store.active_provider !== route) ||
      Object.keys(store).some(key => !sections.includes(key))) return false;
  for (const name of ["providers", "credential_pool", "suppressed_sources"]) {
    if (store[name] !== undefined && (!object(store[name]) || Object.keys(store[name]!).some(provider => provider !== route))) return false;
  }
  // Suppression disables the native sources below and can select ambient credentials instead.
  const suppression = object(store.suppressed_sources)?.[route];
  if (suppression !== undefined && (!Array.isArray(suppression) || suppression.length > 0)) return false;
  const rawState = object(store.providers)?.[route];
  const state = object(rawState);
  if (rawState !== undefined && !state) return false;
  const nested = route === "openai-codex" || route === "xai-oauth";
  const tokens = nested ? object(state?.tokens) : state;
  if (state) {
    if (!pair(tokens) || (state.provider !== undefined && state.provider !== route) ||
        !allowed(state.base_url, urls[route]!) || !allowed(state.inference_base_url, urls[route]!)) return false;
    if (nested) {
      const modes = route === "openai-codex" ? ["chatgpt"] : ["oauth_device_code", "oauth_pkce"];
      if (typeof state.auth_mode !== "string" || !modes.includes(state.auth_mode)) return false;
    } else if (route === "nous") {
      if (state.auth_method === "anonymous" || state.anon_token ||
          !allowed(state.portal_base_url, ["https://portal.nousresearch.com", "https://api.nousresearch.com"]) ||
          (state.client_id !== undefined && state.client_id !== "hermes-cli")) return false;
    } else {
      const urlsByRegion = state.region === "global" ? ["https://api.minimax.io", "https://api.minimax.io/anthropic"] :
        state.region === "cn" ? ["https://api.minimaxi.com", "https://api.minimaxi.com/anthropic"] : [];
      if (state.portal_base_url !== urlsByRegion[0] || state.inference_base_url !== urlsByRegion[1] || !urlsByRegion.length ||
          state.client_id !== "78257093-7e40-4613-99e0-527b14b39113" || typeof state.expires_at !== "string" ||
          !Number.isFinite(Date.parse(state.expires_at))) return false;
    }
  }
  const pool = object(store.credential_pool)?.[route];
  if (pool !== undefined && !Array.isArray(pool)) return false;
  const rows = (pool as unknown[] | undefined) ?? [];
  if (!state && (!nested || rows.length !== 1)) return false;
  const sources = route === "openai-codex" ? ["device_code", "manual:device_code", "manual:loopback_pkce"] :
    route === "xai-oauth" ? ["device_code", "manual:device_code"] :
    route === "nous" ? ["device_code"] : ["oauth", "manual:minimax_oauth"];
  const seenSources = new Set();
  const seenIds = new Set();
  for (const value of rows) {
    const row = object(value);
    if (!row || !pair(row) || row.auth_type !== "oauth" || row.last_status === "dead" || !token(row.id) ||
        (row.provider !== undefined && row.provider !== route) || (typeof row.source !== "string" || !sources.includes(row.source)) ||
        seenIds.has(row.id) || seenSources.has(row.source) || !allowed(row.base_url, urls[route]!) ||
        !allowed(row.inference_base_url, urls[route]!)) return false;
    seenSources.add(row.source);
    seenIds.add(row.id);
    if (!tokens) continue;
    const a = account(tokens), b = account(row);
    if ((a.account && b.account && a.account !== b.account) || (a.subject && b.subject && a.subject !== b.subject)) return false;
    if (route === "minimax-oauth" && !allowed(row.base_url, [String(state!.inference_base_url)])) return false;
    if (tokens.refresh_token === row.refresh_token) continue;
    // The pin's reserved rows may lag the singleton while it writes a rotation. A manually
    // added row has a separate refresh path, so it must match the singleton's actual grant.
    if (row.source === "device_code" && a.subject && a.subject === b.subject) continue;
    if (route === "minimax-oauth" && row.source === "oauth" && typeof row.expires_at_ms === "number" &&
        row.expires_at_ms < Date.parse(String(state!.expires_at))) continue;
    return false;
  }
  if (nested && rows.length > 1) return false;
  return true;
}

export const hermesAuthValidatorSource = `(${validHermesAuthStore.toString()})`;
