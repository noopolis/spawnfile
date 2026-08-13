import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { checkAntigravityAuth, checkGrokAuth } from "./preflightCliTokenCheckers.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-preflight-token-checkers-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await removeDirectory(directory);
  }
});

describe("checkGrokAuth", () => {
  it("fails when the auth file is missing", async () => {
    const home = await createTempDirectory();

    const result = await checkGrokAuth(path.join(home, ".grok"));

    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("missing");
  });

  it("fails on invalid JSON", async () => {
    const home = await createTempDirectory();
    await ensureDirectory(path.join(home, ".grok"));
    await writeUtf8File(path.join(home, ".grok", "auth.json"), "{not json");

    const result = await checkGrokAuth(path.join(home, ".grok"));

    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("invalid JSON");
  });

  it("fails when no auth.x.ai token entry is present", async () => {
    const home = await createTempDirectory();
    await ensureDirectory(path.join(home, ".grok"));
    await writeUtf8File(path.join(home, ".grok", "auth.json"), JSON.stringify({ other: {} }));

    const result = await checkGrokAuth(path.join(home, ".grok"));

    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("no auth.x.ai token entry");
  });

  it("fails and recommends `grok login` when the token is expired", async () => {
    const home = await createTempDirectory();
    await ensureDirectory(path.join(home, ".grok"));
    await writeUtf8File(
      path.join(home, ".grok", "auth.json"),
      JSON.stringify({
        "https://auth.x.ai::22222222-2222-2222-2222-222222222222": {
          expires_at: "2020-01-01T00:00:00.000Z"
        }
      })
    );

    const result = await checkGrokAuth(path.join(home, ".grok"));

    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("expired");
    expect(result.reason).toContain("grok login");
  });

  it("passes when the token has not expired", async () => {
    const home = await createTempDirectory();
    await ensureDirectory(path.join(home, ".grok"));
    await writeUtf8File(
      path.join(home, ".grok", "auth.json"),
      JSON.stringify({
        "https://auth.x.ai::33333333-3333-3333-3333-333333333333": {
          expires_at: "2099-01-01T00:00:00.000Z"
        }
      })
    );

    const result = await checkGrokAuth(path.join(home, ".grok"));

    expect(result.status).toBe("passed");
  });
});

describe("checkAntigravityAuth", () => {
  it("fails when the token file is missing", async () => {
    const home = await createTempDirectory();

    const result = await checkAntigravityAuth(path.join(home, ".gemini", "antigravity-cli"));

    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("run the antigravity CLI login");
  });

  it("fails on a corrupt token file", async () => {
    const home = await createTempDirectory();
    const cliHome = path.join(home, ".gemini", "antigravity-cli");
    await ensureDirectory(cliHome);
    await writeUtf8File(path.join(cliHome, "antigravity-oauth-token"), "{not json");

    const result = await checkAntigravityAuth(cliHome);

    expect(result.status).toBe("unavailable");
  });

  it("fails when the token object has no refresh token", async () => {
    const home = await createTempDirectory();
    const cliHome = path.join(home, ".gemini", "antigravity-cli");
    await ensureDirectory(cliHome);
    await writeUtf8File(
      path.join(cliHome, "antigravity-oauth-token"),
      JSON.stringify({ auth_method: "consumer", token: { access_token: "abc" } })
    );

    const result = await checkAntigravityAuth(cliHome);

    expect(result.status).toBe("unavailable");
  });

  it("passes on an expired access token as long as a refresh token is present (agy auto-refreshes)", async () => {
    const home = await createTempDirectory();
    const cliHome = path.join(home, ".gemini", "antigravity-cli");
    await ensureDirectory(cliHome);
    await writeUtf8File(
      path.join(cliHome, "antigravity-oauth-token"),
      JSON.stringify({
        auth_method: "consumer",
        token: {
          access_token: "expired-access-token",
          expiry: "2020-01-01T00:00:00.000Z",
          refresh_token: "still-valid-refresh-token",
          token_type: "Bearer"
        }
      })
    );

    const result = await checkAntigravityAuth(cliHome);

    expect(result.status).toBe("passed");
  });
});
