import type { Command } from "commander";

import { lookupLifecycleCompletion } from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";

import { planLifecycleInvocation, readLifecyclePlanRequest } from "./lifecyclePlan.js";
import type { CliStreams } from "./runCli.js";

export const registerLifecyclePlanningCommands = (
  program: Command,
  streams: CliStreams,
  stdin: AsyncIterable<unknown>
): void => {
  const lifecycle = program
    .command("lifecycle")
    .description("Plan or read durable machine lifecycle operations");
  lifecycle
    .command("plan")
    .description("Admit an exact read-only artifacts-export or down lifecycle plan")
    .requiredOption(
      "--request <file>",
      "Strict spawnfile.lifecycle-plan-request.v1 JSON file, or - for stdin"
    )
    .action(async (options: { request: string }) => {
      streams.stdout(
        JSON.stringify(
          await planLifecycleInvocation(
            await readLifecyclePlanRequest(options.request, stdin)
          ),
          null,
          2
        )
      );
    });
  lifecycle
    .command("lookup")
    .description("Read one lifecycle completion without Docker or provider inspection")
    .argument("[invocation]", "Lifecycle invocation id")
    .option("--lifecycle-invocation <id>", "Lifecycle invocation id")
    .action(async (
      invocation: string | undefined,
      options: { lifecycleInvocation?: string }
    ) => {
      const id = options.lifecycleInvocation ?? invocation;
      if (
        !id ||
        (invocation !== undefined &&
          options.lifecycleInvocation !== undefined &&
          invocation !== options.lifecycleInvocation)
      ) {
        throw new SpawnfileError(
          "validation_error",
          "lifecycle lookup requires exactly one lifecycle invocation id"
        );
      }
      streams.stdout(JSON.stringify(await lookupLifecycleCompletion(id), null, 2));
    });
};
