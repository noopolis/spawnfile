import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCanonicalTargetWorldClockReceiptBytes,
  createTargetWorldClockReceipt,
  parseTargetWorldClockRequest,
} from "../target/worldClock.js";
import { registerTargetWorldClockCommand } from "./targetWorldClockCommand.js";

const roots: string[] = [];
const d = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const request = parseTargetWorldClockRequest({
  activation_digest: d("1"), activation_receipt_digest: d("2"),
  descriptor_digest: d("3"), endpoint: { internal_port: 4_070, path: "/v1/world/clock" },
  expected: { document_version: "world.clock-document.v1", world_instance_id: "world-one" },
  run_id: "run-one", selected_target: { fingerprint: `sha256:${"4".repeat(32)}`, handle: "opaque_1111111111111111" },
  topology_receipt_digest: d("5"), topology_request_digest: d("6"),
  version: "spawnfile.target-world-clock.request.v1", world_service_handle: "opaque_2222222222222222",
});
const receipt = createTargetWorldClockReceipt({ request, observation: {
  action_count: 0, clock: { completed_tick: 1, next_tick: 2, state: "running" },
  run_id: "run-one", version: "world.clock-document.v1", world_instance_id: "world-one",
} });
const file = async (value: unknown): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-clock-")); roots.push(root);
  const target = path.join(root, "request.json"); await writeFile(target, JSON.stringify(value)); return target;
};
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

describe("target world clock command", () => {
  it("emits only a verified canonical receipt", async () => {
    const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
    const program = new Command(); program.exitOverride(); const target = program.command("target");
    registerTargetWorldClockCommand(target, { queryWorldClock: async () => receipt }, {
      stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value),
    }, (code) => exits.push(code));
    await program.parseAsync(["target", "query_world_clock", await file(request)], { from: "user" });
    expect(stdout).toEqual([createCanonicalTargetWorldClockReceiptBytes(receipt)]);
    expect(stderr).toEqual([]); expect(exits).toEqual([]);
  });

  it("rejects hostile input and forged handler output without emission", async () => {
    for (const [value, expectedError, code] of [
      [{ ...request, organization: {} }, "error: Invalid world clock request", 2],
      [request, "error: Target world clock query crashed", 1],
    ] as const) {
      const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
      const program = new Command(); program.exitOverride(); const target = program.command("target");
      registerTargetWorldClockCommand(target, {
        queryWorldClock: async () => ({ ...receipt, activation_digest: d("9") }),
      }, { stdout: (item) => stdout.push(item), stderr: (item) => stderr.push(item) },
      (exit) => exits.push(exit));
      await program.parseAsync(["target", "query_world_clock", await file(value)], { from: "user" });
      expect(stdout).toEqual([]); expect(stderr).toEqual([expectedError]); expect(exits).toEqual([code]);
    }
  });
});
