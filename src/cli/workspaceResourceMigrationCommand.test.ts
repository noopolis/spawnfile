import { describe, expect, it, vi } from "vitest";

import { runWorkspaceResourceMigrationCommand } from "./workspaceResourceMigrationCommand.js";

const receipt = (status: "activated" | "rolled_back") => ({
  version: "spawnfile.workspace-resource-migration.v1" as const,
  active_path: status === "activated" ? "/volume/r28" : "/source/r28",
  destination_path: "/volume/r28",
  manifest_sha256: `sha256:${"a".repeat(64)}` as const,
  rollback: status === "rolled_back",
  source_path: "/source/r28",
  source_retained: true as const,
  status
});
const identity = `sha256:${"b".repeat(64)}`;
const args = ["workspace-resource", "migrate", "/source/r28", "/volume/r28", "--manifest", "/manifest.json", "--resolved-identity", identity, "--source-quiesced", "--json"];

describe("workspace resource migration command", () => {
  it("emits an activated machine receipt", async () => {
    const stdout = vi.fn(); const migrate = vi.fn(async () => receipt("activated"));
    await expect(runWorkspaceResourceMigrationCommand(args, { migrate, stdout })).resolves.toBe(0);
    expect(migrate).toHaveBeenCalledWith({ destinationPath: "/volume/r28", manifestPath: "/manifest.json", resolvedIdentity: identity, sourcePath: "/source/r28", sourceQuiesced: true });
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ source_retained: true, status: "activated" });
  });

  it("returns failure while exposing a recorded rollback", async () => {
    const stdout = vi.fn();
    await expect(runWorkspaceResourceMigrationCommand(args, { migrate: async () => receipt("rolled_back"), stdout })).resolves.toBe(1);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ active_path: "/source/r28", rollback: true, status: "rolled_back" });
  });

  it("fails closed on malformed arguments and migration errors", async () => {
    const stderr = vi.fn();
    await expect(runWorkspaceResourceMigrationCommand(["workspace-resource", "migrate"], { stderr })).resolves.toBe(2);
    await expect(runWorkspaceResourceMigrationCommand(args, { migrate: async () => { throw new Error("preflight failed"); }, stderr })).resolves.toBe(1);
    expect(stderr).toHaveBeenLastCalledWith("preflight failed");
  });
});
