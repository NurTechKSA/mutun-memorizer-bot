import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { readCatalog } from "../src/content.js";
import { resolveFromRoot } from "../src/paths.js";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;
const contentDir = resolveFromRoot(process.env.CONTENT_DIR ?? "./content");
const reportPath = resolveFromRoot("tmp/audio-qa/audio-alignment-report.md");

if (!ffmpegPath) throw new Error("ffmpeg-static did not provide a binary path.");

const catalog = await readCatalog(contentDir);
const lines: string[] = [
  "# Audio Alignment Report",
  "",
  `Generated: ${new Date().toISOString()}`,
  ""
];

let totalChunks = 0;
let verifiedChunks = 0;
let estimatedChunks = 0;
let missingStatusChunks = 0;
let missingAudio = 0;

for (const book of catalog.books) {
  const statuses = new Map<string, number>();
  const chunkDurations: number[] = [];
  const suspicious: string[] = [];

  for (const chunk of book.chunks) {
    totalChunks += 1;
    const status = chunk.audioStatus ?? book.audioStatus ?? "estimated";
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    if (status === "verified") verifiedChunks += 1;
    else if (status === "missing") missingStatusChunks += 1;
    else estimatedChunks += 1;

    if (!chunk.audioPath) {
      missingAudio += 1;
      continue;
    }

    const duration = await audioDurationSeconds(path.join(contentDir, chunk.audioPath));
    chunkDurations.push(duration);
    if (duration < 5 || duration > 180) {
      suspicious.push(`page ${chunk.index + 1} / PDF ${chunk.sourcePageNumber ?? "?"}: ${duration.toFixed(1)}s`);
    }
  }

  const min = chunkDurations.length ? Math.min(...chunkDurations) : 0;
  const max = chunkDurations.length ? Math.max(...chunkDurations) : 0;
  const avg = chunkDurations.length
    ? chunkDurations.reduce((sum, duration) => sum + duration, 0) / chunkDurations.length
    : 0;

  lines.push(
    `## ${book.titleRu} (${book.id})`,
    "",
    `- Pages: ${book.chunks.length}`,
    `- Audio status: ${formatStatuses(statuses)}`,
    `- Chunk duration: min ${min.toFixed(1)}s, avg ${avg.toFixed(1)}s, max ${max.toFixed(1)}s`,
    `- Suspicious chunks: ${suspicious.length ? suspicious.join("; ") : "none"}`,
    ""
  );
}

lines.unshift(
  `Summary: ${verifiedChunks}/${totalChunks} verified, ${estimatedChunks} estimated, ${missingStatusChunks} intentionally missing, ${missingAudio} missing audio files.`,
  ""
);

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${lines.join("\n")}\n`);
console.log(path.relative(process.cwd(), reportPath));

function formatStatuses(statuses: Map<string, number>): string {
  return [...statuses.entries()].map(([status, count]) => `${status} ${count}`).join(", ");
}

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
