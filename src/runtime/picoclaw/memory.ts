import type { ResolvedAgentNode } from "../../compiler/types.js";
import {
  buildMnemeMemoryMcpServers,
  hasScheduledMemoryConsolidation,
  hasUnsupportedMnemeMemoryAccess,
  MNEME_PACKAGE
} from "../mnemeMcp.js";

export const buildPicoClawMemoryMcpServers = (
  node: ResolvedAgentNode
): Record<string, Record<string, unknown>> =>
  buildMnemeMemoryMcpServers(node, {
    modes: hasScheduledMemoryConsolidation(node) ? ["awake", "dream"] : ["awake"]
  });

export const picoClawMemoryCapabilityFor = (
  node: ResolvedAgentNode
): {
  message: string;
  outcome: "degraded" | "supported";
} => {
  if (hasUnsupportedMnemeMemoryAccess(node)) {
    return {
      message: "PicoClaw lowers file-backed Mneme memory through generated MCP servers; non-file stores are not lowered",
      outcome: "degraded"
    };
  }

  return {
    message: "PicoClaw accesses Mneme memory through generated MCP servers",
    outcome: "supported"
  };
};

export const PICOCLAW_MNEME_PACKAGE = MNEME_PACKAGE;
