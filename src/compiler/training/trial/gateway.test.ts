import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import type { TrialEvidenceInput } from "./evidence.js";

vi.mock("../../../runtime/daimon/runAuth.js", () => ({ assertSafeDaimonSourceFile: async () => undefined }));
vi.mock("../../../target/dockerCommandExecutor.js", () => ({ createDockerTargetExecutors: () => ({ resource: {} }) }));
vi.mock("../../../target/dockerResources.js", () => ({ removeExactDockerResource: async () => undefined }));
vi.mock("../../../target/dockerResourcesProvider.js", () => ({
  createDockerResourceSpec: () => ({ args: [], name: "run-net" }), executeDockerResource: async () => undefined
}));

const { startTrainingGateway } = await import("./gateway.js");

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-gateway-evidence-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const profile = { authHome: "/nonexistent", env: {}, imports: { codex: { path: "/nonexistent/codex" } }, name: "training",
  profileDirectory: "/nonexistent", profilePath: "/nonexistent/p.json", version: 1 } as unknown as ResolvedAuthProfile;

/** One gateway whose Docker calls and evidence captures land in one ordered list. */
const start = async (running: () => string) => {
  const order: string[] = [];
  const captured: TrialEvidenceInput[] = [];
  const docker = async (args: readonly string[]): Promise<string> => {
    order.push(args.slice(0, 2).join(" "));
    if (args[0] === "context") return "default";
    if (args[0] === "inspect") return running();
    if (args[0] === "logs") return "gateway: realm is held by another gateway";
    return "";
  };
  const gateway = startTrainingGateway({ authProfile: profile, docker, engines: ["codex"], image: "image", runId: "run-1", runtimeRoot: "/opt/runtime",
    readyTimeoutMs: 1_000, evidenceDirectory: path.join(root, "gateway"),
    evidence: async (input) => { order.push("evidence"); captured.push(input); return { version: "spawnfile.training.trial-evidence.v1", container: input.container, capturedAt: "", captures: [], refused: [] }; } });
  return { captured, gateway, order };
};

it("keeps the sidecar's log before every removal, with its key masked: restart, then stop", async () => {
  const { captured, gateway, order } = await start(() => "true");
  const started = await gateway;
  await started.restart();
  await started.stop();
  const removals = order.map((call, index) => call === "rm -f" ? order.slice(index - 2, index + 1) : []).filter((calls) => calls.length);
  expect(removals).toEqual([["stop --time", "evidence", "rm -f"], ["stop --time", "evidence", "rm -f"]]);
  expect(captured.map((input) => path.relative(root, input.directory))).toEqual([path.join("gateway", "capture-1"), path.join("gateway", "capture-2")]);
  expect(captured[0]).toMatchObject({ container: started.container, secrets: [started.key] });
});

it("keeps the log of a sidecar that never became ready and names its last words in the error", async () => {
  // The login realm admits one gateway: a second run's sidecar exits at once, and that was only ever "unavailable".
  const { captured, gateway, order } = await start(() => "false");
  await expect(gateway).rejects.toThrow("training auth gateway exited before readiness: gateway: realm is held by another gateway");
  expect(order.slice(order.indexOf("stop --time"))).toEqual(["stop --time", "evidence", "rm -f", "network rm"]);
  expect(captured).toHaveLength(1);
});
