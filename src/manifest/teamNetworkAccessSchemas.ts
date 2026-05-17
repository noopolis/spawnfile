import { z } from "zod";

export const teamNetworkAgentRegistrationSchema = z.enum(["disabled", "token", "open"]);
export const teamNetworkRoomVisibilitySchema = z.enum(["public", "private"]);
export const teamNetworkRoomWritePolicySchema = z.enum([
  "members",
  "registered_agents",
  "operators"
]);
