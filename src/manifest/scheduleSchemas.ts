import { z } from "zod";

const schedulePromptSchema = z.string().min(1);
const scheduleTimezoneSchema = z.string().min(1);

export const agentScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      cron: z.string().min(1),
      kind: z.literal("cron"),
      prompt: schedulePromptSchema.optional(),
      timezone: scheduleTimezoneSchema.optional()
    })
    .strict(),
  z
    .object({
      every: z.string().min(1),
      kind: z.literal("every"),
      prompt: schedulePromptSchema.optional(),
      timezone: scheduleTimezoneSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("disabled")
    })
    .strict()
]);

export type AgentSchedule = z.infer<typeof agentScheduleSchema>;
