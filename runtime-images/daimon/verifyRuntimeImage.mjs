import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "daimon.source-runtime-image-contract.v1";
const TOOL_PROOF_VERSION = "daimon.pi-world-tool-proof.v1";
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const runtimeRoot = process.env.RUNTIME_ROOT ?? "/opt/spawnfile/runtime-installs/daimon";
const imageId = process.env.RUNTIME_IMAGE_ID;
const imageReference = process.env.RUNTIME_IMAGE_REFERENCE;
const fail = (message) => { throw new TypeError(`Daimon runtime image verifier ${message}`); };
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const response = (value) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
  status: 200,
});
const tool = (tools, name) => tools.find((candidate) => candidate.name === name)
  ?? fail(`missing public ${name} tool`);
const execute = (candidate, params) =>
  candidate.execute("runtime-image-proof", params, undefined, undefined, {});

if (typeof imageId !== "string" || !SHA256.test(imageId)
  || typeof imageReference !== "string" || imageReference.length < 1) {
  fail("missing immutable image authority");
}

const treeEntries = [];
const walk = async (directory, relative = "") => {
  for (const name of (await readdir(directory)).sort()) {
    const absolute = path.join(directory, name);
    const child = relative === "" ? name : `${relative}/${name}`;
    const stat = await lstat(absolute);
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) {
      treeEntries.push({ mode, path: child, type: "directory" });
      await walk(absolute, child);
    } else if (stat.isFile()) {
      const bytes = await readFile(absolute);
      treeEntries.push({ bytes: bytes.length, mode, path: child, sha256: sha256(bytes), type: "file" });
    } else if (stat.isSymbolicLink()) {
      treeEntries.push({ mode, path: child, target: await readlink(absolute), type: "symlink" });
    } else fail(`unsupported runtime tree entry ${child}`);
  }
};
await walk(runtimeRoot);
const runtimeTreeDigest = sha256(canonical(treeEntries));

const daimonPiRoot = path.join(runtimeRoot, "node_modules/@noopolis/daimon/dist/pi");
const worldToolsFile = path.join(daimonPiRoot, "worldTools.js");
const worldProtocolFile = path.join(daimonPiRoot, "worldToolProtocol.js");
const worldTrajectoryFile = path.join(daimonPiRoot, "worldTrajectory.js");
const mnemeCausalFile = path.join(runtimeRoot, "node_modules/@noopolis/mneme/dist/contract/causal.js");
const [worldToolsBytes, worldProtocolBytes, worldTrajectoryBytes, mnemeCausalBytes] = await Promise.all([
  readFile(worldToolsFile), readFile(worldProtocolFile), readFile(worldTrajectoryFile), readFile(mnemeCausalFile),
]);
if (!worldTrajectoryBytes.toString("utf8").includes(
  "record?.isError === true\n        ? record?.result\n        : resultRecord?.details ?? record?.result",
) || mnemeCausalBytes.toString("utf8").includes("unset-run")) {
  fail("source-current runtime discriminator drift");
}

const publicPi = await import(pathToFileURL(path.join(daimonPiRoot, "index.js")).href);
if (typeof publicPi.createPiWorldTools !== "function" || !Array.isArray(publicPi.PI_WORLD_TOOL_NAMES)) {
  fail("built public Pi tool module drift");
}
const bearer = "verifier-private-world-bearer";
const decisionToken = "verifier-private-decision-token";
const contextRef = { current: Object.freeze({ requestId: "request-image-proof", wakeId: "wake-image-proof" }) };
const requests = [];
const tools = publicPi.createPiWorldTools({
  world: { url: "http://proof.invalid/v1/world", tokenEnv: "WORLD_PROOF_TOKEN" },
  contextRef,
  readEnvironment: (name) => name === "WORLD_PROOF_TOKEN" ? bearer : undefined,
  fetch: async (url, init) => {
    requests.push({
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: JSON.parse(String(init?.body)),
      url: String(url),
    });
    if (String(url).endsWith("/claim")) return response({
      decision_id: "decision-image-proof",
      decision_token: decisionToken,
      issued_at_tick: 11,
      valid_through_tick: 111,
    });
    if (String(url).endsWith("/observe")) return response({ tick: 11, visible: ["ball"] });
    return response({ disposition: "queued", receipt_id: "act-image-proof" });
  },
});
const names = tools.map(({ name }) => name);
if (canonical(names) !== canonical(publicPi.PI_WORLD_TOOL_NAMES)
  || names[0] !== "world_claim" || new Set(names).size !== 7) {
  fail("built public world tool names drift");
}
const selected = ["world_claim", "world_observe", "world_act"].map((name) => tool(tools, name));
const schemas = Object.fromEntries(selected.map(({ name, parameters }) => [name, parameters]));
if (canonical(Object.keys(schemas.world_claim.properties)) !== "[]"
  || schemas.world_claim.additionalProperties !== false
  || canonical(Object.keys(schemas.world_observe.properties)) !== '["sense"]'
  || canonical(Object.keys(schemas.world_act.properties)) !== '["affordance","target","input"]'
  || canonical(schemas).toLowerCase().includes("token")) {
  fail("built public world tool schema drift");
}
const outputs = [
  await execute(selected[0], {}),
  await execute(selected[1], { sense: "world://pitch/sense/vision" }),
  await execute(selected[2], {
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 1 },
  }),
];
if (canonical(outputs.map(({ details }) => details)) !== canonical([
  { claimed: true, issued_at_tick: 11, valid_through_tick: 111 },
  { tick: 11, visible: ["ball"] },
  { disposition: "queued", receipt_id: "act-image-proof" },
]) || JSON.stringify(outputs).includes(bearer) || JSON.stringify(outputs).includes(decisionToken)) {
  fail("claim to observe to act result proof drift");
}
if (canonical(requests) !== canonical([
  {
    authorization: `Bearer ${bearer}`,
    body: { request_id: "request-image-proof", wake_id: "wake-image-proof" },
    url: "http://proof.invalid/v1/world/claim",
  },
  {
    authorization: `Bearer ${bearer}`,
    body: { decision_token: decisionToken, sense: "world://pitch/sense/vision" },
    url: "http://proof.invalid/v1/world/observe",
  },
  {
    authorization: `Bearer ${bearer}`,
    body: {
      affordance: "world://pitch/affordance/kick",
      decision_token: decisionToken,
      input: { force: 1 },
      request_id: "request-image-proof",
      target: "world://pitch/entity/ball",
    },
    url: "http://proof.invalid/v1/world/act",
  },
])) fail("private claim authority transport proof drift");

const implementation = Object.freeze({
  world_tool_protocol_sha256: sha256(worldProtocolBytes),
  world_tools_sha256: sha256(worldToolsBytes),
});
const proof = Object.freeze({
  version: TOOL_PROOF_VERSION,
  sequence: Object.freeze(["world_claim", "world_observe", "world_act"]),
  public_results_token_free: true,
  public_schemas_token_free: true,
  private_authority_transport: true,
});
const toolContractDigest = sha256(canonical({ implementation, names, proof, schemas }));
const receipt = {
  version: VERSION,
  image: { id: imageId, reference: imageReference, runtime_tree_digest: runtimeTreeDigest },
  tool_contract: { digest: toolContractDigest, implementation, proof },
};
process.stdout.write(`${JSON.stringify(receipt)}\n`);
