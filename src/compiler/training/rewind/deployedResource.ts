import type { InputContext } from "./types.js";

/** Deployment IDs remain evidence only: all bytes are read from the contained history mirror. */
export const deployedResource = async (context: InputContext) => {
  const agentId = context.agentId ?? context.record?.agent
    ?? (context.input.declaredBy.startsWith("agent:") ? context.input.declaredBy : undefined);
  const entry = await context.history?.deploymentResources(context.at, agentId);
  if (!entry) return null;
  const pins = entry.resources.filter((resource) => resource.id === context.input.id
    && (resource.declared_by === undefined || resource.declared_by === context.input.declaredBy));
  if (pins.length > 1) throw new Error(`Ambiguous deployment resource pin for ${context.input.declaredBy}/${context.input.id}`);
  const pin = pins[0];
  if (!pin) return null;
  const exact = entry.activation_exact && entry.exact !== false;
  return { pin, exact, notes: exact ? [] : [entry.activation_note
    ?? (entry.rolled_back_at ? "Trial instant falls inside an inexact deployment rollback interval."
      : "Deployment activation boundary is inexact; an overlapping predecessor may have served different pins.")] };
};
