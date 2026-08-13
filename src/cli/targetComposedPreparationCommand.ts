import type { Command } from "commander";

import {
  createCanonicalComposedPreparationReceiptBytes,
  prepareComposedRun,
  type ComposedPreparationHandlers,
} from "../target/composedPreparation.js";
import { formatCaughtTargetCliError } from "./targetReceiptOutput.js";
import { readComposedPreparationRequestFile } from "./targetRequestFile.js";
import type {
  TargetCommandHandlerSession,
  TargetCommandSessionLoader,
  TargetCommandStreams,
} from "./targetCommands.js";

type SetExitCode = (exitCode: 1 | 2) => void;

/** Registers the sole aggregate preparation path consumed by Simfile. */
export const registerTargetComposedPreparationCommand = (
  target: Command,
  session: TargetCommandHandlerSession | TargetCommandSessionLoader,
  streams: TargetCommandStreams,
  setExitCode: SetExitCode,
): void => {
  target.command("prepare_composed_run")
    .description("Prepare one immutable composed-run target resource set")
    .argument("<request-file>", "Strict composed-preparation request JSON file")
    .action(async (requestFile: string) => {
      let request;
      try {
        request = await readComposedPreparationRequestFile(requestFile);
      } catch {
        streams.stderr("error: Invalid composed preparation request");
        setExitCode(2);
        return;
      }
      let activeSession: TargetCommandHandlerSession;
      try {
        activeSession = typeof session === "function"
          ? await session((target.opts() as { config?: unknown }).config as string)
          : session;
      } catch {
        streams.stderr("error: Invalid target configuration");
        setExitCode(2);
        return;
      }
      try {
        const receipt = await activeSession.run((handlers) =>
          prepareComposedRun(handlers as ComposedPreparationHandlers, request));
        streams.stdout(createCanonicalComposedPreparationReceiptBytes(receipt));
      } catch (error) {
        streams.stderr(formatCaughtTargetCliError(
          error,
          "Composed preparation crashed",
        ));
        setExitCode(1);
      }
    });
};
