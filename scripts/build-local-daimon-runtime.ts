#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { buildLocalDaimonRuntime } from "../src/runtime/daimon/image/buildLocalRuntime.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) buildLocalDaimonRuntime();
