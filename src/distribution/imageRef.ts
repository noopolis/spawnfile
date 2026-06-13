const NAME_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REGISTRY_HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

export interface ParsedImageReference {
  digest: string | null;
  name: string;
  registry: string | null;
  tag: string | null;
}

const isRegistryComponent = (component: string): boolean =>
  (component.includes(".") || component.includes(":") || component === "localhost")
  && REGISTRY_HOST_PATTERN.test(component);

const splitDigest = (value: string): { digest: string | null; rest: string } => {
  const index = value.indexOf("@");
  if (index === -1) {
    return { digest: null, rest: value };
  }
  return { digest: value.slice(index + 1), rest: value.slice(0, index) };
};

const splitTag = (value: string): { rest: string; tag: string | null } => {
  const slashIndex = value.lastIndexOf("/");
  const colonIndex = value.lastIndexOf(":");
  if (colonIndex === -1 || colonIndex < slashIndex) {
    return { rest: value, tag: null };
  }
  return { rest: value.slice(0, colonIndex), tag: value.slice(colonIndex + 1) };
};

export const parseImageReference = (value: string): ParsedImageReference | null => {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const { digest, rest: withoutDigest } = splitDigest(trimmed);
  if (digest !== null && !DIGEST_PATTERN.test(digest)) {
    return null;
  }

  const { rest: repository, tag } = splitTag(withoutDigest);
  if (tag !== null && !TAG_PATTERN.test(tag)) {
    return null;
  }

  if (!repository) {
    return null;
  }

  const components = repository.split("/");
  let registry: string | null = null;
  let nameComponents = components;
  if (components.length > 1 && isRegistryComponent(components[0]!)) {
    registry = components[0]!;
    nameComponents = components.slice(1);
  }

  if (nameComponents.length === 0 || nameComponents.some((component) => !NAME_COMPONENT.test(component))) {
    return null;
  }

  return {
    digest,
    name: nameComponents.join("/"),
    registry,
    tag
  };
};

export const parseImplicitImageReference = (
  value: string
): ParsedImageReference | null => {
  const parsed = parseImageReference(value);
  if (!parsed) {
    return null;
  }

  if (parsed.digest === null && parsed.tag === null && parsed.registry === null) {
    return null;
  }

  return parsed;
};

export const hasRegistryComponent = (value: string): boolean =>
  parseImageReference(value)?.registry !== null;
