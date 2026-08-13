import { z } from "zod";

const memoryIdPattern = /^[A-Za-z0-9_-]+$/u;

const memoryIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(memoryIdPattern, "memory id must match [A-Za-z0-9_-]+");

const absolutePosixPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value.startsWith("/"), {
    message: "memory paths must be absolute POSIX paths"
  });

const memoryStorePersistenceSchema = z
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

const memoryStoreSqliteSchema = z
  .object({
    kind: z.literal("sqlite"),
    path: absolutePosixPathSchema.optional(),
    persistence: memoryStorePersistenceSchema.optional()
  })
  .strict();

const memoryStoreJsonSchema = z
  .object({
    kind: z.literal("json"),
    path: absolutePosixPathSchema.optional(),
    persistence: memoryStorePersistenceSchema.optional()
  })
  .strict();

const memoryStorePostgresSchema = z
  .object({
    kind: z.literal("postgres"),
    dsn_secret: z.string().trim().min(1)
  })
  .strict();

const memoryStoreMemorySchema = z
  .object({
    kind: z.literal("memory")
  })
  .strict();

export const memoryStoreSchema = z.discriminatedUnion("kind", [
  memoryStoreSqliteSchema,
  memoryStoreJsonSchema,
  memoryStorePostgresSchema,
  memoryStoreMemorySchema
]);

const memoryVectorSchema = z
  .object({
    base_url: z.string().trim().min(1).optional(),
    dimensions: z.number().int().positive().optional(),
    enabled: z.boolean().optional().default(false),
    model: z.string().trim().min(1).optional(),
    provider: z.enum(["ollama"]).optional(),
    timeout_ms: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && !value.model) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "memory vector index requires model"
      });
    }
  });

const memoryIndexSchema = z
  .object({
    graph: z
      .object({
        enabled: z.boolean().optional().default(false),
        kind: z.enum(["entity_graph", "temporal_kg"]).optional()
      })
      .strict()
      .optional(),
    lexical: z
      .object({
        enabled: z.boolean().optional().default(true),
        engine: z.enum(["sqlite_fts", "bm25"]).optional()
      })
      .strict()
      .optional(),
    rerank: z
      .object({
        enabled: z.boolean().optional().default(false)
      })
      .strict()
      .optional(),
    vector: memoryVectorSchema.optional()
  })
  .strict();

const memoryConsolidationSchema = z
  .object({
    mode: z.enum(["disabled", "on_threshold", "scheduled"]).optional().default("disabled"),
    schedule: z.string().trim().min(1).optional(),
    summarize_after_events: z.number().int().positive().optional()
  })
  .strict();

const memoryRetentionSchema = z
  .object({
    forgetting: z.enum(["manual", "decay", "ttl"]).optional().default("manual"),
    ttl: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.forgetting !== "ttl" && value.ttl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "memory retention ttl is only valid when forgetting is ttl"
      });
    }
  });

const memoryAccessSchema = z
  .object({
    members: z.array(z.string().trim().min(1)).optional()
  })
  .strict();

const memoryBankSchema = z
  .object({
    access: memoryAccessSchema.optional(),
    consolidation: memoryConsolidationSchema.optional(),
    id: memoryIdSchema,
    index: memoryIndexSchema.optional(),
    retention: memoryRetentionSchema.optional(),
    store: memoryStoreSchema
  })
  .strict();

export const memoryBanksSchema = z.array(memoryBankSchema).superRefine((value, context) => {
  const ids = value.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "memory ids must be unique"
    });
  }
});

export type MemoryAccess = z.infer<typeof memoryAccessSchema>;
export type MemoryBank = z.infer<typeof memoryBankSchema>;
export type MemoryConsolidation = z.infer<typeof memoryConsolidationSchema>;
export type MemoryIndex = z.infer<typeof memoryIndexSchema>;
export type MemoryRetention = z.infer<typeof memoryRetentionSchema>;
export type MemoryStore = z.infer<typeof memoryStoreSchema>;
