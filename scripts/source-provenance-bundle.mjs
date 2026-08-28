import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceExcludedNames = new Set([".git", ".hg", ".svn", "node_modules", "dist", "dist-test-runtime", "coverage", ".cache", ".npm", ".runtime", ".spawn", ".spawn-dev"]);
const buildSourceExcludedNames = new Set([...sourceExcludedNames].filter((name) => name !== "dist"));
const dependencyExcludedNames = new Set([".git", ".hg", ".svn", ".cache", ".npm"]);
const credentialStoreExtension = String.raw`(?:json|ya?ml|toml|ini|conf|config|txt|db|sqlite3?|store|bak)`;
const secretName = new RegExp(String.raw`^(?:\.env(?:\..+)?|.*(?:credential|credentials|secret|secrets|token|tokens)(?:[-_.](?:auth|store|credentials?))?(?:\.${credentialStoreExtension})?)$`, "iu");
const credentialFile = new RegExp(String.raw`^(?:\.npmrc|\.netrc|\.yarnrc(?:\.yml)?|(?:auth|cookies?|keyrings?|sessions?)(?:\.${credentialStoreExtension})?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key))$`, "iu");
const credentialDirectory = new Set([".aws", ".codex", ".config", ".docker", ".gcloud", ".grok", ".ssh", "cookie", "cookies", "credential", "credentials", "gcloud", "keyring", "keyrings", "secrets", "sessions", "tokens"]);
const credentialContent = /(?:-----BEGIN ((?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY)-----\s+[A-Za-z0-9+/=\r\n]{80,}\s+-----END \1-----|AKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[0-9A-Za-z]{30,255}|github_pat_[0-9A-Za-z_]{40,255}|xox[baprs]-[0-9A-Za-z-]{20,255}|_authToken\s*[=:]\s*[0-9A-Za-z._~+\/-]{16,}|authorization\s*[=:]\s*["']Bearer\s+(?!should-not-survive)[0-9A-Za-z._~+\/-]{16,})/u;
const safeRelative = (value) => value && !path.isAbsolute(value) && !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..");

const excluded = (relative, profile, isDirectory = false) => {
  const parts = relative.split("/");
  if (profile === "go-dependencies" && relative.startsWith("gomodcache/")) return false;
  const names = profile === "dependencies" || profile === "go-dependencies" ? dependencyExcludedNames : profile === "build-source" ? buildSourceExcludedNames : sourceExcludedNames;
  return parts.some((part) => names.has(part) || credentialDirectory.has(part)) || (!isDirectory && (secretName.test(parts.at(-1)) || credentialFile.test(parts.at(-1)))) || parts.some((part) => part.endsWith("~"));
};

const assertNoCredentialContent = (relative, bytes) => {
  if (credentialContent.test(bytes.toString("utf8"))) throw new Error(`Source input contains credential-shaped content: ${relative}`);
};

const assertSymlinkGraph = (entries) => {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const origin of entries) if (origin.type === "symlink") {
    let current = origin; const seen = new Set([origin.path]);
    for (let depth = 0; depth < 40; depth += 1) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(current.path), current.link));
      if (!safeRelative(target) || seen.has(target)) throw new Error(`Source symlink chain is cyclic or escapes its root: ${origin.path}`);
      const next = byPath.get(target); if (!next) throw new Error(`Source symlink target is not an included input: ${origin.path}`);
      if (next.type === "file" || next.type === "directory") { current = undefined; break; }
      seen.add(target); current = next;
    }
    if (current) throw new Error(`Source symlink chain exceeds its bound: ${origin.path}`);
  }
};

export const collectSourceManifest = (root, profile = "source") => {
  if (!["source", "build-source", "dependencies", "go-dependencies"].includes(profile)) throw new Error("Unknown provenance bundle profile");
  const canonicalRoot = realpathSync(root);
  const entries = [];
  const visit = (relative) => {
    const absolute = path.join(canonicalRoot, relative);
    for (const name of readdirSync(absolute).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const item = lstatSync(path.join(canonicalRoot, child));
      if (excluded(child, profile, item.isDirectory())) continue;
      if (!safeRelative(child)) throw new Error("Source bundle contains an unsafe path");
      if (item.isDirectory()) { entries.push({ path: child, mode: item.mode & 0o111 ? 0o755 : 0o700, type: "directory" }); visit(child); continue; }
      if (item.isSymbolicLink()) {
        const link = readlinkSync(path.join(canonicalRoot, child));
        if (!link || path.isAbsolute(link)) throw new Error(`Source symlink escapes its root: ${child}`);
        const target = path.resolve(path.dirname(path.join(canonicalRoot, child)), link);
        const targetRelative = path.relative(canonicalRoot, target);
        if (!safeRelative(targetRelative.split(path.sep).join("/"))) throw new Error(`Source symlink escapes its root: ${child}`);
        let targetItem; try { targetItem = lstatSync(target); } catch { throw new Error(`Source symlink target is not an included input: ${child}`); }
        if (excluded(targetRelative, profile, targetItem.isDirectory())) throw new Error(`Source symlink target is not an included input: ${child}`);
        entries.push({ path: child, link, mode: item.mode & 0o777, type: "symlink" });
        continue;
      }
      if (!item.isFile()) throw new Error(`Source bundle contains an unsupported entry: ${child}`);
      const bytes = readFileSync(path.join(canonicalRoot, child));
      if (profile !== "go-dependencies" || !child.startsWith("gomodcache/")) assertNoCredentialContent(child, bytes);
      entries.push({ path: child, mode: item.mode & 0o111 ? 0o755 : 0o644, sha256: `sha256:${sha256(bytes)}`, size: bytes.length, type: "file" });
    }
  };
  visit("");
  if (!entries.length) throw new Error("Source bundle is empty");
  assertSymlinkGraph(entries);
  const names = profile === "dependencies" || profile === "go-dependencies" ? dependencyExcludedNames : profile === "build-source" ? buildSourceExcludedNames : sourceExcludedNames;
  let dependency_lock;
  if (profile === "dependencies") {
    const lockPath = path.join(canonicalRoot, "package-lock.json"), lock = readFileSync(lockPath);
    assertNoCredentialContent("package-lock.json", lock);
    let parsedLock; try { parsedLock = JSON.parse(lock.toString("utf8")); } catch { throw new Error("Dependency closure package-lock.json is invalid JSON"); }
    if (parsedLock.lockfileVersion !== 3 || !parsedLock.packages || typeof parsedLock.packages !== "object") throw new Error("Dependency closure requires package-lock v3 package graph truth");
    const required = ["npm-cache", "package-lock.json", "package.json"];
    const included = new Set(entries.map((entry) => entry.path));
    if (required.some((entry) => !included.has(entry))) throw new Error("Dependency bundle lacks the required lock-backed amd64 build/runtime closure");
    const packages = Object.entries(parsedLock.packages).filter(([key]) => key.startsWith("node_modules/")).map(([key, lockEntry]) => {
      if (typeof lockEntry.version !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockEntry.integrity ?? "")) throw new Error(`Package-lock dependency lacks immutable version/integrity: ${key.slice(13)}`);
      return { integrity: lockEntry.integrity, path: key.slice(13), version: lockEntry.version };
    }).sort((left, right) => left.path.localeCompare(right.path));
    if (!["@openai/codex", "typescript"].every((name) => packages.some((entry) => entry.path === name))) throw new Error("Dependency lock lacks pinned Codex or TypeScript");
    dependency_lock = { package_lock_sha256: `sha256:${sha256(lock)}`, packages, required, target: "linux/amd64" };
  }
  if (profile === "go-dependencies") {
    const required = ["go.mod", "go.sum", "gomodcache"], included = new Set(entries.map((entry) => entry.path));
    if (required.some((entry) => !included.has(entry))) throw new Error("Go dependency bundle lacks its module graph or cache");
    dependency_lock = { go_mod_sha256: `sha256:${sha256(readFileSync(path.join(canonicalRoot, "go.mod")))}`, go_sum_sha256: `sha256:${sha256(readFileSync(path.join(canonicalRoot, "go.sum")))}`, required, target: "linux/amd64" };
  }
  return { entries, ...(dependency_lock ? { dependency_lock } : {}), exclude_policy: { credential_content: credentialContent.source, credential_directories: [...credentialDirectory].sort(), credential_files: credentialFile.source, names: [...names].sort(), secret_names: secretName.source, editor_backups: true, profile }, root: ".", version: "spawnfile.source-input-manifest.v1" };
};

export const canonicalManifestBytes = (manifest) => Buffer.from(`${JSON.stringify(manifest)}\n`);
export const sourceManifestDigest = (manifest) => `sha256:${sha256(canonicalManifestBytes(manifest))}`;

export const assertManifestStable = (root, expected) => {
  const actual = canonicalManifestBytes(collectSourceManifest(root));
  if (!actual.equals(canonicalManifestBytes(expected))) throw new Error("Source inputs drifted while the provenance bundle was created");
};

const octal = (value, width) => `${value.toString(8).padStart(width - 1, "0")}\0`;
const tarHeader = (name, mode, size, type, link = "") => {
  const header = Buffer.alloc(512);
  const put = (value, offset, length) => header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
  let basename = name, prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const candidates = [...name.matchAll(/\//gu)].map((match) => match.index).reverse();
    const split = candidates.find((index) => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100);
    if (split === undefined) throw new Error(`Source bundle path exceeds the deterministic ustar bound: ${name}`);
    prefix = name.slice(0, split); basename = name.slice(split + 1);
  }
  if (Buffer.byteLength(link) > 100) throw new Error("Source bundle link exceeds the deterministic ustar bound");
  put(basename, 0, 100); put(octal(mode, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12); put(octal(0, 12), 136, 12); header.fill(32, 148, 156); header[156] = type.charCodeAt(0);
  put(link, 157, 100); put("ustar\0", 257, 6); put("00", 263, 2); put("root", 265, 32); put("root", 297, 32); put(prefix, 345, 155);
  put(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
};

const paxPathRecord = (name) => {
  const body = `path=${name}\n`; let length = Buffer.byteLength(body) + 3;
  for (;;) { const next = Buffer.byteLength(`${length} ${body}`); if (next === length) return Buffer.from(`${length} ${body}`); length = next; }
};

export const createSourceBundle = (root, outputPath, profile = "source", hooks = {}) => {
  const relativeOutput = path.relative(realpathSync(root), path.resolve(outputPath));
  if (relativeOutput && relativeOutput !== ".." && !relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput)) {
    throw new Error("Source bundle output must be outside its input root");
  }
  const manifest = collectSourceManifest(root, profile), chunks = [];
  const headerName = (name) => {
    try { tarHeader(name, 0o644, 0, "0"); return name; } catch (error) {
      if (!/path exceeds/u.test(error.message)) throw error;
      const pax = paxPathRecord(name), identity = sha256(Buffer.from(name)).slice(0, 32);
      chunks.push(tarHeader(`PaxHeaders/${identity}`, 0o644, pax.length, "x"), pax, Buffer.alloc((512 - pax.length % 512) % 512));
      return `entry-${identity}`;
    }
  };
  const append = (name, bytes, mode = 0o644) => {
    chunks.push(tarHeader(headerName(name), mode, bytes.length, "0"), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  };
  append(".spawnfile-source-manifest.json", canonicalManifestBytes(manifest));
  for (const entry of manifest.entries) {
    if (entry.type === "symlink") chunks.push(tarHeader(headerName(entry.path), entry.mode, 0, "2", entry.link));
    else if (entry.type === "directory") chunks.push(tarHeader(headerName(entry.path), entry.mode, 0, "5"));
    else append(entry.path, readFileSync(path.join(root, entry.path)), entry.mode);
  }
  hooks.afterRead?.();
  const actual = canonicalManifestBytes(collectSourceManifest(root, profile));
  if (!actual.equals(canonicalManifestBytes(manifest))) throw new Error("Source inputs drifted while the provenance bundle was created");
  const bytes = Buffer.concat([...chunks, Buffer.alloc(1024)]);
  writeFileSync(outputPath, bytes, { mode: 0o600 });
  return { archive_sha256: `sha256:${sha256(bytes)}`, manifest, manifest_sha256: sourceManifestDigest(manifest) };
};

const tarText = (field) => { const end = field.indexOf(0); return field.subarray(0, end < 0 ? field.length : end).toString("utf8"); };
const tarNumber = (field) => { const text = field.toString("ascii").replace(/\0.*$/u, "").trim(); if (!/^[0-7]+$/u.test(text)) throw new Error("Source bundle has an invalid numeric field"); return Number.parseInt(text, 8); };

export const validateSourceBundle = (bytes) => {
  if (bytes.length < 1024 || bytes.length % 512) throw new Error("Source bundle is truncated");
  const files = new Map(); let offset = 0, pendingPath, terminated = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) { if (!bytes.subarray(offset).every((byte) => byte === 0)) throw new Error("Source bundle has trailing data"); terminated = true; break; }
    if (tarText(header.subarray(257, 263)) !== "ustar") throw new Error("Source bundle is not strict ustar");
    const expected = tarNumber(header.subarray(148, 156)); let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (sum !== expected) throw new Error("Source bundle checksum mismatch");
    const basename = tarText(header.subarray(0, 100)), prefix = tarText(header.subarray(345, 500));
    const headerPath = prefix ? `${prefix}/${basename}` : basename, size = tarNumber(header.subarray(124, 136)), type = String.fromCharCode(header[156] || 48);
    const content = bytes.subarray(offset + 512, offset + 512 + size); if (content.length !== size) throw new Error("Source bundle is truncated");
    if (type === "x") {
      if (pendingPath) throw new Error("Source bundle has stacked path extensions");
      const record = content.toString("utf8"), match = record.match(/^([1-9][0-9]*) path=([^\n]+)\n$/u);
      if (!match || Number(match[1]) !== content.length || !safeRelative(match[2])) throw new Error("Source bundle has an unsafe path extension");
      pendingPath = match[2]; offset += 512 + Math.ceil(size / 512) * 512; continue;
    }
    const rawName = pendingPath ?? headerPath; pendingPath = undefined; const name = type === "5" && rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
    if (!safeRelative(name) || files.has(name) || !["0", "2", "5"].includes(type) || (type !== "0" && size !== 0)) throw new Error("Source bundle contains an unsafe entry");
    files.set(name, { content, link: tarText(header.subarray(157, 257)), type });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!terminated || pendingPath) throw new Error("Source bundle lacks exact termination");
  const manifestFile = files.get(".spawnfile-source-manifest.json"); if (!manifestFile || manifestFile.type !== "0") throw new Error("Source bundle lacks its input manifest");
  let manifest; try { manifest = JSON.parse(manifestFile.content.toString("utf8")); } catch { throw new Error("Source bundle manifest is invalid JSON"); }
  const profile = manifest.exclude_policy?.profile, names = profile === "dependencies" || profile === "go-dependencies" ? dependencyExcludedNames : profile === "build-source" ? buildSourceExcludedNames : sourceExcludedNames;
  const dependencyLockValid = profile !== "dependencies" || (manifest.dependency_lock?.target === "linux/amd64" && /^sha256:[a-f0-9]{64}$/u.test(manifest.dependency_lock?.package_lock_sha256) &&
    Array.isArray(manifest.dependency_lock?.packages) && manifest.dependency_lock.packages.every((entry) => /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity) && typeof entry.path === "string" && typeof entry.version === "string") &&
    JSON.stringify(manifest.dependency_lock?.required) === JSON.stringify(["npm-cache", "package-lock.json", "package.json"]));
  const goDependencyLockValid = profile !== "go-dependencies" || (manifest.dependency_lock?.target === "linux/amd64" && /^sha256:[a-f0-9]{64}$/u.test(manifest.dependency_lock?.go_mod_sha256) && /^sha256:[a-f0-9]{64}$/u.test(manifest.dependency_lock?.go_sum_sha256) && JSON.stringify(manifest.dependency_lock?.required) === JSON.stringify(["go.mod", "go.sum", "gomodcache"]));
  if (!["source", "build-source", "dependencies", "go-dependencies"].includes(profile) || manifest.version !== "spawnfile.source-input-manifest.v1" || !Array.isArray(manifest.entries) || manifest.root !== "." ||
    !dependencyLockValid ||
    !goDependencyLockValid ||
    JSON.stringify(manifest.exclude_policy) !== JSON.stringify({ credential_content: credentialContent.source, credential_directories: [...credentialDirectory].sort(), credential_files: credentialFile.source, names: [...names].sort(), secret_names: secretName.source, editor_backups: true, profile }) ||
    !canonicalManifestBytes(manifest).equals(manifestFile.content)) throw new Error("Source bundle manifest is not canonical");
  if (files.size !== manifest.entries.length + 1) throw new Error("Source bundle and manifest entry sets differ");
  for (const entry of manifest.entries) {
    const file = files.get(entry.path), expectedType = entry.type === "file" ? "0" : entry.type === "symlink" ? "2" : "5";
    if (!file || file.type !== expectedType) throw new Error("Source bundle and manifest entry sets differ");
    if (entry.type === "file" && (`sha256:${sha256(file.content)}` !== entry.sha256 || file.content.length !== entry.size)) throw new Error("Source bundle file digest mismatch");
    if (entry.type === "symlink") {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), file.link));
      if (file.link !== entry.link || !safeRelative(target) || !files.has(target)) throw new Error("Source bundle symlink mismatch");
    }
  }
  assertSymlinkGraph(manifest.entries);
  return { archive_sha256: `sha256:${sha256(bytes)}`, manifest, manifest_sha256: sourceManifestDigest(manifest) };
};
