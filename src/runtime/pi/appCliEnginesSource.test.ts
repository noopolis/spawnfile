import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { renderPiCliEnginesSource } from "./appCliEnginesSource.js";

/**
 * Coverage for the `scripted` engine branch added to the generated pi
 * runtime's `runCliEngine` (Slice B, Piece 5 step 1). This module has no
 * imports of its own — it is a `String.raw` template concatenated onto the
 * rest of the generated `app.mjs` (see `appSource.ts`), so every helper it
 * calls (`path`, `mkdir`, `writeFile`, `unlink`, `execFileAsync`,
 * `cliOutputOptions`, `appendFileSync`) is supplied as a `vm` context global
 * here, mirroring `appCliSource.test.ts`'s own harness pattern. Unused
 * helpers (the other engines' own dependencies) are stubbed to throw if
 * ever called, proving the scripted branch never touches them.
 */

interface CliEnginesHarness {
  runCliEngine: (
    engine: string,
    prompt: string,
    paths: Record<string, string>,
    config?: Record<string, unknown>
  ) => Promise<{ durationMs: number; text: string }>;
}

interface HarnessMocks {
  appendFileSync: ReturnType<typeof vi.fn>;
  execFileAsync: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
}

const unreachable = (name: string) =>
  vi.fn(async () => {
    throw new Error(`${name} should not be called by the scripted engine branch`);
  });

const createHarnessMocks = (overrides: Partial<HarnessMocks> = {}): HarnessMocks => ({
  appendFileSync: vi.fn(),
  execFileAsync: vi.fn(async () => ({ stderr: "", stdout: "canned reply\n" })),
  mkdir: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  ...overrides
});

const loadCliEnginesHarness = (mocks: HarnessMocks): CliEnginesHarness => {
  const harnessSource = [
    renderPiCliEnginesSource(),
    "({ runCliEngine });"
  ].join("\n");

  return runInNewContext(harnessSource, {
    appendFileSync: mocks.appendFileSync,
    cliOutputOptions: { maxBuffer: 1024 * 1024, timeout: 5000 },
    copyDirectoryIfExists: unreachable("copyDirectoryIfExists"),
    createEngineEnv: unreachable("createEngineEnv"),
    execFileAsync: mocks.execFileAsync,
    getSharedGrokHome: unreachable("getSharedGrokHome"),
    mkdir: mocks.mkdir,
    path,
    process: { env: {} },
    readBounded: unreachable("readBounded"),
    readFile: unreachable("readFile"),
    cleanCliFinalText: (value: string) => value.trim(),
    stripAnsi: (value: string) => value,
    spawnToFiles: unreachable("spawnToFiles"),
    spawnWithInput: unreachable("spawnWithInput"),
    unlink: mocks.unlink,
    writeFile: mocks.writeFile
  }) as CliEnginesHarness;
};

const createPaths = () => ({
  homePath: "/tmp/scripted-engine-test/home",
  runtimeHomePath: "/tmp/scripted-engine-test/runtime/agents/eleanor",
  workspacePath: "/tmp/scripted-engine-test/workspace/agents/eleanor"
});

describe("runCliEngine scripted branch", () => {
  it("execs the staged script under node with the pinned --prompt-file/--cwd argv contract and returns trimmed stdout", async () => {
    const mocks = createHarnessMocks();
    const { runCliEngine } = loadCliEnginesHarness(mocks);
    const paths = createPaths();
    const config = { engine_command: "engine/office-engine.mjs", id: "agent:eleanor" };

    const result = await runCliEngine("scripted", "hello there", paths, config);

    expect(result.text).toBe("canned reply");
    expect(typeof result.durationMs).toBe("number");

    expect(mocks.execFileAsync).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.execFileAsync.mock.calls[0];
    expect(command).toBe("node");
    expect(args[0]).toBe(path.join(paths.workspacePath, "engine/office-engine.mjs"));
    expect(args.slice(1)).toEqual([
      "--prompt-file",
      args[2],
      "--cwd",
      paths.workspacePath
    ]);
    expect(options).toMatchObject({ cwd: paths.workspacePath });

    // The prompt is written to the exact path passed as --prompt-file.
    expect(mocks.writeFile).toHaveBeenCalledWith(args[2], "hello there");
    expect(mocks.mkdir).toHaveBeenCalledWith(paths.runtimeHomePath, { recursive: true });
    expect(mocks.unlink).toHaveBeenCalledWith(args[2]);
  });

  it("appends a call-log entry next to the agent's telemetry dir (runtimeHomePath), not a host bind-mount env var", async () => {
    const mocks = createHarnessMocks();
    const { runCliEngine } = loadCliEnginesHarness(mocks);
    const paths = createPaths();
    const config = { engine_command: "engine/office-engine.mjs", id: "agent:eleanor" };

    await runCliEngine("scripted", "hello there", paths, config);

    expect(mocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = mocks.appendFileSync.mock.calls[0];
    expect(logPath).toBe(path.join(paths.runtimeHomePath, "scripted-engine-calls.jsonl"));
    const parsed = JSON.parse((logLine as string).trim());
    expect(parsed.script).toBe(path.join(paths.workspacePath, "engine/office-engine.mjs"));
    expect(parsed.args).toContain("--prompt-file");
    expect(parsed.args).toContain("--cwd");
  });

  it("throws a clear error when config.engine_command is missing", async () => {
    const mocks = createHarnessMocks();
    const { runCliEngine } = loadCliEnginesHarness(mocks);
    const paths = createPaths();

    await expect(runCliEngine("scripted", "hello", paths, { id: "agent:eleanor" })).rejects.toThrow(
      /engine_command/
    );
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it("still unlinks the prompt file when the script exits non-zero", async () => {
    const mocks = createHarnessMocks({
      execFileAsync: vi.fn(async () => {
        throw new Error("office-engine.mjs exited 1");
      })
    });
    const { runCliEngine } = loadCliEnginesHarness(mocks);
    const paths = createPaths();
    const config = { engine_command: "engine/office-engine.mjs", id: "agent:eleanor" };

    await expect(runCliEngine("scripted", "hello", paths, config)).rejects.toThrow("exited 1");
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.appendFileSync).not.toHaveBeenCalled();
  });
});
