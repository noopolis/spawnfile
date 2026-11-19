import { expect, it, vi } from "vitest";

import type { RuntimeTrainingRegistration } from "../runtime/trainingSelection.js";
import type { RegradeTrainingOptions } from "../runtime/trainingRegrade.js";
import { runTrainingRegrade } from "./trainingRegrade.js";

const fixture = vi.hoisted(() => ({
  owners: new Map<string, RuntimeTrainingRegistration>(),
  providers: [] as string[]
}));
vi.mock("../runtime/trainingRegrade.js", () => ({
  regradeTraining: async ({ openJudges }: RegradeTrainingOptions) => {
    const run = await openJudges?.(fixture.providers, {
      owners: fixture.owners, registry: { defaultProviderId: "neutral", providers: {} }
    });
    await run?.close();
    return 17;
  }
}));

const opts = {
  manifest: "manifest.json", out: "results", authProfile: "training",
  streams: { stdout: vi.fn(), stderr: vi.fn() }
};

it("opens only the runtime that owns a declared judge provider, leaving neutral providers independent", async () => {
  const close = vi.fn(async () => undefined);
  const openJudges = vi.fn(async () => ({ close }));
  fixture.owners = new Map([["fixture-judge", { name: "fixture-fourth", training: { openJudges } }]]);
  fixture.providers = ["neutral"];
  await expect(runTrainingRegrade(opts)).resolves.toBe(17);
  expect(openJudges).not.toHaveBeenCalled();
  fixture.providers.push("fixture-judge");
  await expect(runTrainingRegrade(opts)).resolves.toBe(17);
  expect(openJudges).toHaveBeenCalledExactlyOnceWith({ authProfile: "training", out: "results", streams: opts.streams, signal: undefined });
  expect(close).toHaveBeenCalledOnce();
});

it("refuses ambiguous hosted judges before acquiring any runtime profile lock", async () => {
  const openJudges = vi.fn(async () => ({ close: async () => undefined }));
  fixture.owners = new Map([
    ["first", { name: "fixture-one", training: { openJudges } }],
    ["second", { name: "fixture-two", training: { openJudges } }]
  ]);
  fixture.providers = ["first", "second"];
  await expect(runTrainingRegrade(opts)).rejects.toThrow(/multiple runtime hosts: fixture-one, fixture-two/);
  expect(openJudges).not.toHaveBeenCalled();
});
