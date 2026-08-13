import { z } from "zod";

import { teamNetworkAgentRegistrationSchema } from "./teamNetworkAccessSchemas.js";

const moltnetScopeSchema = z.enum(["observe", "write", "admin", "attach", "pair"]);

export const countTruthy = (value: unknown[]): number =>
  value.filter((entry) => Boolean(entry)).length;

const teamNetworkAuthTokenSchema = z
  .object({
    agents: z.array(z.string().trim().min(1)).optional(),
    id: z.string().trim().min(1),
    secret: z.string().trim().min(1),
    scopes: z.array(moltnetScopeSchema).min(1)
  })
  .strict();

export const isTopologyOperatorToken = (
  token: z.infer<typeof teamNetworkAuthTokenSchema>
): boolean =>
  token.id === "operator" &&
  token.agents === undefined &&
  token.scopes.length === 3 &&
  token.scopes.every((scope, index) => scope === ["admin", "observe", "write"][index]);

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

export const teamNetworkAuthSchema = z
  .object({
    agent_registration: teamNetworkAgentRegistrationSchema.optional(),
    client: teamNetworkAuthClientSchema.optional(),
    mode: z.enum(["none", "bearer", "open"]),
    public_read: z.boolean().optional(),
    tokens: z.array(teamNetworkAuthTokenSchema).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "none") {
      if (value.tokens && value.tokens.length > 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "auth.mode none must not declare tokens" });
      }
      if (value.client) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "auth.mode none must not declare client" });
      }
      return;
    }
    if (value.mode === "bearer" && !value.client && value.agent_registration !== "open") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.mode bearer requires auth.client unless agent_registration is open"
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
    if (value.mode === "open" && value.agent_registration && value.agent_registration !== "open") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.mode open requires agent_registration open when declared"
      });
    }
    if (value.tokens) {
      const tokenIds = value.tokens.map((token) => token.id);
      if (new Set(tokenIds).size !== tokenIds.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "auth.tokens ids must be unique" });
      }
      const tokenSecrets = value.tokens.map((token) => token.secret);
      if (new Set(tokenSecrets).size !== tokenSecrets.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "auth.tokens secret environment bindings must be unique"
        });
      }
    }
  });

export type TeamNetworkAuth = z.infer<typeof teamNetworkAuthSchema>;
