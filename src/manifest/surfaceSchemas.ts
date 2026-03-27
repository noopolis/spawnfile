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

const whatsappSurfaceAccessSchema = z
  .object({
    groups: z.array(z.string().min(1)).optional(),
    mode: surfaceAccessModeSchema.optional(),
    users: z.array(z.string().min(1)).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasAllowlistEntries = (value.users?.length ?? 0) + (value.groups?.length ?? 0) > 0;
    const mode = value.mode ?? (hasAllowlistEntries ? "allowlist" : undefined);

    if (!mode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "whatsapp access must declare mode or allowlist entries"
      });
    }

    if (mode !== "allowlist" && hasAllowlistEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "whatsapp access users and groups are only valid for allowlist mode"
      });
    }

    if (mode === "allowlist" && !hasAllowlistEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "whatsapp allowlist access must declare users or groups"
      });
    }
  });

const slackSurfaceAccessSchema = z
  .object({
    channels: z.array(z.string().min(1)).optional(),
    mode: surfaceAccessModeSchema.optional(),
    users: z.array(z.string().min(1)).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasAllowlistEntries = (value.users?.length ?? 0) + (value.channels?.length ?? 0) > 0;
    const mode = value.mode ?? (hasAllowlistEntries ? "allowlist" : undefined);

    if (!mode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slack access must declare mode or allowlist entries"
      });
    }

    if (mode !== "allowlist" && hasAllowlistEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slack access users and channels are only valid for allowlist mode"
      });
    }

    if (mode === "allowlist" && !hasAllowlistEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slack allowlist access must declare users or channels"
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

const whatsappSurfaceSchema = z
  .object({
    access: whatsappSurfaceAccessSchema.optional()
  })
  .strict();

const slackSurfaceSchema = z
  .object({
    access: slackSurfaceAccessSchema.optional(),
    app_token_secret: z.string().min(1).optional(),
    bot_token_secret: z.string().min(1).optional()
  })
  .strict();

export const surfacesSchema = z
  .object({
    discord: discordSurfaceSchema.optional(),
    slack: slackSurfaceSchema.optional(),
    telegram: telegramSurfaceSchema.optional(),
    whatsapp: whatsappSurfaceSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.discord && !value.telegram && !value.whatsapp && !value.slack) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "surfaces must declare at least one surface"
      });
    }
  });

export type DiscordSurfaceAccess = z.infer<typeof discordSurfaceAccessSchema>;
export type DiscordSurface = z.infer<typeof discordSurfaceSchema>;
export type SlackSurfaceAccess = z.infer<typeof slackSurfaceAccessSchema>;
export type SlackSurface = z.infer<typeof slackSurfaceSchema>;
export type TelegramSurfaceAccess = z.infer<typeof telegramSurfaceAccessSchema>;
export type TelegramSurface = z.infer<typeof telegramSurfaceSchema>;
export type WhatsAppSurfaceAccess = z.infer<typeof whatsappSurfaceAccessSchema>;
export type WhatsAppSurface = z.infer<typeof whatsappSurfaceSchema>;
export type SurfacesBlock = z.infer<typeof surfacesSchema>;
