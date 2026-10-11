import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { historyKey } from "./history.js";
import { compareInstants } from "./instant.js";
import { emptyMoltnetSnapshot, moltnetMessages, parseMoltnetSnapshot, rewindMoltnetJson } from "./moltnetJson.js";
import { rewindMoltnetSqlite } from "./moltnetSqlite.js";
import type { InputContext, InputResult } from "./types.js";

export const materializeMoltnet = async (context: InputContext): Promise<InputResult> => {
  const { input, at, record, history, destination } = context;
  if (input.section !== "networks") throw new Error("Moltnet materialization requires a network input");
  if (input.overridden) {
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "state.json"), `${JSON.stringify(emptyMoltnetSnapshot(input.declaration, at), null, 2)}\n`);
    return { fidelity: "overridden", basis: "override", source: {}, notes: ["Fresh network state is stored as a JSON snapshot with the declared rooms."], instant: at };
  }
  const pin = record?.moltnet.find((entry) => entry.network === input.id);
  if (pin && compareInstants(pin.cursor, at) !== 0) {
    throw new Error(`Moltnet network ${input.id}: recorded cursor must equal wake.startedAt (${at})`);
  }
  if (!history) throw new Error(`Moltnet network ${input.id} requires --history or an override`);
  const base = `moltnet/${historyKey(input)}`;
  const json = await history.bytes(`${base}/state.json`), sqlite = await history.bytes(`${base}/moltnet.sqlite`);
  if (!json && !sqlite) throw new Error(`Missing Moltnet store ${base}/state.json or moltnet.sqlite`);
  if (json && sqlite) throw new Error(`Ambiguous Moltnet history: both state.json and moltnet.sqlite exist for ${input.id}`);
  await mkdir(destination, { recursive: true });
  let messages: Array<{ id: string; created_at: string }>;
  if (json) {
    const cut = rewindMoltnetJson(parseMoltnetSnapshot(JSON.parse(json.toString("utf8"))), at);
    messages = moltnetMessages(cut);
    await writeFile(path.join(destination, "state.json"), `${JSON.stringify(cut, null, 2)}\n`);
  } else {
    const file = path.join(destination, "moltnet.sqlite");
    await writeFile(file, sqlite!);
    // History readers never open the source database: SQLite recovery is confined to these copies.
    for (const suffix of ["-wal", "-journal"]) {
      const bytes = await history.bytes(`${base}/moltnet.sqlite${suffix}`);
      if (bytes) await writeFile(`${file}${suffix}`, bytes);
    }
    messages = await rewindMoltnetSqlite(file, at);
  }
  const retainedIds = new Set(messages.map((message) => message.id));
  const missing = pin?.messageIds?.filter((id) => !retainedIds.has(id)) ?? [];
  if (missing.length) throw new Error(`Moltnet network ${input.id}: recorded wake message IDs ${missing.join(", ")} are not retained after the cursor cut`);
  return { fidelity: pin ? "exact" : "approximate", basis: pin ? "record-cursor" : "created-at-cut",
    source: pin ? { cursor: pin.cursor } : {}, instant: at,
    notes: ["Future agent registrations and their memberships are removed; retained registration updates are clamped. Other membership history is unavailable (best effort).",
      "Room removals without a recorded removal instant retain the current removal state; current JSON Moltnet uses a zero-time marker."] };
};
