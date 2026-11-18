#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { publishDaimonRuntime } from "../src/runtime/daimon/image/publishRuntime.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) publishDaimonRuntime();
