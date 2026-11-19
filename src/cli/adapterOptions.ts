import { SpawnfileError } from "../shared/index.js";

const option = "--adapter";
const isAdapterOption = (value: string): boolean => value === option || value.startsWith(`${option}=`);

export const hasAdapterOption = (argv: string[]): boolean => {
  for (const value of argv) {
    if (value === "--") return false;
    if (isAdapterOption(value)) return true;
  }
  return false;
};

export const splitAdapterOptions = (argv: string[]): { args: string[]; adapters: string[] } => {
  const args: string[] = [];
  const adapters: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--") {
      args.push(...argv.slice(index));
      break;
    }
    if (!isAdapterOption(value)) {
      args.push(value);
      continue;
    }
    const specifier = value === option ? argv[++index] : value.slice(option.length + 1);
    if (!specifier?.trim() || specifier.startsWith("-")) {
      throw new SpawnfileError("validation_error", "--adapter requires a local module path or installed package name");
    }
    adapters.push(specifier);
  }
  return { args, adapters };
};
