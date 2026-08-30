import { z } from "zod";
import { parseEveryScheduleMs } from "../runtime/scheduleUtils.js";

const MAX_RUNTIME_STRING_BYTES = 16_384;
const MAX_RUNTIME_STRING_CODEPOINTS = 4_096;
const schedulePromptSchema = z.string().min(1).superRefine((value, context) => {
  if (!value.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "prompt must not be empty" });
  } else if (Buffer.byteLength(value, "utf8") > MAX_RUNTIME_STRING_BYTES || [...value].length > MAX_RUNTIME_STRING_CODEPOINTS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "prompt exceeds Daimon's schedule string bound" });
  }
});
const CRON_FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
const scheduleTimezoneSchema = z.string().min(1).superRefine((value, context) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "timezone must be a valid IANA timezone" }); }
});
const cronSchema = z.string().trim().min(1).superRefine((value, context) => {
  const fields = value.split(/\s+/u);
  if ([...value].length > MAX_RUNTIME_STRING_CODEPOINTS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cron exceeds Daimon's runtime string bound" });
  }
  if (fields.length !== 5 || !fields.every((field, index) => validCronField(field, CRON_FIELD_BOUNDS[index]!)) || !cronCalendarPossible(fields)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cron must contain five supported numeric fields within their bounds" });
  }
}).transform((value) => value.replace(/\s+/gu, " "));

const validCronField = (field: string, [minimum, maximum]: readonly [number, number]): boolean =>
  field.split(",").every((part) => {
    const pieces = part.split("/");
    const step = Number(pieces[1] ?? 1);
    if (pieces.length > 2 || !pieces[0] || (pieces[1] !== undefined && !/^\d+$/u.test(pieces[1])) || !Number.isSafeInteger(step) || step < 1) return false;
    const range = pieces[0]!;
    if (range === "*") return true;
    const bounds = range.split("-");
    if (bounds.length > 2 || !bounds.every((bound) => /^\d+$/u.test(bound))) return false;
    const first = Number(bounds[0]); const last = Number(bounds[1] ?? bounds[0]);
    return first >= minimum && last <= maximum && first <= last;
  });
const cronCalendarPossible = (raw: readonly string[]): boolean => {
  if (raw.length !== 5) return false;
  const fields = raw.map((field, index) => cronValues(field, CRON_FIELD_BOUNDS[index]!));
  for (let year = 2000; year < 2400; year += 1) for (const month of fields[3]!) {
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (const day of fields[2]!) if (day <= days && fields[4]!.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())) return true;
  }
  return false;
};
const cronValues = (field: string, [minimum, maximum]: readonly [number, number]): number[] => {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const [range, rawStep] = part.split("/"); const step = Number(rawStep ?? 1);
    const bounds = range === "*" ? [minimum, maximum] : range!.split("-").map(Number);
    for (let value = bounds[0]!; value <= (bounds[1] ?? bounds[0]!); value += step) result.add(value === 7 && maximum === 7 ? 0 : value);
  }
  return [...result];
};
const everySchema = z.string().trim().min(1).superRefine((value, context) => {
  if (parseEveryScheduleMs(value) === null) context.addIssue({ code: z.ZodIssueCode.custom, message: "every must be a positive duration" });
});

export const agentScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      cron: cronSchema,
      kind: z.literal("cron"),
      prompt: schedulePromptSchema.optional(),
      timezone: scheduleTimezoneSchema.optional()
    })
    .strict(),
  z
    .object({
      every: everySchema,
      kind: z.literal("every"),
      prompt: schedulePromptSchema.optional(),
      timezone: scheduleTimezoneSchema.optional()
    })
    .strict()
    .superRefine((value, context) => {
      if (value.timezone !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "every schedules cannot declare a timezone" });
    }),
  z
    .object({
      kind: z.literal("disabled")
    })
    .strict()
]);

export type AgentSchedule = z.infer<typeof agentScheduleSchema>;
