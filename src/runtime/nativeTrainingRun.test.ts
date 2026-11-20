import { expect, it, vi } from "vitest";

import { nativeTrainingJudges } from "./nativeTrainingRun.js";
import type { InferenceProviderDescriptor } from "./trainingTypes.js";

it("opens a configured judge host once on demand and closes it after both requests", async () => {
  const close = vi.fn(async () => {});
  const openJudges = vi.fn(async () => ({ close }));
  const generate = vi.fn(async () => { throw Error("Recorded provider response"); });
  const descriptor: InferenceProviderDescriptor = {
    policyVersion: "1", capabilities: {}, validate() {},
    create: () => ({ id: "judge", capabilities: { tools: "disabled", billing: "local", temperature: false, seed: false }, generate })
  };
  const composition = { registry: { defaultProviderId: "judge", providers: { judge: descriptor } },
    owners: new Map([["judge", { name: "host", training: { openJudges } }]]) };
  const streams = { stdout() {}, stderr() {} };
  const request = { model: "fixture", prompt: "grade" };
  for (const authProfile of [undefined, "local-profile"]) {
    const host = nativeTrainingJudges(composition, { streams, authProfile }, "out");
    const judge = host.registry.providers.judge!.create({ provider: "judge", model: "fixture" },
      { purpose: "judge", timeoutMs: 500, resources: new Map(), onClose() {} });
    expect(openJudges).not.toHaveBeenCalled();
    if (!authProfile) {
      await expect(judge.generate(request)).rejects.toThrow("auth-profile");
      expect(generate).not.toHaveBeenCalled();
    } else {
      const attempts = await Promise.allSettled([judge.generate(request), judge.generate(request)]);
      expect(attempts.every(attempt => attempt.status === "rejected" && attempt.reason.message === "Recorded provider response")).toBe(true);
      expect(openJudges).toHaveBeenCalledOnce();
      expect(generate).toHaveBeenCalledTimes(2);
    }
    await host.close();
  }
  expect(close).toHaveBeenCalledOnce();
});
