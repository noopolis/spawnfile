import type { Command } from "commander";

import { SpawnfileError } from "../shared/index.js";

import {
  createCapabilitiesReceipt,
  createCapabilitiesReceiptBytes,
} from "./capabilitiesReceipt.js";
import type { CliStreams } from "./runCli.js";

export const registerCapabilitiesCommand = (
  program: Command,
  streams: CliStreams,
  packageVersion: string,
): void => {
  program.command("capabilities")
    .description("Report supported public CLI contracts")
    .requiredOption("--json", "Emit one strict versioned JSON receipt")
    .action((options: { readonly json?: boolean }) => {
      if (options.json !== true) throw new SpawnfileError("validation_error", "`capabilities` requires --json");
      streams.stdout(createCapabilitiesReceiptBytes(createCapabilitiesReceipt(packageVersion)));
    });
};
