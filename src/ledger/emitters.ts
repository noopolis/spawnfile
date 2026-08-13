import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConformanceFixtureSource, ConformanceIssue } from "./conformance.js";
import { parseCausalJsonl } from "@noopolis/stele";

/**
 * Normalized invocation contract for the four real Noopolis causal fixture
 * emitters (B92, §2). `command` is a direct argv (never a shell string, never
 * `npm run` — the npm banner would pollute stdout-jsonl output), resolved
 * relative to `cwd`. `output` distinguishes emitters that print JSONL
 * directly to stdout from daimon, which prints the absolute path of a JSONL
 * file it wrote as the last stdout line.
 */
export interface EmitterSpec {
  command: string[];
  cwd: string;
  name: string;
  output: "path-line" | "stdout-jsonl";
}

/** run_id every emitter is invoked with. Sourced from NOOPOLIS_RUN_ID, never model output. */
export const EMITTER_RUN_ID = "b92-conformance";

/** Per-emitter kill timeout. `go run` pays a compile cost on a cold module cache. */
const EMITTER_TIMEOUT_MS = 120_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/ledger -> src -> <repo root>
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const ecosystemPath = (name: string): string => path.resolve(ROOT_DIR, "ecosystem", name);

/**
 * The four real sibling fixture emitters, invoked by path (never `npm run`).
 * See B92 packet §1-§2 and each sibling's own runtime/observability AGENTS.md
 * for what each emitter does.
 */
export const EMITTER_SPECS: EmitterSpec[] = [
  {
    command: ["node_modules/.bin/tsx", "src/runtime/emit-causal-fixture.ts"],
    cwd: ecosystemPath("simfile"),
    name: "simfile",
    output: "stdout-jsonl"
  },
  {
    command: ["node_modules/.bin/tsx", "scripts/emit-causal-fixture.ts"],
    cwd: ecosystemPath("mneme"),
    name: "mneme",
    output: "stdout-jsonl"
  },
  {
    command: ["node_modules/.bin/tsx", "src/observability/emitCausalFixture.ts"],
    cwd: ecosystemPath("daimon"),
    name: "daimon",
    output: "path-line"
  },
  {
    command: ["go", "run", "./cmd/emit-causal-fixture"],
    cwd: ecosystemPath("moltnet"),
    name: "moltnet",
    output: "stdout-jsonl"
  }
];

/**
 * Builds the adversarial "spoof mode" variant of an `EmitterSpec` (B62
 * enforcement point #4): the sibling fixture emitter is asked to embed a
 * forged/claimed identity in its fixture's input or output content, while
 * still stamping `principal_id` as its own authenticated identity — never
 * the claimed one. `--spoof` is the flag convention daimon's own fixture
 * emitter already understands (`npm run emit-causal-fixture:spoof`, see
 * `ecosystem/daimon/src/observability/emitCausalFixture.ts`); this helper
 * applies the same convention uniformly across all four `EmitterSpec`s so a
 * future caller does not need one-off spoof plumbing per sibling.
 *
 * `EMITTER_SPOOF_SPECS` is deliberately NOT part of the default real-mode
 * `EMITTER_SPECS` list `causalConformanceCli.ts` invokes: today only
 * daimon's real fixture script understands `--spoof` (simfile/mneme/moltnet
 * have not yet added a spoof-capable fixture variant), so spawning the
 * other three with an unrecognized flag would break the hermetic real-mode
 * run. `EMITTER_SPOOF_SPECS` exists for callers — and this file's own
 * injected-exec tests — that want to exercise spoof-mode collection
 * explicitly, and is the shape every sibling's real spoof script should
 * match once added.
 */
export const toSpoofEmitterSpec = (spec: EmitterSpec): EmitterSpec => ({
  ...spec,
  command: [...spec.command, "--spoof"],
  name: `${spec.name}-spoof`
});

/** The adversarial "spoof mode" counterpart to `EMITTER_SPECS` — see `toSpoofEmitterSpec`. */
export const EMITTER_SPOOF_SPECS: EmitterSpec[] = EMITTER_SPECS.map(toSpoofEmitterSpec);

export interface ExecResult {
  exitCode: number | null;
  spawnError?: Error;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

/** Injectable process runner. `realExec` is the only implementation that actually spawns a process. */
export type Exec = (spec: EmitterSpec) => Promise<ExecResult>;

/**
 * Spawns `spec.command` directly (no shell) in `spec.cwd`, with stdout and
 * stderr captured separately so stderr noise (npm banners, SQLite
 * ExperimentalWarning, etc.) never corrupts stdout-jsonl parsing. Kills the
 * child on `EMITTER_TIMEOUT_MS` expiry.
 */
export const realExec: Exec = (spec) =>
  new Promise((resolve) => {
    const [command, ...args] = spec.command;
    if (!command) {
      resolve({ exitCode: null, spawnError: new Error("empty command"), stderr: "", stdout: "", timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: { ...process.env, NOOPOLIS_RUN_ID: EMITTER_RUN_ID }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, EMITTER_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, spawnError: error, stderr, stdout, timedOut });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stderr, stdout, timedOut });
    });
  });

export interface EmitterFixtureResult {
  issues: ConformanceIssue[];
  sources: ConformanceFixtureSource[];
}

const lastNonEmptyLine = (text: string): string | undefined => {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines[lines.length - 1];
};

/**
 * Runs every emitter spec sequentially (daimon reuses a fixed on-disk
 * directory across runs, so concurrent invocation is unsafe) and turns each
 * result into either a conformance fixture source or a reported issue.
 * Never silently skips an emitter: spawn error, timeout, nonzero exit, zero
 * parsed records, and an unreadable daimon path-line are all reported as a
 * `ConformanceIssue{source}` rather than dropped.
 */
export const collectEmitterFixtures = async (
  specs: EmitterSpec[] = EMITTER_SPECS,
  exec: Exec = realExec
): Promise<EmitterFixtureResult> => {
  const sources: ConformanceFixtureSource[] = [];
  const issues: ConformanceIssue[] = [];

  for (const spec of specs) {
    const result = await exec(spec);

    if (result.spawnError) {
      issues.push({ message: `spawn error: ${result.spawnError.message}`, source: spec.name });
      continue;
    }
    if (result.timedOut) {
      issues.push({ message: `timed out after ${EMITTER_TIMEOUT_MS}ms`, source: spec.name });
      continue;
    }
    if (result.exitCode !== 0) {
      const stderrDetail = result.stderr.trim();
      issues.push({
        message: `exited with code ${String(result.exitCode)}${stderrDetail ? `: ${stderrDetail}` : ""}`,
        source: spec.name
      });
      continue;
    }

    let jsonl: string;
    if (spec.output === "path-line") {
      const pathLine = lastNonEmptyLine(result.stdout);
      if (!pathLine) {
        issues.push({ message: "path-line emitter produced no output path on stdout", source: spec.name });
        continue;
      }
      try {
        jsonl = await readFile(pathLine, "utf8");
      } catch (error) {
        issues.push({
          message: `unreadable path ${pathLine}: ${error instanceof Error ? error.message : String(error)}`,
          source: spec.name
        });
        continue;
      }
    } else {
      jsonl = result.stdout;
    }

    const { errors, events } = parseCausalJsonl(jsonl);
    if (errors.length > 0) {
      for (const error of errors) {
        issues.push({ line: error.line, message: error.message, source: spec.name });
      }
      continue;
    }
    if (events.length === 0) {
      issues.push({ message: "emitter produced zero parsed records", source: spec.name });
      continue;
    }

    sources.push({ jsonl, name: spec.name });
  }

  return { issues, sources };
};
