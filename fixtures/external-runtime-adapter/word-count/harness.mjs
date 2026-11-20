import { readFile, watch } from "node:fs/promises";

const [input, mode] = process.argv.slice(2);
async function printCount() {
  const text = await readFile(input, "utf8");
  const words = text.match(/\S+/gu) ?? [];
  process.stdout.write(`word-count: ${words.length}\n`);
}

await printCount();
if (mode === "--watch") {
  for await (const event of watch(input)) {
    if (event.eventType === "change") await printCount();
  }
}
