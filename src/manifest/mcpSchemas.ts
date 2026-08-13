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

export const mcpServerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    auth: mcpAuthSchema.optional(),
    command: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1),
    transport: z.enum(["sse", "stdio", "streamable_http"]),
    url: z.string().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.name.startsWith("spawnfile.") || value.name.startsWith("mneme-")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "MCP server name is reserved for compiler-owned generated services" });
    }
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
