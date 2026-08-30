#!/usr/bin/env node

import { isTargetLookupInvocation } from "./targetCliRoute.js";
import { isWorkspaceResourceMigrationInvocation } from "./workspaceResourceMigrationCommand.js";
import { isProductStateCloneInvocation } from "./productStateCloneCommand.js";
import { isCanaryCutoverInvocation } from "./canaryCutoverCommand.js";

const argv = process.argv.slice(2);
const exitCode = isCanaryCutoverInvocation(argv)
  ? await (await import("./canaryCutoverCommand.js")).runCanaryCutoverCommand(argv)
  : isProductStateCloneInvocation(argv)
  ? await (await import("./productStateCloneCommand.js")).runProductStateCloneCommand(argv)
  : isWorkspaceResourceMigrationInvocation(argv)
  ? await (await import("./workspaceResourceMigrationCommand.js")).runWorkspaceResourceMigrationCommand(argv)
  : isTargetLookupInvocation(argv)
    ? await (await import("./targetLookupCli.js")).runTargetLookupCli(argv)
    : await (await import("./runCli.js")).runCli(argv);
process.exitCode = exitCode;
