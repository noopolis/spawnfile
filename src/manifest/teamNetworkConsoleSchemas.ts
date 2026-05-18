import { z } from "zod";

const teamNetworkConsoleAnalyticsSchema = z
  .discriminatedUnion("provider", [
    z
      .object({
        provider: z.literal("google"),
        measurement_id: z
          .string()
          .trim()
          .min(1)
          .regex(/^G-[A-Za-z0-9_-]+$/, "measurement_id must be a Google Analytics measurement ID")
      })
      .strict()
  ]);

export const teamNetworkConsoleSchema = z
  .object({
    analytics: teamNetworkConsoleAnalyticsSchema.optional()
  })
  .strict();
