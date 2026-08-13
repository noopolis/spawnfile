import { open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import {
  admitLifecyclePlan,
  createDeploymentLifecycleCorrelation,
  readDeploymentRecordFromOutput,
  resolveArtifactsExportLifecycleCorrelation,
  type LifecycleInvocation,
} from "../deployment/index.js";
import { resolveProjectOutputDirectory } from "../filesystem/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, SpawnfileError } from "../shared/index.js";

import {
  createArtifactsExportLifecycleInvocation,
  type ArtifactsExportCommandOptions,
} from "./artifactsCommands.js";
import {
  createDownLifecycleInvocation,
  type DownOptions,
} from "./downCommand.js";

export const LIFECYCLE_PLAN_REQUEST_VERSION =
  "spawnfile.lifecycle-plan-request.v1" as const;
export const MAX_LIFECYCLE_PLAN_REQUEST_BYTES = 262_144;

const common = {
  compiled: z.string().min(1).max(4096).nullable(),
  docker_command: z.string().min(1).max(4096).nullable(),
  lifecycle_invocation_id: z
    .string()
    .regex(/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u),
  path: z.string().min(1).max(4096),
  timeout_ms: z.number().int().positive().nullable(),
  version: z.literal(LIFECYCLE_PLAN_REQUEST_VERSION),
};

export const lifecyclePlanRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...common,
      deployment: z.string().min(1).max(128).nullable(),
      include_private: z.boolean(),
      operation: z.literal("artifacts_export"),
      out: z.string().min(1).max(4096),
      reader_image: z.string().min(1).max(4096).nullable(),
      run_id: z.string().min(1).max(512).nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      deployment: z.string().min(1).max(128),
      export_to: z.string().min(1).max(4096).nullable(),
      force: z.boolean(),
      operation: z.literal("down"),
      reader_image: z.string().min(1).max(4096).nullable(),
      remove_volumes: z.boolean(),
    })
    .strict(),
]);
export type LifecyclePlanRequest = z.infer<typeof lifecyclePlanRequestSchema>;

const fail = (): never => {
  throw new SpawnfileError("validation_error", "Invalid lifecycle plan request");
};

const assertNoDuplicateJsonKeys = (source: string): void => {
  let offset = 0;
  const whitespace = (): void => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === "\\") offset += 2;
      else if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset)) as string;
      } else offset += 1;
    }
    return fail();
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") object();
    else if (source[offset] === "[") array();
    else if (source[offset] === '"') void string();
    else
      while (
        offset < source.length &&
        !/[\s,\]}]/u.test(source[offset] ?? "")
      )
        offset += 1;
  };
  const object = (): void => {
    offset += 1;
    whitespace();
    const keys = new Set<string>();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < source.length) {
      const key = string();
      if (keys.has(key)) fail();
      keys.add(key);
      whitespace();
      if (source[offset++] !== ":") fail();
      value();
      whitespace();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      if (source[offset++] !== ",") fail();
      whitespace();
    }
    fail();
  };
  const array = (): void => {
    offset += 1;
    whitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }
    while (offset < source.length) {
      value();
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      if (source[offset++] !== ",") fail();
      whitespace();
    }
    fail();
  };
  value();
  whitespace();
  if (offset !== source.length) fail();
};

const readStdin = async (stdin: AsyncIterable<unknown>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const raw of stdin) {
      const chunk =
        typeof raw === "string"
          ? new TextEncoder().encode(raw)
          : raw instanceof Uint8Array
            ? Uint8Array.from(raw)
            : fail();
      if (
        chunk.byteLength === 0 ||
        chunk.byteLength > MAX_LIFECYCLE_PLAN_REQUEST_BYTES - length
      )
        fail();
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } catch {
    fail();
  }
  if (length === 0) fail();
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const readFile = async (file: string): Promise<Uint8Array> => {
  const exact = path.resolve(file);
  const handle = await open(exact, "r").catch(fail);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_LIFECYCLE_PLAN_REQUEST_BYTES) fail();
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) fail();
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

export const readLifecyclePlanRequest = async (
  source: string,
  stdin: AsyncIterable<unknown>,
): Promise<LifecyclePlanRequest> => {
  try {
    const bytes = source === "-" ? await readStdin(stdin) : await readFile(source);
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (text.startsWith("\uFEFF")) fail();
    assertNoDuplicateJsonKeys(text);
    return lifecyclePlanRequestSchema.parse(JSON.parse(text));
  } catch {
    return fail();
  }
};

const timeout = (value: number | null): string | undefined =>
  value === null ? undefined : String(value);

export const createPlannedLifecycleInvocation = async (
  request: LifecyclePlanRequest,
): Promise<LifecycleInvocation> => {
  const compiled = resolveProjectOutputDirectory(
    request.path,
    request.compiled ?? undefined,
    DEFAULT_OUTPUT_DIRECTORY,
  );
  if (request.operation === "artifacts_export") {
    const options: ArtifactsExportCommandOptions = {
      compiled: request.compiled ?? undefined,
      deployment: request.deployment ?? undefined,
      dockerCommand: request.docker_command ?? undefined,
      includePrivate: request.include_private,
      json: true,
      lifecycleInvocation: request.lifecycle_invocation_id,
      out: request.out,
      readerImage: request.reader_image ?? undefined,
      runId: request.run_id ?? undefined,
      timeout: timeout(request.timeout_ms),
    };
    const correlation = await resolveArtifactsExportLifecycleCorrelation({
      compiledOutputDirectory: compiled,
      deploymentName: options.deployment,
      runId: options.runId,
    });
    return createArtifactsExportLifecycleInvocation(
      request.lifecycle_invocation_id,
      options,
      compiled,
      correlation,
    );
  }
  const options: DownOptions = {
    compiled: request.compiled ?? undefined,
    deployment: request.deployment,
    dockerCommand: request.docker_command ?? undefined,
    exportTo: request.export_to ?? undefined,
    force: request.force,
    json: true,
    lifecycleInvocation: request.lifecycle_invocation_id,
    readerImage: request.reader_image ?? undefined,
    timeout: timeout(request.timeout_ms),
    volumes: request.remove_volumes,
  };
  const record = await readDeploymentRecordFromOutput(
    compiled,
    request.deployment,
  );
  return createDownLifecycleInvocation(
    request.lifecycle_invocation_id,
    compiled,
    options,
    createDeploymentLifecycleCorrelation(record),
  );
};

export const planLifecycleInvocation = async (
  request: LifecyclePlanRequest,
): Promise<LifecycleInvocation> =>
  admitLifecyclePlan(await createPlannedLifecycleInvocation(request));
