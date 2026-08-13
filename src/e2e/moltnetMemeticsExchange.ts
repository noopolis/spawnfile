/**
 * Thin re-export shim. This module's actual definitions moved verbatim to moltnetExchangeWait.ts (a generic,
 * scenario-agnostic module reused by officeSim.ts without pulling in any moltnet-memetics-specific code). Kept
 * here, still re-exporting the same names, purely so moltnetMemeticsExchange.test.ts keeps passing unmodified —
 * see moltnetExchangeWait.ts / moltnetExchangeWait.test.ts for the live definitions and tests.
 */
export * from "./moltnetExchangeWait.js";
