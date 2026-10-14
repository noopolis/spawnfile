import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const TRAINING_EVALUATOR_ROUTES_FILE = "/run/paideia/evaluator-routes.json";
export const TRAINING_TYPESAFE_SECRET_FILE = "/run/paideia/secrets/typesafe";
export const TRAINING_TYPESAFE_SECRET_INGRESS = "/run/paideia/secret-ingress/typesafe";
export const trainingEvaluatorRouteSchema = z.object({
  purpose: z.enum(["extraction", "proposals", "decisions"]),
  provider: z.enum(["codex-subscription", "typesafe"]),
  model: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  maxRequests: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxSpendUsd: z.number().finite().nonnegative().optional()
}).strict().superRefine((route, context) => {
  if (route.provider === "codex-subscription" ? route.purpose === "decisions" || route.maxSpendUsd !== undefined
    : route.purpose !== "decisions" || route.maxSpendUsd === undefined) {
    context.addIssue({ code: "custom", message: "Evaluator provider/purpose mismatch or missing TypeSafe spend budget" });
  }
});
export const trainingEvaluatorRoutesSchema = z.array(trainingEvaluatorRouteSchema).min(1).max(64)
  .refine(routes => new Set(routes.map(route => JSON.stringify([route.purpose, route.provider, route.model]))).size === routes.length,
    "Duplicate evaluator route");
/** Only a reference is declared. Secret bytes are never read by the compiler or launcher. */
export const trainingEvaluatorSecretsSchema = (source: z.ZodString) => z.array(z.object({
  provider: z.literal("typesafe"), source
}).strict()).min(1).max(1);

export const prepareTrainingEvaluators = async (root: string, config: {
  evaluatorRoutes?: z.infer<typeof trainingEvaluatorRoutesSchema>;
  evaluatorSecrets?: { provider: "typesafe"; source: string }[];
}, mappedArgs: readonly string[]): Promise<{ mounts: string[]; env: string[] }> => {
  const mounts: string[] = [], env: string[] = [];
  if (config.evaluatorRoutes) {
    const outputs = mappedArgs.flatMap((arg, index) => arg === "--out" ? [mappedArgs[index + 1]] : []);
    const output = outputs[0];
    if (outputs.length !== 1 || !output || path.posix.normalize(output) !== output ||
      !(output === "/run/training/output" || output.startsWith("/run/training/output/"))) {
      throw Error("Evaluator receipts require one mapped training --out directory");
    }
    const source = path.join(root, "evaluator-routes.json");
    await writeFile(source, JSON.stringify({ version: "paideia.evaluator-routes.v1", routes: config.evaluatorRoutes,
      receiptPath: path.posix.join(output, "evaluator-requests.jsonl") }), { mode: 0o444, flag: "wx" });
    mounts.push(`type=bind,src=${source},dst=${TRAINING_EVALUATOR_ROUTES_FILE},readonly`);
    env.push(`PAIDEIA_EVALUATOR_ROUTES_FILE=${TRAINING_EVALUATOR_ROUTES_FILE}`);
  }
  for (const secret of config.evaluatorSecrets ?? []) {
    mounts.push(`type=bind,src=${secret.source},dst=${TRAINING_TYPESAFE_SECRET_INGRESS},readonly`);
    env.push(`PAIDEIA_TYPESAFE_SECRET_FILE=${TRAINING_TYPESAFE_SECRET_FILE}`);
  }
  return { mounts, env };
};
