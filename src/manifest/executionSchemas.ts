import { z } from "zod";

const modelAuthMethodSchema = z.enum(["api_key", "claude-code", "codex", "none"]);
const modelEndpointCompatibilitySchema = z.enum(["anthropic", "openai"]);

const modelAuthSchema = z
  .object({
    method: modelAuthMethodSchema.optional(),
    methods: z.record(z.string(), modelAuthMethodSchema).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.method && !value.methods) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model auth must declare method or methods"
      });
    }

    if (value.method && value.methods) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model auth must not declare both method and methods"
      });
    }

    if (value.methods && Object.keys(value.methods).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model auth methods must not be empty"
      });
    }
  });

export const modelEntryAuthSchema = z
  .object({
    key: z.string().optional(),
    method: modelAuthMethodSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.method) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model auth must declare method"
      });
    }

    if (value.key && value.method !== "api_key") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model auth key is only valid for api_key auth"
      });
    }
  });

export const modelEndpointSchema = z
  .object({
    base_url: z.string().min(1),
    compatibility: modelEndpointCompatibilitySchema
  })
  .strict();

export const modelTargetSchema = z
  .object({
    auth: modelEntryAuthSchema.optional(),
    endpoint: modelEndpointSchema.optional(),
    name: z.string(),
    provider: z.string()
  })
  .strict()
  .superRefine((value, context) => {
    const usesCustomEndpoint = value.provider === "custom" || value.provider === "local";

    if (usesCustomEndpoint && !value.endpoint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.provider} models must declare endpoint`
      });
    }

    if (!usesCustomEndpoint && value.endpoint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endpoint is only valid for custom or local models"
      });
    }
  });

export const executionSchema = z
  .object({
    model: z
      .object({
        auth: modelAuthSchema.optional(),
        fallback: z.array(modelTargetSchema).optional(),
        primary: modelTargetSchema
      })
      .superRefine((value, context) => {
        const declaredProviders = new Set<string>([
          value.primary.provider,
          ...(value.fallback ?? []).map((model) => model.provider)
        ]);

        if (value.auth?.methods) {
          for (const provider of declaredProviders) {
            if (!(provider in value.auth.methods)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `model auth methods must declare provider ${provider}`
              });
            }
          }

          for (const provider of Object.keys(value.auth.methods)) {
            if (!declaredProviders.has(provider)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `model auth methods declared unknown provider ${provider}`
              });
            }
          }
        }

        for (const target of [value.primary, ...(value.fallback ?? [])]) {
          const method =
            target.auth?.method ??
            value.auth?.methods?.[target.provider] ??
            value.auth?.method ??
            (target.provider === "local" ? "none" : undefined);

          if (target.provider === "custom" && !method) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "custom models must declare auth.method or inherit legacy model auth"
            });
          }

          if (
            (target.provider === "custom" || target.provider === "local") &&
            method === "api_key" &&
            !target.auth?.key
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${target.provider} api_key auth must declare auth.key`
            });
          }
        }
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        mode: z.enum(["sandboxed", "unrestricted", "workspace"])
      })
      .strict()
      .optional()
  })
  .strict();

export type ExecutionBlock = z.infer<typeof executionSchema>;
export type ModelEndpoint = z.infer<typeof modelEndpointSchema>;
export type ModelEntryAuth = z.infer<typeof modelEntryAuthSchema>;
export type ModelTarget = z.infer<typeof modelTargetSchema>;
