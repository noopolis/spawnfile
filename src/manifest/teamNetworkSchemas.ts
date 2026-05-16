import { z } from "zod";

export {
  teamWorkspaceDocsSchema,
  teamWorkspaceSchema
} from "./workspaceSchemas.js";
export type {
  TeamWorkspace,
  TeamWorkspaceDocs,
  TeamWorkspaceResource,
  TeamWorkspaceResource as TeamNetworkResource
} from "./workspaceSchemas.js";

const moltnetScopeSchema = z.enum(["observe", "write", "admin", "attach", "pair"]);

const countTruthy = (
  value: unknown[]
): number => value.filter((entry) => Boolean(entry)).length;

const absolutePosixPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value.startsWith("/"), {
    message: "path must be an absolute POSIX path"
  });

const normalizePosixPath = (value: string): string =>
  value.replace(/\/+/g, "/").replace(/\/+$/u, "") || "/";

const pathIsInsideMount = (filePath: string, mountPath: string): boolean => {
  const normalizedPath = normalizePosixPath(filePath);
  const normalizedMount = normalizePosixPath(mountPath);
  return normalizedPath.startsWith(`${normalizedMount}/`);
};

const teamNetworkAuthTokenSchema = z
  .object({
    agents: z.array(z.string().trim().min(1)).optional(),
    id: z.string().trim().min(1),
    secret: z.string().trim().min(1),
    scopes: z.array(moltnetScopeSchema).min(1)
  })
  .strict();

const teamNetworkAuthClientSchema = z
  .object({
    static_token: z.boolean().optional(),
    token_env: z.string().trim().min(1).optional(),
    token_id: z.string().trim().min(1).optional(),
    token_path: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const tokenSourceCount = countTruthy([value.token_id, value.token_env, value.token_path]);
    if (tokenSourceCount > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.client must declare exactly one of token_id, token_env, or token_path"
      });
    }

    if (value.static_token === true && tokenSourceCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.client.static_token requires exactly one token source"
      });
    }
  });

const teamNetworkAuthSchema = z
  .object({
    client: teamNetworkAuthClientSchema.optional(),
    mode: z.enum(["none", "bearer", "open"]),
    tokens: z.array(teamNetworkAuthTokenSchema).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "none") {
      if (value.tokens && value.tokens.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "auth.mode none must not declare tokens"
        });
      }

      if (value.client) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "auth.mode none must not declare client"
        });
      }
      return;
    }

    if (value.mode === "bearer" && !value.client) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.mode bearer requires auth.client"
      });
    }

    if (value.mode === "open" && value.client) {
      const tokenSourceCount = countTruthy([
        value.client.token_id,
        value.client.token_env,
        value.client.token_path
      ]);
      if (value.client.static_token !== true) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "open auth with auth.client requires static_token: true"
        });
      }
      if (tokenSourceCount === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "open auth with auth.client requires exactly one token source"
        });
      }
    }

    if (value.tokens) {
      const tokenIds = value.tokens.map((token) => token.id);
      if (new Set(tokenIds).size !== tokenIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "auth.tokens ids must be unique"
        });
      }
    }
  });

const teamNetworkStorePersistenceSchema = z
  .object({
    mode: z.enum(["durable", "ephemeral"]),
    mount: absolutePosixPathSchema.optional(),
    name: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "ephemeral" && (value.mount || value.name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ephemeral persistence must not declare mount or name"
      });
    }
  });

const teamNetworkFileStoreSchema = z
  .object({
    path: absolutePosixPathSchema.optional(),
    persistence: teamNetworkStorePersistenceSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.path && value.persistence?.mount && !pathIsInsideMount(value.path, value.persistence.mount)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "store.path must be inside persistence.mount"
      });
    }
  });

const teamNetworkStoreSqliteSchema = teamNetworkFileStoreSchema.extend({
  kind: z.literal("sqlite")
});

const teamNetworkStoreJsonSchema = teamNetworkFileStoreSchema.extend({
  kind: z.literal("json")
});

const teamNetworkStorePostgresSchema = z
  .object({
    kind: z.literal("postgres"),
    dsn_secret: z.string().trim().min(1)
  })
  .strict();

const teamNetworkStoreMemorySchema = z.object({ kind: z.literal("memory") }).strict();

const teamNetworkStoreSchema = z.discriminatedUnion("kind", [
  teamNetworkStoreSqliteSchema,
  teamNetworkStoreJsonSchema,
  teamNetworkStorePostgresSchema,
  teamNetworkStoreMemorySchema
]);

const teamNetworkListenSchema = z
  .object({
    bind: z
      .string()
      .trim()
      .min(1)
      .superRefine((value, context) => {
        if (value.startsWith("[") || value.endsWith("]") || /\[.*\]/.test(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "listen.bind must be unbracketed"
          });
        }
      }),
    port: z.number().int().min(1).max(65535)
  })
  .strict();

const teamNetworkPairingSchema = z
  .object({
    id: z.string().trim().min(1),
    remote_base_url: z.string().trim().min(1),
    remote_network_id: z.string().trim().min(1),
    remote_network_name: z.string().trim().min(1),
    token_secret: z.string().trim().min(1)
  })
  .strict();

const teamNetworkManagedServerSchema = z
  .object({
    allowed_origins: z.array(z.string().trim().min(1)).optional(),
    auth: teamNetworkAuthSchema,
    debug_events: z.boolean().optional(),
    direct_messages: z.boolean().optional(),
    human_ingress: z.boolean().optional(),
    listen: teamNetworkListenSchema,
    mode: z.literal("managed"),
    pairings: z.array(teamNetworkPairingSchema).optional(),
    store: teamNetworkStoreSchema,
    trust_forwarded_proto: z.boolean().optional(),
    url: z.string().trim().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.auth.mode === "bearer") {
      if (!value.auth.tokens || value.auth.tokens.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "managed server with auth.mode bearer requires at least one auth token"
        });
      }

      if (!value.auth.client?.token_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "managed bearer auth requires auth.client.token_id"
        });
      }

      if (value.auth.client?.token_env || value.auth.client?.token_path) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "managed bearer auth requires auth.client.token_id"
        });
      }

      if (value.auth.client?.token_id && value.auth.tokens) {
        const tokenById = new Map(value.auth.tokens.map((token) => [token.id, token]));
        const selected = tokenById.get(value.auth.client.token_id);
        if (!selected) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `managed bearer auth references unknown token: ${value.auth.client.token_id}`
          });
        } else if (!(selected.scopes.includes("attach") && selected.scopes.includes("write"))) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "managed bearer auth.client.token_id must reference a token with attach and write scopes"
          });
        }
      }
    }

    if (value.auth.mode === "open" && value.auth.client) {
      if (!value.auth.client.token_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "managed open auth requires auth.client.token_id"
        });
      }

      if (value.auth.client.token_env || value.auth.client.token_path) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "managed open auth client token source must be token_id"
        });
      }
    }
  });

const teamNetworkExternalServerSchema = z
  .object({
    auth: teamNetworkAuthSchema,
    mode: z.literal("external"),
    url: z.string().trim().min(1)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.auth.tokens && value.auth.tokens.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "external server does not accept auth.tokens"
      });
    }

    if (value.auth.mode === "none" && value.auth.client) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.mode none must not declare client"
      });
    }

    if (!value.auth.client) {
      return;
    }

    if (value.auth.client.token_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.client.token_id is only valid for managed servers"
      });
    }

    if (value.auth.mode === "open" && value.auth.client.static_token !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "open auth with auth.client requires static_token: true"
      });
    }

    if (
      value.auth.mode === "open" &&
      countTruthy([value.auth.client.token_env, value.auth.client.token_path]) !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "external open auth requires token_env or token_path"
      });
    }

    if (value.auth.mode === "bearer") {
      const sourceCount = countTruthy([
        value.auth.client.token_id,
        value.auth.client.token_env,
        value.auth.client.token_path
      ]);
      if (sourceCount !== 1 || !value.auth.client.token_env && !value.auth.client.token_path) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "external bearer auth requires exactly one external token source"
        });
      }
    }
  });

const teamNetworkServerSchema = z.discriminatedUnion("mode", [
  teamNetworkManagedServerSchema,
  teamNetworkExternalServerSchema
]);

const teamNetworkRoomSchema = z
  .object({
    id: z.string().trim().min(1),
    members: z.array(z.string().trim().min(1)).min(1),
    name: z.string().trim().min(1).optional()
  })
  .strict();

export const teamNetworkSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    provider: z.literal("moltnet"),
    rooms: z.array(teamNetworkRoomSchema).min(1),
    server: teamNetworkServerSchema
  })
  .strict()
  .superRefine((value, context) => {
    const roomIds = value.rooms.map((room) => room.id);
    if (new Set(roomIds).size !== roomIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `network ${value.id} declares duplicate room ids`
      });
    }
  });

export type TeamNetwork = z.infer<typeof teamNetworkSchema>;
export type TeamNetworkRoom = z.infer<typeof teamNetworkRoomSchema>;
export type TeamNetworkServer = z.infer<typeof teamNetworkServerSchema>;
export type TeamNetworkAuth = z.infer<typeof teamNetworkAuthSchema>;
export type TeamNetworkStore = z.infer<typeof teamNetworkStoreSchema>;
