import path from "node:path";

export const formatSourcePath = (
  sourcePath: string,
  projectRoot: string | undefined
): string => {
  if (!projectRoot || !path.isAbsolute(sourcePath) || !path.isAbsolute(projectRoot)) {
    return sourcePath;
  }

  const relativePath = path.relative(projectRoot, sourcePath);
  if (
    relativePath === ""
    || relativePath.startsWith("..")
    || path.isAbsolute(relativePath)
  ) {
    return sourcePath;
  }

  return relativePath.split(path.sep).join("/");
};

export const formatSourceMeta = (
  label: string,
  sourcePath: string,
  projectRoot: string | undefined
): string => {
  const formattedPath = formatSourcePath(sourcePath, projectRoot);

  return projectRoot
    ? ` ${label}=${formattedPath}`
    : ` <${formattedPath}>`;
};
