import { beforeEach, expect, it, vi } from "vitest";

import { findTrainingCredentialOperations, loginSubscriptionRealm, requireLiveTraining } from "./trainingSelection.js";
import type { RuntimeTrainingCapability } from "./trainingTypes.js";

const fixture = vi.hoisted(() => ({
  registry: [] as { name: string; training?: RuntimeTrainingCapability }[],
  load: vi.fn()
}));
vi.mock("./registry.js", () => ({ loadRuntimeRegistry: () => fixture.load() }));

beforeEach(() => {
  fixture.registry = [];
  fixture.load.mockReset().mockImplementation(async () => fixture.registry);
});

it("keeps live training optional and refuses a fourth runtime before calling a different runtime", async () => {
  const run = vi.fn(async () => 17);
  fixture.registry = [{ name: "known", training: { run } }, { name: "fixture-fourth" }];
  await expect(requireLiveTraining("fixture-fourth", "agent:writer")).rejects
    .toThrow(/agent:writer runs on fixture-fourth, which has no live training capability/);
  expect(run).not.toHaveBeenCalled();
  await expect((await requireLiveTraining("known", "agent:writer"))({} as never)).resolves.toBe(17);
  expect(run).toHaveBeenCalledOnce();
});

it("routes engine login by capability and rejects ambiguity without credential access", async () => {
  const profile = { name: "test", authHome: "/tmp", env: {}, imports: {}, profileDirectory: "/tmp", profilePath: "/tmp/profile.json", version: 1 } as const;
  const makeLogin = (realmVolume: string) => vi.fn(async () => ({ profile, binding: { realmVolume, unlockVolume: "unlock" }, command: [] }));
  const first = makeLogin("first"), second = makeLogin("second");
  fixture.registry = [
    { name: "fixture-first", training: { login: { supportsEngine: (engine) => engine === "example", run: first } } },
    { name: "fixture-second", training: { login: { supportsEngine: (engine) => engine === "example", run: second } } }
  ];
  const opts = { engine: "example", profileName: "test", dryRun: true };
  await expect(loginSubscriptionRealm(opts)).rejects.toThrow(/matches multiple login runtimes.*--runtime/);
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  await expect(loginSubscriptionRealm({ ...opts, runtime: "fixture-second" })).resolves.toMatchObject({ binding: { realmVolume: "second" } });
  expect(second).toHaveBeenCalledWith(opts);
  await expect(loginSubscriptionRealm({ ...opts, engine: "unknown" })).rejects.toThrow(/no volume-held login/);
});

it("loads only the capability that owns the requested historical credential provider", async () => {
  const stage = vi.fn(async (source: string) => source);
  const other = vi.fn(async () => ({}));
  fixture.registry = [
    { name: "native", training: { credentials: { example: async () => ({ stage }) } } },
    { name: "other", training: { credentials: { other } } }
  ];
  expect(await findTrainingCredentialOperations("example")).toEqual({ stage });
  expect(other).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
});
