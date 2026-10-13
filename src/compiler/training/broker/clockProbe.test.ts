import { expect, it, vi } from "vitest";
import { probeTrainingSiblingClock } from "./clockProbe.js";
import { trainingSlotPaths } from "./paths.js";

it("requires a positive sandbox denial and preserves access to the own clock", async () => {
  const run = vi.fn().mockResolvedValue({ stdout: "denied\n" });
  expect(await probeTrainingSiblingClock(2, trainingSlotPaths(1).clockDirectory, run)).toBe(true);
  const [command, args] = run.mock.calls[0]!;
  expect(command).toBe("setpriv");
  expect(args).toContain("--reuid=2202");
  const script = args.at(-1);
  expect(script).toContain('bwrap --die-with-parent --cap-drop ALL --ro-bind / / --ro-bind "$blocked"');
  expect(script).toContain(trainingSlotPaths(1).clockDirectory);
  expect(script.match(new RegExp(trainingSlotPaths(2).clockFile, "g"))).toHaveLength(2);
  expect(script).toContain('chmod 000 "$blocked"');
  run.mockResolvedValue({ stdout: "reachable\n" });
  expect(await probeTrainingSiblingClock(2, trainingSlotPaths(1).clockDirectory, run)).toBe(false);
  run.mockResolvedValue({ stdout: "" });
  await expect(probeTrainingSiblingClock(2, trainingSlotPaths(1).clockDirectory, run)).rejects.toThrow(/no verified verdict/);
  run.mockRejectedValue(new Error("namespace unavailable"));
  await expect(probeTrainingSiblingClock(2, trainingSlotPaths(1).clockDirectory, run)).rejects.toThrow(/namespace unavailable/);
});
