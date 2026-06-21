import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentHandle } from "../core/types.js";
import { seedPiOpenAICodexAuthFromCodex } from "../pi/auth.js";
import { PiHarnessAdapter } from "../pi/piHarness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daimonRoot = path.resolve(__dirname, "../..");
const runtimeRoot = path.join(daimonRoot, ".runtime", "pi-agent");
const sharedProjectPath = path.join(runtimeRoot, "shared", "product");
const piAuthPath = path.join(runtimeRoot, "auth", "auth.json");
const codexAuthPath = path.join(process.env.HOME ?? "", ".codex", "auth.json");

const ensureFile = async (filePath: string): Promise<string> => {
  await access(filePath);
  return readFile(filePath, "utf8");
};

const assertContains = (content: string, expected: string, filePath: string): void => {
  if (!content.includes(expected)) {
    throw new Error(`${filePath} does not contain expected text: ${expected}`);
  }
};

const prepareWorkspace = async (agentId: string): Promise<{ workspacePath: string; runtimeHomePath: string }> => {
  const workspacePath = path.join(runtimeRoot, "agents", agentId, "workspace");
  const runtimeHomePath = path.join(runtimeRoot, "agents", agentId, "runtime");
  await mkdir(path.join(workspacePath, "repos"), { recursive: true });
  await mkdir(runtimeHomePath, { recursive: true });
  await writeFile(
    path.join(workspacePath, "AGENTS.md"),
    `# ${agentId}\n\nThis workspace was prepared by caller code, not by the Daimon package.\n`
  );
  await symlink(sharedProjectPath, path.join(workspacePath, "repos", "product"));
  return { workspacePath, runtimeHomePath };
};

const setupRuntime = async (): Promise<void> => {
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(sharedProjectPath, { recursive: true });
  await writeFile(
    path.join(sharedProjectPath, "source.txt"),
    [
      "Daimon E2E source file.",
      "The caller prepares shared files and Daimon runs agent turns.",
      "Expected marker: daimon-e2e"
    ].join("\n")
  );
  await seedPiOpenAICodexAuthFromCodex({ codexAuthPath, piAuthPath });
};

const startHarnessedAgent = async (
  adapter: PiHarnessAdapter,
  input: {
    id: string;
    name: string;
    instructions: string;
  }
): Promise<AgentHandle> => {
  const paths = await prepareWorkspace(input.id);
  return adapter.startAgent({
    ...input,
    ...paths
  });
};

const run = async (): Promise<void> => {
  await setupRuntime();

  const adapter = new PiHarnessAdapter({
    authPath: piAuthPath,
    model: {
      provider: "openai-codex",
      name: process.env.HARNESS_PI_MODEL ?? "gpt-5.4-mini"
    }
  });

  const mapper = await startHarnessedAgent(adapter, {
    id: "mapper",
    name: "Mapper",
    instructions:
      "You map project inputs into concise markdown notes. Prefer editing files over long chat responses."
  });
  const reviewer = await startHarnessedAgent(adapter, {
    id: "reviewer",
    name: "Reviewer",
    instructions: "You review files written by another harnessed agent and produce a final check note."
  });

  try {
    console.log("started", JSON.stringify([mapper.status(), reviewer.status()], null, 2));

    const mapped = await mapper.wake({
      id: "wake-mapper-1",
      kind: "manual",
      from: "caller",
      text: [
        "Read repos/product/source.txt.",
        "Create repos/product/agent-output/mapper.md.",
        "The file must contain the exact marker MAPPER_OK and the phrase daimon-e2e.",
        "Reply with one short sentence naming the file."
      ].join("\n")
    });
    console.log("mapper", JSON.stringify(mapped, null, 2));

    const reviewed = await reviewer.wake({
      id: "wake-reviewer-1",
      kind: "message",
      from: "mapper",
      text: [
        "Read repos/product/agent-output/mapper.md.",
        "Create repos/product/agent-output/review.md.",
        "The file must contain the exact marker REVIEW_OK and mention MAPPER_OK.",
        "Reply with one short sentence naming the file."
      ].join("\n")
    });
    console.log("reviewer", JSON.stringify(reviewed, null, 2));

    const mapperFile = path.join(sharedProjectPath, "agent-output", "mapper.md");
    const reviewFile = path.join(sharedProjectPath, "agent-output", "review.md");
    assertContains(await ensureFile(mapperFile), "MAPPER_OK", mapperFile);
    assertContains(await ensureFile(mapperFile), "daimon-e2e", mapperFile);
    assertContains(await ensureFile(reviewFile), "REVIEW_OK", reviewFile);
    assertContains(await ensureFile(reviewFile), "MAPPER_OK", reviewFile);

    console.log("final-status", JSON.stringify([mapper.status(), reviewer.status()], null, 2));
    console.log("e2e:pi-agent ok");
  } finally {
    await Promise.all([mapper.stop(), reviewer.stop()]);
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
