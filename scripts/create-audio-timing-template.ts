import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { readCatalog } from "../src/content.js";
import { resolveFromRoot } from "../src/paths.js";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;
const contentDir = resolveFromRoot(process.env.CONTENT_DIR ?? "./content");
const bookId = process.argv[2];

if (!ffmpegPath) throw new Error("ffmpeg-static did not provide a binary path.");
if (!bookId) throw new Error("Usage: npm run audio:template -- <book-id>");

const catalog = await readCatalog(contentDir);
const book = catalog.books.find((item) => item.id === bookId);
if (!book) throw new Error(`Unknown book: ${bookId}`);

let cursor = 0;
const pages = [];
for (const chunk of book.chunks) {
  if (!chunk.audioPath || !chunk.sourcePageNumber) {
    throw new Error(`${bookId}: chunk ${chunk.index} has no page audio/source page number`);
  }
  const duration = await audioDurationSeconds(path.join(contentDir, chunk.audioPath));
  pages.push({
    sourcePageNumber: chunk.sourcePageNumber,
    start: Number(cursor.toFixed(3)),
    end: Number((cursor + duration).toFixed(3)),
    note: "Draft from current estimated audio. Verify manually before renaming to .json."
  });
  cursor += duration;
}

const draft = {
  bookId,
  status: "draft",
  notes: [
    "Rename this file to <book-id>.json and set status to verified only after listening and checking every page.",
    "prepare-content.ts refuses non-verified timing files on purpose."
  ],
  pages
};

const outputPath = path.join(contentDir, "audio-timings", `${bookId}.draft.json`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(draft, null, 2)}\n`);
console.log(path.relative(process.cwd(), outputPath));

async function audioDurationSeconds(audioPath: string): Promise<number> {
  const { output } = await spawnProcess(ffmpegPath!, ["-i", audioPath]);
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`Could not read audio duration for ${audioPath}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function spawnProcess(command: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
