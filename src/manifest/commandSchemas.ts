import { z } from "zod";

/** A plain image reference (registry/repo[:tag]) pinned by digest; never anything Docker could read as an option. */
export const pinnedImageSchema = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/u, "image must be a reference pinned by @sha256 digest");

/** An argv: run directly, never through a shell. */
export const argvSchema = z.array(z.string().min(1)).min(1);
