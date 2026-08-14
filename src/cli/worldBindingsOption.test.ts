import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli, type CliHandlers } from "./runCli.js";

const projectPath = path.resolve("examples/single-agent");
const bindingsPath = "/runner/artifacts/world-bindings.json";
const streams = { stderr: vi.fn(), stdout: vi.fn() };

describe("--world-bindings", () => {
  it("passes the external artifact path through project-mode run", async () => {
    const call = vi.fn(async () => ({}));
    const runProject = call as unknown as CliHandlers["runProject"];
    expect(await runCli(
      ["run", projectPath, "--world-bindings", bindingsPath],
      streams,
      { runProject }
    )).toBe(0);
    expect(call).toHaveBeenCalledWith(projectPath, expect.objectContaining({
      worldBindingsPath: bindingsPath
    }));
  });

  it("rejects the external artifact path alone in project-mode up", async () => {
    const call = vi.fn();
    const upProject = call as unknown as CliHandlers["upProject"];
    const stderr: string[] = [];
    expect(await runCli(
      ["up", projectPath, "--world-bindings", bindingsPath],
      { stderr: (message) => stderr.push(message), stdout: () => undefined },
      { upProject }
    )).toBe(2);
    expect(stderr.join("\n")).toContain(
      "Organization handoff requires --organization-handoff-run-id, --descriptor-digest, --selected-target-receipt, --selected-target-receipt-digest, --network-attachment-handle, and --world-bindings"
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects the source-only artifact flag in image mode", async () => {
    const stderr: string[] = [];
    expect(await runCli(
      ["up", "registry.example/org:tag", "--image", "--world-bindings", bindingsPath],
      { stderr: (message) => stderr.push(message), stdout: () => undefined }
    )).toBe(2);
    expect(stderr.join("\n")).toContain("only supported for project-mode");
  });
});
