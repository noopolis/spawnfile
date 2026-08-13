import { Command } from "commander";

import {
  createProductionTargetLookupLoader,
  registerTargetOperationLookup,
  type TargetLookupCommandStreams
} from "./targetLookupCommands.js";

const defaultStreams = (): TargetLookupCommandStreams => ({
  stderr: (message) => process.stderr.write(`${message}\n`),
  stdout: (message) => process.stdout.write(`${message}\n`)
});
const commanderError = (error: unknown): error is { exitCode: number } =>
  typeof error === "object" && error !== null
  && typeof (error as { exitCode?: unknown }).exitCode === "number";

/** Minimal production entry point for lookup; it loads no mutation/provider defaults. */
export const runTargetLookupCli = async (
  argv: string[],
  stdin: AsyncIterable<unknown> = process.stdin,
  streams: TargetLookupCommandStreams = defaultStreams()
): Promise<number> => {
  let exitCode: 0 | 1 | 2 = 0;
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  const target = program.command("target").description("Execute target-resource operations");
  target.requiredOption("--config <config-input>", "Strict target configuration JSON stdin; use -");
  registerTargetOperationLookup(
    target,
    createProductionTargetLookupLoader(stdin),
    streams,
    (code) => { exitCode = code; }
  );
  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (commanderError(error)) {
      if (error.exitCode !== 0) streams.stderr("error: Invalid target command");
      return error.exitCode === 0 ? 0 : 2;
    }
    streams.stderr("error: Target operation lookup failed");
    return 1;
  }
};
