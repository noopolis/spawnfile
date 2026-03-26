import { z } from "zod";

const surfaceAccessModeSchema = z.enum(["allowlist", "open", "pairing"]);

const discordSurfaceAccessSchema = z
  .object({
    channels: z.array(z.string().min(1)).optional(),
    guilds: z.array(z.string().min(1)).optional(),
    mode: surfaceAccessModeSchema.optional(),
    users: z.array(z.string().min(1)).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasAllowlistEntries =
      (value.users?.length ?? 0) +
        (value.guilds?.length ?? 0) +
        (value.channels?.length ?? 0) >
      0;
    const mode = value.mode ?? (hasAllowlistEntries ? "allowlist" : undefined);

    if (!mode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "discord access must declare mode or allowlist entries"
      });
    }

    if (mode !== "allowlist" && hasAllowlistEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "discord access users, guilds, and channels are only valid for allowlist mode"
      });
    }

    if (mode === "allowlist" && !hasAllowlistEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "discord allowlist access must declare users, guilds, or channels"
      });
    }
  });

const telegramSurfaceAccessSchema = z
  .object({
    chats: z.array(z.string().min(1)).optional(),
    mode: surfaceAccessModeSchema.optional(),
    users: z.array(z.string().min(1)).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasAllowlistEntries = (value.users?.length ?? 0) + (value.chats?.length ?? 0) > 0;
    const mode = value.mode ?? (hasAllowlistEntries ? "allowlist" : undefined);

    if (!mode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "telegram access must declare mode or allowlist entries"
      });
    }

    if (mode !== "allowlist" && hasAllowlistEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "telegram access users and chats are only valid for allowlist mode"
      });
    }

    if (mode === "allowlist" && !hasAllowlistEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "telegram allowlist access must declare users or chats"
      });
    }
  });

const discordSurfaceSchema = z
  .object({
    access: discordSurfaceAccessSchema.optional(),
    bot_token_secret: z.string().min(1).optional()
  })
  .strict();

const telegramSurfaceSchema = z
  .object({
    access: telegramSurfaceAccessSchema.optional(),
    bot_token_secret: z.string().min(1).optional()
  })
  .strict();

export const surfacesSchema = z
  .object({
    discord: discordSurfaceSchema.optional(),
    telegram: telegramSurfaceSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.discord && !value.telegram) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "surfaces must declare at least one surface"
      });
    }
  });

export type DiscordSurfaceAccess = z.infer<typeof discordSurfaceAccessSchema>;
export type DiscordSurface = z.infer<typeof discordSurfaceSchema>;
export type TelegramSurfaceAccess = z.infer<typeof telegramSurfaceAccessSchema>;
export type TelegramSurface = z.infer<typeof telegramSurfaceSchema>;
export type SurfacesBlock = z.infer<typeof surfacesSchema>;
