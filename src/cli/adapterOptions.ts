import type { Command } from "commander";

import { SpawnfileError } from "../shared/errors.js";

const option = "--adapter";

/** Width for routing lookahead. Specifiers are validated only when extracted. */
const adapterOptionWidth = (token: string | undefined): number =>
  token === option ? 2 : token?.startsWith(`${option}=`) ? 1 : 0;

export const skipAdapterOptions = (argv: readonly string[], start: number): number => {
  let index = start;
  for (let width = adapterOptionWidth(argv[index]); width > 0; width = adapterOptionWidth(argv[index])) {
    index += width;
  }
  return index;
};

export const splitAdapterOptions = (
  argv: string[],
  grammar?: Command | ReadonlySet<string>
): { args: string[]; adapters: string[] } => {
  const args: string[] = [];
  const adapters: string[] = [];
  let command = grammar && "commands" in grammar ? grammar : undefined;
  const valueOptions = command ? undefined : grammar as ReadonlySet<string> | undefined;
  let beforeOperand = true;

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--") {
      args.push(...argv.slice(index));
      break;
    }
    const width = adapterOptionWidth(value);
    if (width) {
      const specifier = width === 2 ? argv[++index] : value.slice(option.length + 1);
      if (!specifier?.trim() || specifier.startsWith("-")) {
        throw new SpawnfileError("validation_error", "--adapter requires a local module path or installed package name");
      }
      adapters.push(specifier);
      continue;
    }

    args.push(value);
    if (value.startsWith("-")) {
      if (argv[index + 1] !== undefined && (
        valueOptions?.has(value) || requiresNextValue(command, value)
      )) {
        // Keep the separator and its tail out of global option parsing.
        if (argv[index + 1] === "--") {
          args.push(...argv.slice(index + 1));
          break;
        }
        args.push(argv[++index]!);
      }
    } else if (beforeOperand) {
      const child = command?.commands.find((candidate) =>
        candidate.name() === value || candidate.aliases().includes(value));
      if (child) command = child;
      else beforeOperand = false;
    }
  }
  return { args, adapters };
};

const requiresNextValue = (command: Command | undefined, flag: string): boolean => {
  for (let current = command; current; current = current.parent ?? undefined) {
    const option = current.options.find(({ long, short }) => long === flag || short === flag);
    if (option) return option.required;
    if (/^-[^-].+/u.test(flag)) {
      const flags = [...flag.slice(1)].map((letter) => current!.options.find(({ short }) => short === `-${letter}`));
      const firstValue = flags.findIndex((entry) => !entry || entry.required || entry.optional);
      if (flags[0]) return firstValue === flags.length - 1 && flags[firstValue]?.required === true;
    }
  }
  return false;
};
