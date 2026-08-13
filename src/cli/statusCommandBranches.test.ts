import { describe, expect, it, vi } from "vitest";

import type { OrganizationView } from "../compiler/index.js";

import { executeStatusCommand, executeStatusWatch } from "./statusCommand.js";

const createView = (): OrganizationView => ({
  contexts: [],
  diagnostics: [],
  inputPath: "/tmp/Spawnfile",
  networks: [],
  projectRoot: "/tmp",
  root: {
    children: [],
    displayName: "assistant",
    id: "agent:assistant",
    kind: "agent",
    name: "assistant",
    runtimeName: "pi",
    slug: "assistant",
    source: "/tmp/Spawnfile"
  },
  runtimes: [{ name: "pi", nodeIds: ["agent:assistant"] }]
});

describe("status command branch contracts", () => {
  it("returns the selector failure before reading a compile report", async () => {
    const buildOrganizationView = vi.fn(async () => createView());
    await expect(executeStatusCommand(
      "/tmp/Spawnfile",
      { agent: "missing" },
      { buildOrganizationView }
    )).resolves.toMatchObject({
      error: expect.stringContaining("Unknown agent"),
      exitCode: 2
    });
    expect(buildOrganizationView).toHaveBeenCalledOnce();
  });

  it("uses default watch timing while stopping immediately on input failure", async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const setExitCode = vi.fn();
    await executeStatusWatch(
      "/tmp/Spawnfile",
      { logs: true },
      { buildOrganizationView: vi.fn(async () => createView()) },
      {
        stderr: (message) => stderr.push(message),
        stdout: (message) => stdout.push(message)
      },
      setExitCode,
      { iterations: 1 }
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(stderr).toEqual(["error: status --logs requires --live"]);
    expect(stdout).toEqual([]);
  });
});
