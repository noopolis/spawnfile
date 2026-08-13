import { describe, expect, it } from "vitest";

import {
  createCanonicalTargetWorldClockReceiptBytes,
  createTargetWorldClockReceipt,
  parseTargetWorldClockRequest,
  parseTargetWorldClockReceipt,
} from "./worldClock.js";

const d = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const request = () => ({
  activation_digest: d("1"),
  activation_receipt_digest: d("2"),
  descriptor_digest: d("3"),
  endpoint: { internal_port: 4_070, path: "/v1/world/clock" },
  expected: {
    document_version: "world.clock-document.v1",
    world_instance_id: "world-one",
  },
  run_id: "run-one",
  selected_target: {
    fingerprint: `sha256:${"4".repeat(32)}`,
    handle: "opaque_1111111111111111",
  },
  topology_receipt_digest: d("5"),
  topology_request_digest: d("6"),
  version: "spawnfile.target-world-clock.request.v1",
  world_service_handle: "opaque_2222222222222222",
} as const);
const observation = () => ({
  action_count: 0,
  clock: { completed_tick: 1, next_tick: 2, state: "running" as const },
  run_id: "run-one",
  version: "world.clock-document.v1",
  world_instance_id: "world-one",
});

describe("target world-clock public contract", () => {
  it("binds exact observed progress to world, activation, topology, and target", () => {
    const parsedRequest = parseTargetWorldClockRequest(request());
    const receipt = createTargetWorldClockReceipt({ observation: observation(), request: parsedRequest });
    expect(parseTargetWorldClockReceipt(receipt)).toEqual(receipt);
    expect(receipt.clock).toEqual({ completed_tick: 1, next_tick: 2, state: "running" });
    expect(receipt.action_count).toBe(0);
    expect(createCanonicalTargetWorldClockReceiptBytes(receipt)).not.toContain(" ");
  });

  it("rejects a world that never ticked and every stale or forged proof", () => {
    const valid = createTargetWorldClockReceipt({ observation: observation(), request: request() });
    for (const forged of [
      { ...observation(), clock: { completed_tick: 0, next_tick: 1, state: "running" } },
      { ...observation(), action_count: 1 },
      { ...observation(), run_id: "run-stale" },
      { ...observation(), world_instance_id: "world-stale" },
    ]) expect(() => createTargetWorldClockReceipt({ observation: forged, request: request() })).toThrow();
    for (const forged of [
      { ...valid, activation_digest: d("9") },
      { ...valid, topology_receipt_digest: d("9") },
      { ...valid, request_digest: d("9") },
      { ...valid, receipt_digest: d("9") },
      { ...valid, world_service_handle: "opaque_9999999999999999" },
    ]) expect(() => parseTargetWorldClockReceipt(forged)).toThrow();
  });
});
