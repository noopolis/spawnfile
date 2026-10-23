import { readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dockerFixture, fixture, image } from "./fixtures.test-helper.js";
import { launchTrainingContainer } from "./launch.js";
import { createTrainingOutputVolume } from "./outputVolume.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const setup = async () => { const f = await fixture(); roots.push(f.root); return f; };
const streams = () => ({ stdout: vi.fn(), stderr: vi.fn() });
const helper = (args: readonly string[], direction: string) => args[2] === "container" && args[3] === "create" && args.includes("--name") && args[args.indexOf("--name") + 1]!.endsWith(`-${direction}`);

it("exports the volume before verifying the host receipt and removes it only after writer closure", async () => {
  const f = await setup();
  const docker = dockerFixture(async args => {
    if (args[2] === "start") {
      // No receipt pre-exists on the host: success depends on a real export.
      await rm(path.join(f.output, "index.json"));
      const volume = [...docker.volumes.values()][0]!;
      await writeFile(path.join(volume.root!, "index.json"), '{"fresh":true}');
    }
    return undefined;
  });
  const result = await launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: streams(), process: docker.process }).catch(error => error);
  expect(result, "host receipt export guarantee").toBe(0);
  expect(await readFile(path.join(f.output, "index.json"), "utf8"), "host receipt export guarantee").toBe('{"fresh":true}');
  const calls = docker.calls, create = calls.find(args => args[2] === "create")!;
  const mount = create.find(value => value.includes("dst=/run/training/output"))!;
  expect(mount).toMatch(/^type=volume,src=spawnfile-training-.+-output,dst=\/run\/training\/output,volume-nocopy$/u);
  expect(create.join(" ")).not.toContain(`type=bind,src=${f.output},dst=/run/training/output`);
  const index = (predicate: (args: string[]) => boolean) => calls.findIndex(predicate);
  expect(index(args => args[2] === "volume" && args[3] === "create")).toBeLessThan(index(args => helper(args, "seed")));
  expect(index(args => helper(args, "seed"))).toBeLessThan(index(args => args[2] === "create"));
  expect(index(args => args[2] === "start")).toBeLessThan(index(args => helper(args, "export")));
  expect(index(args => helper(args, "export"))).toBeLessThan(index(args => args[2] === "volume" && args[3] === "rm"));
  expect(index(args => args[2] === "rm")).toBeLessThan(index(args => args[2] === "volume" && args[3] === "rm"));
  expect(docker.volumes.size).toBe(0);
  for (const args of calls.filter(args => helper(args, "seed") || helper(args, "export"))) {
    expect(args).toContain(image); expect(args).toContain("none"); expect(args).toContain("no-new-privileges");
    expect(args).not.toContain("FSETID"); // Keep the default capability so foreign-group setgid modes survive.
    expect(args).not.toContain("--cap-add"); expect(args).not.toContain("--privileged"); expect(args.join(" ")).not.toContain("docker.sock");
  }
});
it.each(["failure", "throw", "cancel", "signal", "deadline"])("exports after %s with independent cleanup deadlines", async outcome => {
  const f = await setup(), controller = new AbortController();
  const docker = dockerFixture(async (args, options) => {
    if (args[2] === "start") {
      const root = [...docker.volumes.values()][0]!.root!;
      await writeFile(path.join(root, "checkpoint"), outcome);
      if (outcome === "cancel") { controller.abort(); throw Error("cancelled"); }
      if (outcome === "signal") { process.emit("SIGTERM"); throw Error("terminated"); }
      if (outcome === "deadline") await new Promise<void>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(Error("timeout")), { once: true }));
      if (outcome === "throw") throw Error("attach transport failed");
      return { code: 2, stdout: "", stderr: "" };
    }
    if (args[4] === "{{json .State}}") return { code: 0, stdout: '{"Running":false,"ExitCode":2}', stderr: "" };
    return undefined;
  }, async (args, options) => {
    if (helper(args, "export")) { expect(options.signal).toBeUndefined(); expect(options.timeoutMs).toBe(120000); }
    return undefined;
  });
  const pending = launchTrainingContainer({ ...f, image, timeoutMs: outcome === "deadline" ? 100 : 3000, signal: controller.signal, streams: streams(), process: docker.process });
  if (outcome === "throw" || outcome === "deadline") await expect(pending).rejects.toThrow(outcome === "throw" ? "attach transport failed" : "deadline");
  else expect(await pending).toBe(outcome === "failure" ? 2 : 130);
  expect(await readFile(path.join(f.output, "checkpoint"), "utf8")).toBe(outcome);
  if (outcome !== "failure") expect(docker.calls.findIndex(args => args[2] === "rm")).toBeLessThan(docker.calls.findIndex(args => helper(args, "export")));
  expect(docker.volumes.size).toBe(0);
});
it.each([false, true])("seeds the existing tree on resume=%s and removes files deleted in the volume", async resume => {
  const f = await setup(); await writeFile(path.join(f.output, "checkpoint"), "previous");
  const docker = dockerFixture(async args => {
    if (args[2] === "create") {
      const root = [...docker.volumes.values()][0]!.root!;
      expect(await readFile(path.join(root, "checkpoint"), "utf8")).toBe("previous");
      await rm(path.join(root, "checkpoint"));
    }
    return undefined;
  });
  expect(await launchTrainingContainer({ ...f, args: [...f.args, ...(resume ? ["--resume"] : [])], image, timeoutMs: 3000, streams: streams(), process: docker.process })).toBe(0);
  await expect(stat(path.join(f.output, "checkpoint"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(docker.calls.find(args => helper(args, "seed"))!.slice(-2)).toEqual([String(process.getuid!()), String(process.getgid!())]);
});
it("retains the volume and the original host tree with a recovery command when export fails", async () => {
  const f = await setup(), output = streams();
  const docker = dockerFixture(undefined, async args => {
    if (args[2] === "container" && args[3] === "start" && [...docker.helpers.keys()].some(name => name.endsWith("-export"))) return { code: 1, stdout: "", stderr: "copy failed" };
    return undefined;
  });
  await expect(launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: output, process: docker.process })).rejects.toThrow(/retained in Docker volume/u);
  expect(await readFile(path.join(f.output, "index.json"), "utf8")).toBe("{}");
  const name = [...docker.volumes.keys()][0]!;
  expect(name).toMatch(/-output$/u);
  expect(docker.calls.some(args => args[2] === "volume" && args[3] === "rm")).toBe(false);
  expect(output.stderr.mock.calls.flat().join("\n")).toContain(`src=${name},dst=/output,readonly`);
  expect(output.stderr.mock.calls.flat().join("\n")).toContain("Recover with: docker --context desktop-linux");
});
it("refuses foreign volume labels and volume drivers without seeding, export or removal", async () => {
  const f = await setup();
  for (const driver of ["foreign", "local"]) {
    const docker = dockerFixture(undefined, async args => args[2] === "volume" && args[3] === "inspect"
      ? { code: 0, stdout: JSON.stringify({ Name: args[4], Driver: driver, Options: driver === "local" ? { type: "nfs" } : null, Labels: {} }), stderr: "" } : undefined);
    await expect(launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: streams(), process: docker.process })).rejects.toThrow();
    expect(docker.calls.some(args => helper(args, "seed") || helper(args, "export") || args[2] === "create" || (args[2] === "volume" && args[3] === "rm"))).toBe(false);
  }
});
it("cleans a partial seed without launching or replacing host output", async () => {
  const f = await setup();
  const docker = dockerFixture(undefined, async args => args[2] === "container" && args[3] === "start" ? { code: 1, stdout: "", stderr: "seed failed" } : undefined);
  await expect(launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: streams(), process: docker.process })).rejects.toThrow("seed failed");
  expect(docker.calls.some(args => args[2] === "create" || helper(args, "export"))).toBe(false);
  expect(docker.volumes.size).toBe(0);
  expect(await readFile(path.join(f.output, "index.json"), "utf8")).toBe("{}");
});
it("supports only an explicit bind opt-out and rejects misspelled settings before Docker", async () => {
  const f = await setup(), docker = dockerFixture();
  vi.stubEnv("SPAWNFILE_TRAINING_OUTPUT_STORAGE", "bind");
  expect(await launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: streams(), process: docker.process })).toBe(0);
  expect(docker.calls.find(args => args[2] === "create")).toContain(`type=bind,src=${f.output},dst=/run/training/output`);
  expect(docker.calls.some(args => args[2] === "volume")).toBe(false);
  vi.stubEnv("SPAWNFILE_TRAINING_OUTPUT_STORAGE", "off"); const refused = dockerFixture();
  await expect(launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: streams(), process: refused.process })).rejects.toThrow("must be volume or bind");
  expect(refused.calls).toEqual([]);
});
it("removes an ownership-verified volume after a lost create response without starting training", async () => {
  const f = await setup(), docker = dockerFixture();
  const process: typeof docker.process = async (args, options) => {
    const result = await docker.process(args, options);
    if (args[2] === "volume" && args[3] === "create") throw Error("lost volume create response");
    return result;
  };
  await expect(launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: streams(), process })).rejects.toThrow("lost volume create response");
  expect(docker.volumes.size).toBe(0);
  expect(docker.calls.some(args => args[2] === "create" || helper(args, "seed"))).toBe(false);
});
it("retains the volume when helper ownership cannot be verified", async () => {
  const f = await setup(), output = streams();
  const docker = dockerFixture(undefined, async args => {
    if (args[2] === "container" && args[3] === "inspect") {
      const name = args.at(-1)!;
      return { code: 0, stdout: ["d".repeat(64), `/${name}`, image, {}].map(value => JSON.stringify(value)).join("\n"), stderr: "" };
    }
    return undefined;
  });
  await expect(launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: output, process: docker.process })).rejects.toThrow("retained in Docker volume");
  expect(docker.calls.some(args => args[2] === "create" || (args[2] === "volume" && args[3] === "rm") || (args[2] === "container" && args[3] === "rm"))).toBe(false);
  expect(docker.volumes.size).toBe(1);
});
it("stops a running native writer before exporting after cancellation", async () => {
  const f = await setup(), controller = new AbortController(); let running = true;
  const docker = dockerFixture(async args => {
    if (args[2] === "start") { controller.abort(); throw Error("cancelled"); }
    if (args[4] === "{{json .State}}") return { code: 0, stdout: JSON.stringify({ Running: running, ExitCode: 0 }), stderr: "" };
    if (args[2] === "stop") running = false;
    return undefined;
  });
  expect(await launchTrainingContainer({ ...f, image, signal: controller.signal, timeoutMs: 3000, streams: streams(), process: docker.process })).toBe(130);
  expect(running).toBe(false);
  expect(docker.calls.findIndex(args => args[2] === "stop")).toBeLessThan(docker.calls.findIndex(args => helper(args, "export")));
});

it("surfaces bounded seed create stderr while redacting auth sources and tokens", async () => {
  const f = await setup();
  const secretPath = (JSON.parse(await readFile(f.configPath, "utf8"))).auth[0]!.source;
  const docker = dockerFixture(undefined, async args => helper(args, "seed")
    ? { code: 1, stdout: "", stderr: `bind source path does not exist: /missing/input; ${secretPath} TOKEN=opaque-secret ` + "x".repeat(3000) } : undefined);
  const error = await launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: streams(), process: docker.process }).catch(error => error);
  expect(error.message).toContain("bind source path does not exist: /missing/input");
  expect(error.message).not.toContain(secretPath);
  expect(error.message).not.toContain("opaque-secret");
  expect(error.message.length).toBeLessThan(2150);
});

it.each(['seed', 'export'] as const)('redacts canonical and macOS auth aliases from %s diagnostics', async direction => {
  const f = await setup(), output = streams();
  const secret = f.config.auth[0]!.source;
  const alias = secret.startsWith('/private/') ? secret.slice('/private'.length) : `/private${secret}`;
  const docker = dockerFixture(undefined, async args => helper(args, direction)
    ? { code: 1, stdout: '', stderr: `cannot bind ${secret}; alias ${alias}; /unrelated/input` } : undefined);
  const error = await launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: output, process: docker.process }).catch(error => error);
  const diagnostic = `${error.message} ${output.stderr.mock.calls.flat().join(' ')}`;
  expect(diagnostic).toContain('/unrelated/input');
  expect(diagnostic).not.toContain(secret); expect(diagnostic).not.toContain(alias);
  expect(diagnostic).toContain('[auth source]');
});

it('redacts the realpath of a declared auth alias and retains lexical redaction after removal', async () => {
  const f = await setup();
  const canonical = await realpath(f.config.auth[0]!.source), alias = path.join(f.root, 'auth-alias');
  await symlink(canonical, alias);
  for (const removed of [false, true]) {
    if (removed) await rm(alias);
    const volume = createTrainingOutputVolume({ name: 'alias-test', image, host: f.output, scratch: f.root,
      uid: 1000, gid: 1000, runtimeUid: 1000, runtimeGid: 1000, context: 'local', authSources: [alias], stderr: vi.fn(),
      call: async args => args[0] === 'volume'
        ? { code: 0, stdout: args[1] === 'create' ? 'alias-test-output' : JSON.stringify({ Name: 'alias-test-output', Driver: 'local', Labels: { 'com.spawnfile.training.owner': 'alias-test' } }), stderr: '' }
        : args[1] === 'ls' ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: `cannot bind ${alias}; ${removed ? '' : canonical}` },
    });
    const error = await volume.seed().catch(error => error);
    expect(error.message).toContain('cannot bind [auth source]');
    expect(error.message).not.toContain(alias);
    if (!removed) expect(error.message).not.toContain(canonical);
  }
});
