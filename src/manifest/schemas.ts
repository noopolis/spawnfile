import { z } from "zod";

const docsSchema = z
  .object({
    extras: z.record(z.string(), z.string()).optional(),
    heartbeat: z.string().optional(),
    identity: z.string().optional(),
    memory: z.string().optional(),
    soul: z.string().optional(),
    system: z.string().optional()
  })
  .strict();

const skillRequirementSchema = z
  .object({
    mcp: z.array(z.string()).optional()
  })
  .strict();

const skillReferenceSchema = z
  .object({
    ref: z.string(),
    requires: skillRequirementSchema.optional()
  })
  .strict();

const mcpAuthSchema = z
  .object({
    secret: z.string()
  })
  .strict();

const mcpServerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    auth: mcpAuthSchema.optional(),
    command: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    name: z.string(),
    transport: z.enum(["sse", "stdio", "streamable_http"]),
    url: z.string().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.transport === "stdio" && !value.command) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio MCP servers must declare command"
      });
    }

    if (value.transport !== "stdio" && !value.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.transport} MCP servers must declare url`
      });
    }
  });

const executionSchema = z
  .object({
    model: z
      .object({
        fallback: z
          .array(
            z
              .object({
                name: z.string(),
                provider: z.string()
              })
              .strict()
          )
          .optional(),
        primary: z
          .object({
            name: z.string(),
            provider: z.string()
          })
          .strict()
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        mode: z.enum(["sandboxed", "unrestricted", "workspace"])
      })
      .strict()
      .optional(),
    workspace: z
      .object({
        isolation: z.enum(["isolated", "shared"])
      })
      .strict()
      .optional()
  })
  .strict();

const runtimeBindingSchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      options: z.record(z.string(), z.unknown()).optional()
    })
    .strict()
]);

const secretSchema = z
  .object({
    name: z.string(),
    required: z.boolean()
  })
  .strict();

const policySchema = z
  .object({
    mode: z.enum(["permissive", "strict", "warn"]),
    on_degrade: z.enum(["allow", "error", "warn"])
  })
  .strict();

const commonManifestSchema = z
  .object({
    docs: docsSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    execution: executionSchema.optional(),
    kind: z.enum(["agent", "team"]),
    mcp_servers: z.array(mcpServerSchema).optional(),
    name: z
      .string()
      .min(1)
      .refine((value) => !/\s/.test(value), { message: "name must not contain whitespace" }),
    policy: policySchema.optional(),
    runtime: runtimeBindingSchema.optional(),
    secrets: z.array(secretSchema).optional(),
    skills: z.array(skillReferenceSchema).optional(),
    spawnfile_version: z.literal("0.1")
  })
  .strict();

const subagentSchema = z
  .object({
    id: z.string().min(1),
    ref: z.string()
  })
  .strict();

const sharedSurfaceSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
    mcp_servers: z.array(mcpServerSchema).optional(),
    secrets: z.array(secretSchema).optional(),
    skills: z.array(skillReferenceSchema).optional()
  })
  .strict();

const structureSchema = z
  .object({
    external: z.array(z.string().min(1)).optional(),
    leader: z.string().min(1).optional(),
    mode: z.enum(["hierarchical", "swarm"])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "hierarchical" && !value.leader) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hierarchical teams must declare a leader"
      });
    }

    if (value.mode === "swarm" && value.leader) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "swarm teams must not declare a leader"
      });
    }
  });

const memberSchema = z
  .object({
    id: z.string().min(1),
    ref: z.string()
  })
  .strict();

const agentManifestSchema = commonManifestSchema
  .extend({
    kind: z.literal("agent"),
    subagents: z.array(subagentSchema).optional()
  })
  .strict();

const teamManifestSchema = commonManifestSchema
  .extend({
    kind: z.literal("team"),
    members: z.array(memberSchema),
    shared: sharedSurfaceSchema.optional(),
    structure: structureSchema
  })
  .strict();

export const manifestSchema = z.discriminatedUnion("kind", [
  agentManifestSchema,
  teamManifestSchema
]);

export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type DocsBlock = z.infer<typeof docsSchema>;
export type ExecutionBlock = z.infer<typeof executionSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestMember = z.infer<typeof memberSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;
export type Secret = z.infer<typeof secretSchema>;
export type SharedSurface = z.infer<typeof sharedSurfaceSchema>;
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export type TeamManifest = z.infer<typeof teamManifestSchema>;

export const isAgentManifest = (manifest: Manifest): manifest is AgentManifest =>
  manifest.kind === "agent";

export const isTeamManifest = (manifest: Manifest): manifest is TeamManifest =>
  manifest.kind === "team";
