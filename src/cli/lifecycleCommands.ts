import type { Command } from "commander";

import { registerCompileBuildCommands } from "./compileBuildCommands.js";
import { registerDownCommand } from "./downCommand.js";
import { registerLifecyclePlanningCommands } from "./lifecyclePlanningCommands.js";
import { registerRunPublishCommands } from "./runPublishCommands.js";
import type { CliHandlers, CliStreams } from "./runCli.js";
import { registerUpCommand } from "./upCommand.js";

export const registerLifecycleCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams,
  stdin: AsyncIterable<unknown>
): void => {
  registerLifecyclePlanningCommands(program, streams, stdin);
  registerCompileBuildCommands(program, handlers, streams);
  registerRunPublishCommands(program, handlers, streams);
  registerUpCommand(program, handlers, streams);
  registerDownCommand(program, handlers, streams);
};
