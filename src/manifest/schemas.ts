import { z } from "zod";

import { agentScheduleSchema } from "./scheduleSchemas.js";
import { executionSchema } from "./executionSchemas.js";
import { surfacesSchema } from "./surfaceSchemas.js";
import {
  teamNetworkSchema,
  teamWorkspaceDocsSchema,
  teamWorkspaceSchema
} from "./teamNetworkSchemas.js";

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

const packageManagerSchema = z.enum(["apt", "npm", "pipx"]);

const packageSchema = z
  .object({
    id: z.string().min(1),
    manager: packageManagerSchema,
    name: z.string().min(1),
    scope: z.string().min(1).optional(),
    version: z.string().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.manager !== "npm" && value.scope !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scope is only supported for npm-managed packages"
      });
    }

    if (value.manager === "npm" && value.scope !== undefined && value.scope !== "global") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "npm package scope must be global"
      });
    }
  });

const environmentSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
    mcp_servers: z.array(mcpServerSchema).optional(),
    packages: z.array(packageSchema).optional(),
    secrets: z.array(secretSchema).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const packageIds = value.packages?.map((pkg) => pkg.id) ?? [];
    if (new Set(packageIds).size !== packageIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "environment package ids must be unique"
      });
    }
  });

const commonManifestSchema = z
  .object({
    description: z.string().optional(),
    execution: executionSchema.optional(),
    kind: z.enum(["agent", "team"]),
    name: z
      .string()
      .min(1)
      .refine((value) => !/\s/.test(value), { message: "name must not contain whitespace" }),
    policy: policySchema.optional(),
    surfaces: surfacesSchema.optional(),
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
    environment: environmentSchema.optional(),
    workspace: teamWorkspaceSchema.optional()
  })
  .strict();

const memberSchema = z
  .object({
    id: z.string().min(1),
    ref: z.string()
  })
  .strict();

const agentManifestSchema = commonManifestSchema
  .extend({
    expose: z.boolean().optional(),
    kind: z.literal("agent"),
    environment: environmentSchema.optional(),
    runtime: runtimeBindingSchema.optional(),
    schedule: agentScheduleSchema.optional(),
    subagents: z.array(subagentSchema).optional(),
    workspace: teamWorkspaceSchema.optional()
  })
  .strict();

const teamManifestSchema = commonManifestSchema
  .extend({
    external: z.array(z.string().min(1)).optional(),
    kind: z.literal("team"),
    lead: z.string().min(1).optional(),
    members: z.array(memberSchema),
    mode: z.enum(["hierarchical", "swarm"]),
    networks: z.array(teamNetworkSchema).optional(),
    shared: sharedSurfaceSchema.optional()
  })
  .superRefine((value, context) => {
    const memberIds = new Set(value.members.map((member) => member.id));

    if (value.mode === "hierarchical" && !value.lead) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hierarchical teams must declare lead"
      });
    }
    if (value.mode === "swarm" && value.lead) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "swarm teams must not declare lead"
      });
    }
    if (value.execution !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "team manifests must not declare execution"
      });
    }
    if (value.surfaces !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "team manifests must not declare surfaces"
      });
    }

    if (value.networks) {
      const networkIds = value.networks.map((network) => network.id);
      if (new Set(networkIds).size !== networkIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "team manifests must not declare duplicate network ids"
        });
      }

      for (const network of value.networks) {
        for (const room of network.rooms) {
          for (const memberId of room.members) {
            if (!memberIds.has(memberId)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `network ${network.id} room ${room.id} references unknown member ${memberId}`
              });
            }
          }
        }
      }
    }
  })
  .strict();

export const manifestSchema = z.discriminatedUnion("kind", [
  agentManifestSchema,
  teamManifestSchema
]);

export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type { AgentSchedule } from "./scheduleSchemas.js";
export type DocsBlock = z.infer<typeof teamWorkspaceDocsSchema>;
export type Environment = z.infer<typeof environmentSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestMember = z.infer<typeof memberSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;
export type Package = z.infer<typeof packageSchema>;
export type Secret = z.infer<typeof secretSchema>;
export type SharedSurface = z.infer<typeof sharedSurfaceSchema>;
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export type TeamManifest = z.infer<typeof teamManifestSchema>;
export type {
  ExecutionBlock,
  ModelEndpoint,
  ModelEntryAuth,
  ModelTarget
} from "./executionSchemas.js";

export type {
  TeamNetwork,
  TeamNetworkRoom,
  TeamNetworkServer,
  TeamWorkspace,
  TeamWorkspaceResource
} from "./teamNetworkSchemas.js";

export type {
  DiscordSurface,
  DiscordSurfaceAccess,
  HttpSurface,
  HttpSurfaceAccess,
  HttpSurfaceAuth,
  MoltnetAttachment,
  MoltnetDM,
  MoltnetRead,
  MoltnetReply,
  MoltnetRoomBehavior,
  MoltnetSurface,
  SlackSurface,
  SlackSurfaceAccess,
  SurfacesBlock,
  TelegramSurface,
  TelegramSurfaceAccess,
  WebhookSurface,
  WhatsAppSurface,
  WhatsAppSurfaceAccess
} from "./surfaceSchemas.js";

export const isAgentManifest = (manifest: Manifest): manifest is AgentManifest =>
  manifest.kind === "agent";

export const isTeamManifest = (manifest: Manifest): manifest is TeamManifest =>
  manifest.kind === "team";
