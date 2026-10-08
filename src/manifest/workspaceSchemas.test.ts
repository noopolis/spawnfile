import { describe, expect, it } from "vitest";

import { teamWorkspaceSchema } from "./workspaceSchemas.js";
import { orderWorkspace } from "./renderSpawnfileWorkspace.js";

const gitResource = (fields: Record<string, unknown>) => teamWorkspaceSchema.safeParse({
  resources: [{ branch: "edition/2026-10-08", id: "private-source", kind: "git", mode: "readonly", mount: "./repos/private-source", url: "git@github.com:example/private.git", ...fields }]
});
const messages = (fields: Record<string, unknown>): string[] => gitResource(fields).error?.issues.map((issue) => issue.message) ?? [];

describe("fetch: build git resources", () => {
  it("accepts a build-pinned private repo with a key path or a key env", () => {
    expect(gitResource({ auth: { ssh_key: "~/.ssh/deploy_key" }, fetch: "build" }).success).toBe(true);
    expect(gitResource({ auth: { ssh_key_env: "PRIVATE_DEPLOY_KEY" }, exclude: ["**/*.tmp"], fetch: "build" }).success).toBe(true);
    expect(gitResource({ fetch: "start", mode: "mutable" }).success).toBe(true);
  });

  it("requires readonly, credential-free urls, and exactly one auth source", () => {
    expect(messages({ fetch: "build", mode: "mutable" })).toEqual([expect.stringContaining("must be mode: readonly")]);
    expect(messages({ fetch: "build", url: "https://user:token@example.com/private.git" })).toEqual([expect.stringContaining("must not embed a credential")]);
    expect(messages({ fetch: "build", url: "https://TOKEN@example.com/private.git" })).toEqual([expect.stringContaining("must not embed a credential")]);
    expect(messages({ fetch: "build", url: "https://example.com/private.git?access_token=TOKEN" })).toEqual([expect.stringContaining("must not embed a credential")]);
    expect(messages({ fetch: "build", url: "ssh://git:secret@example.com/private.git" })).toEqual([expect.stringContaining("must not embed a credential")]);
    expect(gitResource({ fetch: "build", url: "ssh://git@example.com/private.git" }).success).toBe(true);
    expect(gitResource({ fetch: "build", url: "https://example.com/private.git" }).success).toBe(true);
    expect(messages({ branch: undefined, fetch: "build", ref: "  " })).toEqual([expect.stringContaining("must not be empty")]);
    expect(messages({ auth: {}, fetch: "build" })).toEqual([expect.stringContaining("exactly one of ssh_key or ssh_key_env")]);
    expect(messages({ auth: { ssh_key: "k", ssh_key_env: "K" }, fetch: "build" })).toEqual([expect.stringContaining("exactly one of ssh_key or ssh_key_env")]);
    expect(gitResource({ auth: { ssh_key_env: "not a name" }, fetch: "build" }).success).toBe(false);
  });

  it("refuses auth and exclude on a container-start clone", () => {
    expect(messages({ auth: { ssh_key: "k" } })).toEqual([expect.stringContaining("auth requires fetch: build")]);
    expect(messages({ exclude: ["x"], fetch: "start" })).toEqual([expect.stringContaining("exclude requires fetch: build")]);
  });

  it("renders the new fields back in declaration order", () => {
    const parsed = gitResource({ auth: { ssh_key_env: "PRIVATE_DEPLOY_KEY" }, exclude: ["tmp"], fetch: "build" });
    expect(Object.keys((orderWorkspace(parsed.data)!.resources![0]) as object)).toEqual(["id", "kind", "url", "branch", "fetch", "auth", "exclude", "mount", "mode"]);
  });
});
