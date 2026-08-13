import { z } from "zod";

const segment = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);

const attachmentSchema = z.object({
  network: segment,
  auth: z.object({ token_id: segment }).strict(),
  dms: z.object({ enabled: z.literal(true) }).strict()
}).strict();

export const externalParticipantServiceSchema = z.object({
  id: segment,
  kind: z.literal("service"),
  surfaces: z.object({ moltnet: z.array(attachmentSchema).min(1).max(16) }).strict()
}).strict().superRefine((value, context) => {
  const networks = value.surfaces.moltnet.map((entry) => entry.network);
  if (new Set(networks).size !== networks.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "external participant networks must be unique" });
  }
});

export type ExternalParticipantService = z.infer<typeof externalParticipantServiceSchema>;
export type ExternalParticipantMoltnetAttachment = ExternalParticipantService["surfaces"]["moltnet"][number];
