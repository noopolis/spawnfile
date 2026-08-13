import path from "node:path";

import { fileExists, readUtf8File } from "../filesystem/index.js";
import { CHECK_IDS, type B18PreflightCheck, type JsonObject } from "./preflightTypes.js";
import { createCheck, FAIL, isNonEmptyString, parseJson, PASS } from "./preflightCheckers.js";

// grok's auth store keys its token entry by provider URL, e.g.
// `https://auth.x.ai::<uuid>`. Matching by prefix (rather than requiring the
// full key shape) keeps this resilient to the uuid suffix varying per login.
const GROK_TOKEN_KEY_PATTERN = /^https:\/\/auth\.x\.ai::/u;

const findGrokTokenEntry = (parsed: JsonObject): JsonObject | undefined => {
  for (const [key, value] of Object.entries(parsed)) {
    if (GROK_TOKEN_KEY_PATTERN.test(key) && value && typeof value === "object") {
      return value as JsonObject;
    }
  }
  return undefined;
};

/** Unlike a bare directory-existence check, this deep-checks the grok CLI's
 * `auth.json` the same way `checkCodexAuth` (preflightCheckers.ts)
 * deep-checks codex: a present-but-expired token still passes a
 * directory-existence check yet fails to authenticate, and the grok CLI
 * silently drops to an interactive login inside a container instead of
 * erroring — hanging the run for minutes. grok's refresh is server-rejected
 * once the token is fully expired, so an expired `expires_at` is treated as
 * a hard failure here, not a soft/refreshable warning. */
export const checkGrokAuth = async (grokHomePath: string): Promise<B18PreflightCheck> => {
  const name = "Grok auth";
  const authFilePath = path.join(grokHomePath, "auth.json");
  if (!(await fileExists(authFilePath))) {
    return createCheck(
      FAIL,
      CHECK_IDS.grokAuth,
      name,
      `Grok auth file is missing at ${authFilePath} — run \`grok login\``
    );
  }
  const parsed = parseJson<JsonObject>(await readUtf8File(authFilePath));
  if (!parsed) {
    return createCheck(
      FAIL,
      CHECK_IDS.grokAuth,
      name,
      `Grok auth file exists at ${authFilePath} but has invalid JSON`
    );
  }
  const tokenEntry = findGrokTokenEntry(parsed);
  if (!tokenEntry) {
    return createCheck(
      FAIL,
      CHECK_IDS.grokAuth,
      name,
      `Grok auth file exists at ${authFilePath} but has no auth.x.ai token entry — run \`grok login\``
    );
  }
  const expiresAt = tokenEntry.expires_at;
  if (!isNonEmptyString(expiresAt)) {
    return createCheck(
      FAIL,
      CHECK_IDS.grokAuth,
      name,
      `Grok auth token entry at ${authFilePath} is missing an expires_at field — run \`grok login\``
    );
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return createCheck(
      FAIL,
      CHECK_IDS.grokAuth,
      name,
      `Grok auth token expires_at "${expiresAt}" at ${authFilePath} is not a valid ISO-8601 timestamp`
    );
  }
  if (expiresAtMs <= Date.now()) {
    return createCheck(
      FAIL,
      CHECK_IDS.grokAuth,
      name,
      `Grok auth token expired at ${expiresAt} — run \`grok login\``
    );
  }
  return createCheck(
    PASS,
    CHECK_IDS.grokAuth,
    name,
    `Grok auth token is present and valid until ${expiresAt}`
  );
};

/** antigravity's CLI token store (`antigravity-oauth-token`, live shape
 * `{ token: { access_token, refresh_token, token_type, expiry }, auth_method }`)
 * auto-refreshes an expired access token via its own refresh token — verified
 * live, where an expired access token still refreshed successfully on use.
 * So (unlike grok) an expired/near-expired token is NOT treated as a
 * failure here; only a missing file, unparsable JSON, or a token object
 * missing its access/refresh fields counts as unavailable, since only those
 * cases leave the CLI unable to recover on its own. */
export const checkAntigravityAuth = async (antigravityCliHomePath: string): Promise<B18PreflightCheck> => {
  const name = "Antigravity auth";
  const tokenFilePath = path.join(antigravityCliHomePath, "antigravity-oauth-token");
  const remediation = `Antigravity auth missing at ${tokenFilePath} — run the antigravity CLI login`;
  if (!(await fileExists(tokenFilePath))) {
    return createCheck(FAIL, CHECK_IDS.antigravityAuth, name, remediation);
  }
  const parsed = parseJson<JsonObject>(await readUtf8File(tokenFilePath));
  const token = parsed && typeof parsed.token === "object" && parsed.token !== null
    ? (parsed.token as JsonObject)
    : undefined;
  if (!token || !isNonEmptyString(token.access_token) || !isNonEmptyString(token.refresh_token)) {
    return createCheck(FAIL, CHECK_IDS.antigravityAuth, name, remediation);
  }
  return createCheck(
    PASS,
    CHECK_IDS.antigravityAuth,
    name,
    `Antigravity auth token file is present at ${tokenFilePath}`
  );
};
