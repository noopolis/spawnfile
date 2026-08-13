#!/usr/bin/env node

import { isTargetLookupInvocation } from "./targetCliRoute.js";

const argv = process.argv.slice(2);
const exitCode = isTargetLookupInvocation(argv)
  ? await (await import("./targetLookupCli.js")).runTargetLookupCli(argv)
  : await (await import("./runCli.js")).runCli(argv);
process.exitCode = exitCode;
