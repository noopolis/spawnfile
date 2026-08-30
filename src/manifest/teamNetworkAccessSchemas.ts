import { z } from "zod";

export const teamNetworkAgentRegistrationSchema = z.enum(["disabled", "token", "open"]);
export const teamNetworkRoomFederationSchema = z.union([
  z.enum(["none", "all"]),
  z.array(z.string().trim().min(1)).min(1).superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "room federation pairing ids must be unique"
      });
    }
  })
]);
export const teamNetworkRoomVisibilitySchema = z.enum(["public", "private"]);
export const teamNetworkRoomWritePolicySchema = z.enum([
  "members",
  "registered_agents",
  "operators"
]);
