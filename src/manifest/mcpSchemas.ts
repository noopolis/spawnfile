import { z } from "zod";

const mcpAuthSchema = z
  .object({
    mode: z.literal("bearer").optional(),
    secret: z.string()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "bearer" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.secret)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secret"],
        message: "bearer auth.secret must be a valid shell environment-variable name"
      });
    }
  });

const mcpToolsSchema = z.array(z.string().min(1)).max(32);

const refineToolsAndName = (
  value: { name: string; tools?: string[] },
  context: z.RefinementCtx
): void => {
  if (value.tools !== undefined && (value.tools.length === 0 || new Set(value.tools).size !== value.tools.length)) context.addIssue({ code: z.ZodIssueCode.custom, message: "MCP tools must be a nonempty unique allowlist" });
  if (value.name.startsWith("spawnfile.") || value.name.startsWith("mneme-")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "MCP server name is reserved for compiler-owned generated services" });
  }
};

export const mcpServerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    auth: mcpAuthSchema.optional(),
    command: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1),
    transport: z.enum(["sse", "stdio", "streamable_http"]),
    tools: mcpToolsSchema.optional(),
    url: z.string().optional()
  })
  .strict()
  .superRefine((value, context) => {
    refineToolsAndName(value, context);
    if (value.transport === "stdio" && !value.command) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "stdio MCP servers must declare command" });
    }
    if (value.transport === "stdio" && value.auth?.mode === "bearer") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "stdio MCP servers do not support bearer auth" });
    }
    if (value.transport !== "stdio" && !value.url) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${value.transport} MCP servers must declare url` });
    }
  });

/**
 * An agent-level entry without `transport` narrows the inherited
 * `shared.environment.mcp_servers` entry of the same name instead of replacing
 * it: `tools` replaces the inherited allowlist and `env` is merged key by key.
 * Whether a server of that name is inherited is only known during graph
 * resolution, so the compiler (not this schema) rejects an orphan override.
 */
export const mcpServerOverrideSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1),
    tools: mcpToolsSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    refineToolsAndName(value, context);
    if (value.tools === undefined && value.env === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP server override without transport must declare tools or env"
      });
    }
  });

const hasTransportKey = (value: unknown): boolean =>
  typeof value === "object" && value !== null && Object.hasOwn(value, "transport");

export type McpServerDeclaration = z.infer<typeof mcpServerSchema>;
export type McpServerOverride = z.infer<typeof mcpServerOverrideSchema>;
export type McpServerEntry = McpServerDeclaration | McpServerOverride;

/** Agent-scope MCP entry: a complete server (has `transport`) or an override of an inherited one. */
export const mcpServerEntrySchema = z.unknown().transform((value, context): McpServerEntry => {
  const result = hasTransportKey(value)
    ? mcpServerSchema.safeParse(value)
    : mcpServerOverrideSchema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    context.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
  return z.NEVER;
});

export const isMcpServerDeclaration = (entry: McpServerEntry): entry is McpServerDeclaration =>
  "transport" in entry;
