import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * Standalone `fixtures/support/scripted-engine/office-engine.mjs`
 * (Slice B, Piece 5 step 1) is a generic `scripted`-engine fixture script
 * (its eleanor/sam canned-reply screenplay was originally extracted from the
 * now-deleted `officeSimEngines.ts`'s fake `grok` binary — the office-sim
 * scenario itself lives in `ecosystem/simfile` now, see
 * `ecosystem/simfile/fixtures/sims/office-sim/harness/office-engine.mjs`).
 * This script is still directly referenced by unit tests unrelated to the
 * office-sim scenario (`src/runtime/pi/adapter.test.ts`,
 * `src/compiler/containerArtifacts.test.ts`) as a generic fixture proving the
 * pi runtime's `scripted` engine kind, so it stays in place. It must run
 * under plain `node` (no build step), so its reply text is inlined below
 * rather than imported from anywhere — these tests exercise the actual
 * script as a child process and assert its stdout matches these constants
 * exactly, catching any future drift.
 */
const OFFICE_SIM_ELEANOR_PROPOSE =
  "Let's pilot the downtown office and target June 1 for the file migration. @sam does that work for you?";
const OFFICE_SIM_SAM_ACCEPT =
  "Downtown office and June 1 works for me. @eleanor agreed, let's lock it in.";
const OFFICE_SIM_ELEANOR_CLOSE =
  "Great, that's settled: downtown office, go-live June 1 for the file migration. Done.";
const OFFICE_SIM_AGREEMENT_MARKER = "works for me";
const SCRIPT_PATH = fileURLToPath(
  new URL("../../fixtures/support/scripted-engine/office-engine.mjs", import.meta.url)
);

describe("office-engine.mjs (standalone scripted-engine fixture script)", () => {
  const tempDirectories: string[] = [];

  const createTempDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "office-engine-script-test-"));
    tempDirectories.push(directory);
    return directory;
  };

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const runScript = async (promptText: string, workspacePath: string): Promise<string> => {
    const root = await createTempDirectory();
    const promptPath = path.join(root, "prompt.txt");
    await writeFile(promptPath, promptText);
    const { stdout } = await execFileAsync("node", [
      SCRIPT_PATH,
      "--prompt-file",
      promptPath,
      "--cwd",
      workspacePath
    ]);
    return stdout.trim();
  };

  it("speaks the --prompt-file/--cwd argv contract and prints eleanor's opener when no agreement is present", async () => {
    const reply = await runScript(
      "Wake event: kick off the office pilot.",
      "/instance/workspace/agents/eleanor"
    );

    expect(reply).toBe(OFFICE_SIM_ELEANOR_PROPOSE);
  });

  it("prints sam's acceptance for a --cwd ending in /sam, regardless of prompt content", async () => {
    const reply = await runScript(
      "Wake event: eleanor proposed downtown + June 1.",
      "/instance/workspace/agents/sam"
    );

    expect(reply).toBe(OFFICE_SIM_SAM_ACCEPT);
  });

  it("drops the @mention and closes once eleanor's prompt echoes sam's agreement marker", async () => {
    expect(OFFICE_SIM_SAM_ACCEPT.toLowerCase()).toContain(OFFICE_SIM_AGREEMENT_MARKER);

    const reply = await runScript(
      `Wake event: sam replied "${OFFICE_SIM_SAM_ACCEPT}"`,
      "/instance/workspace/agents/eleanor"
    );

    expect(reply).toBe(OFFICE_SIM_ELEANOR_CLOSE);
  });

  it("falls back to a neutral reply for any other agent slug", async () => {
    const reply = await runScript("Wake event: irrelevant.", "/instance/workspace/agents/someone-else");

    expect(reply).toBe("Nothing further to decide.");
  });
});
