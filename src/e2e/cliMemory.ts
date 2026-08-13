import { Command } from "commander";

import {
  runDaimonMemoryRecallE2E,
  runJungianSelfOrgE2E,
  runMixedRuntimeMemoryWiringE2E,
  type MemoryE2EResult
} from "./memoryIntegration.js";
import { runOllamaEmbeddingsProbe } from "./ollamaProbe.js";

const printMemoryResult = (name: string, result: MemoryE2EResult): void => {
  console.log(`${name}: ${result.status} (${result.summary})`);
  for (const detail of result.details) console.log(`  - ${detail}`);
  console.log(`fixture=${result.fixtureDirectory} output=${result.outputDirectory}`);
};

const runMemoryCli = async (
  argv: string[],
  input: {
    description: string;
    name: string;
    resultName: string;
    run: typeof runDaimonMemoryRecallE2E;
  }
): Promise<void> => {
  const command = new Command();
  command
    .name(input.name)
    .description(input.description)
    .option("--fixture <path>", "Fixture directory override")
    .option("--keep-artifacts", "Keep temporary compile output")
    .option("--out <path>", "Compile output directory");
  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{ fixture?: string; keepArtifacts?: boolean; out?: string }>();
  const result = await input.run({
    fixtureDirectory: options.fixture,
    keepArtifacts: options.keepArtifacts,
    outputDirectory: options.out
  });
  printMemoryResult(input.resultName, result);
};

export const runDaimonMemoryRecallCli = async (argv: string[]): Promise<void> =>
  runMemoryCli(argv, {
    description: "Run the opt-in Daimon recall compile/probe E2E",
    name: "spawnfile-e2e daimon-memory-recall",
    resultName: "Daimon memory recall E2E",
    run: runDaimonMemoryRecallE2E
  });

export const runMixedRuntimeMemoryWiringCli = async (argv: string[]): Promise<void> =>
  runMemoryCli(argv, {
    description: "Run the opt-in mixed-runtime memory wiring compile E2E",
    name: "spawnfile-e2e mixed-runtime-memory",
    resultName: "Mixed-runtime memory wiring E2E",
    run: runMixedRuntimeMemoryWiringE2E
  });

export const runJungianSelfOrgCli = async (argv: string[]): Promise<void> =>
  runMemoryCli(argv, {
    description: "Run the opt-in Jungian self-org memory wiring compile E2E",
    name: "spawnfile-e2e jungian-self-org",
    resultName: "Jungian self-org E2E",
    run: runJungianSelfOrgE2E
  });

export const runOllamaEmbeddingsProbeCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile-e2e ollama-embeddings-probe")
    .description("Probe local Ollama embeddings endpoint if available")
    .option("--base-url <url>", "Ollama base URL", "http://127.0.0.1:11434")
    .option("--model <name>", "Ollama model to probe for embeddings")
    .option("--prompt <text>", "Embedding prompt")
    .option("--timeout-ms <ms>", "Request timeout", Number);
  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{
    baseUrl?: string;
    model?: string;
    prompt?: string;
    timeoutMs?: number;
  }>();
  const result = await runOllamaEmbeddingsProbe({
    baseUrl: options.baseUrl,
    model: options.model,
    prompt: options.prompt,
    timeoutMs: options.timeoutMs
  });
  const dimension = result.vectorDimension === undefined ? "n/a" : `${result.vectorDimension}`;
  console.log(
    `Ollama embeddings probe ${result.status}: ${result.message}` +
    `${result.model ? ` model=${result.model}` : ""} dimensions=${dimension} baseUrl=${result.baseUrl}`
  );
};
