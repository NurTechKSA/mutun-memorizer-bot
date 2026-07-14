import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PNG } from "pngjs";
import { readSources } from "../src/content.js";
import { resolveFromRoot } from "../src/paths.js";
import type { CatalogBook, CatalogFile } from "../src/types.js";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;
const contentDir = resolveFromRoot(process.env.CONTENT_DIR ?? "./content");
const pageDpi = Number(process.env.PDF_DPI ?? 170);
const audioTimingDir = path.join(contentDir, "audio-timings");

const sources = await readSources(contentDir);
const books: CatalogBook[] = [];

for (const book of sources.books) {
  const rawDir = path.join(contentDir, "raw", book.id);
  const preparedDir = path.join(contentDir, "prepared", book.id);
  const imageDir = path.join(preparedDir, "images");
  const audioDir = path.join(preparedDir, "audio");

  await fs.rm(preparedDir, { recursive: true, force: true });
  await fs.mkdir(imageDir, { recursive: true });
  await fs.mkdir(audioDir, { recursive: true });

  const pdfPath = path.join(rawDir, book.pdf.filename);
  const audioPath = path.join(rawDir, book.audio.filename);
  await assertReadable(pdfPath);
  await assertReadable(audioPath);

  const fullPdfPath = path.join(preparedDir, "matn.pdf");
  const preparedAudioPath = path.join(preparedDir, "matn.mp3");
  const pdfRange = book.pdf.pageRange;
  const studyRange = book.pdf.studyRange ?? pdfRange;
  const renderFrom = studyRange?.from;
  const renderTo = studyRange?.to;

  if (pdfRange) {
    await extractPdfRange(pdfPath, fullPdfPath, pdfRange.from, pdfRange.to);
  } else {
    await fs.copyFile(pdfPath, fullPdfPath);
  }

  await fs.copyFile(audioPath, preparedAudioPath);

  const renderArgs = ["-png", "-r", String(pageDpi)];
  if (renderFrom && renderTo) renderArgs.push("-f", String(renderFrom), "-l", String(renderTo));
  renderArgs.push(pdfPath, path.join(imageDir, "page"));
  await run("pdftoppm", renderArgs);

  const images = (await fs.readdir(imageDir))
    .filter((file) => file.endsWith(".png"))
    .sort((a, b) => pageNumber(a) - pageNumber(b));

  if (images.length === 0) {
    throw new Error(`No rendered pages for ${book.id}`);
  }

  const pageInfos = [];
  for (const [index, image] of images.entries()) {
    const imagePath = path.join(imageDir, image);
    const sourcePageNumber = renderFrom ? renderFrom + index : index + 1;
    const inkWeight = await pageInkWeight(imagePath);
    pageInfos.push({ image, imagePath, sourcePageNumber, inkWeight });
  }

  if (pageInfos.length === 0) {
    throw new Error(`No non-empty rendered pages for ${book.id}`);
  }

  const chunks = [];
  const manualTimings = await readAudioTimingFile(book.id);
  const expectedPages = pageInfos.map((page) => page.sourcePageNumber);
  const pageAudio = manualTimings
    ? await splitAudioByManualTimings(audioPath, audioDir, book.id, expectedPages, manualTimings)
    : await splitAudioByPages(
        audioPath,
        audioDir,
        pageInfos.map((page) => ({
          imagePath: page.imagePath,
          outputFileName: `page-${String(page.sourcePageNumber).padStart(3, "0")}.mp3`,
          weight: page.inkWeight
        }))
      );

  for (const [index, page] of pageInfos.entries()) {
    chunks.push({
      index,
      title: `${book.titleRu} ${index + 1}`,
      imagePath: path.posix.join("prepared", book.id, "images", page.image),
      audioPath: pageAudio.paths[index],
      audioStatus: pageAudio.status,
      sourcePageNumber: page.sourcePageNumber
    });
  }

  books.push({
    id: book.id,
    titleRu: book.titleRu,
    titleAr: book.titleAr,
    author: book.author,
    sourcePage: book.sourcePage,
    rightsNote: book.rightsNote,
    fullPdfPath: path.posix.join("prepared", book.id, "matn.pdf"),
    audioPath: path.posix.join("prepared", book.id, "matn.mp3"),
    audioScope: "page",
    audioStatus: pageAudio.status,
    chunks
  });

  console.log(`prepared ${book.id}: ${chunks.length} chunks, audio=${pageAudio.status}`);
}

const catalog: CatalogFile = {
  generatedAt: new Date().toISOString(),
  books
};

await fs.writeFile(path.join(contentDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`saved ${path.relative(process.cwd(), path.join(contentDir, "catalog.json"))}`);

async function assertReadable(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing file: ${filePath}. Run npm run content:fetch first.`);
  }
}

function pageNumber(fileName: string): number {
  const match = fileName.match(/-(\d+)\.png$/);
  return match ? Number(match[1]) : 0;
}

async function run(command: string, args: string[]): Promise<void> {
  const { code, output } = await spawnProcess(command, args);
  if (code !== 0) {
    throw new Error(`${command} failed with code ${code}\n${output}`);
  }
}

async function extractPdfRange(sourcePdf: string, destinationPdf: string, from: number, to: number): Promise<void> {
  const tmpDir = `${destinationPdf}.pages`;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  const pagePattern = path.join(tmpDir, "page-%03d.pdf");
  await run("pdfseparate", ["-f", String(from), "-l", String(to), sourcePdf, pagePattern]);
  const pages = (await fs.readdir(tmpDir))
    .filter((file) => file.endsWith(".pdf"))
    .sort()
    .map((file) => path.join(tmpDir, file));
  if (pages.length === 0) throw new Error(`No PDF pages extracted for ${sourcePdf}`);
  await run("pdfunite", [...pages, destinationPdf]);
  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function splitAudioByPages(
  sourceAudioPath: string,
  audioDir: string,
  pages: { imagePath: string; outputFileName: string; weight: number }[]
): Promise<{ paths: string[]; status: "estimated" }> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide a binary path.");
  }

  const duration = await audioDurationSeconds(sourceAudioPath);
  const weights = pages.map((page) => Math.max(1, page.weight));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) throw new Error(`Could not calculate page weights for ${sourceAudioPath}`);

  const paths: string[] = [];
  let cursor = 0;

  for (const [index, page] of pages.entries()) {
    const remainingPages = pages.length - index;
    const remainingDuration = Math.max(0.5, duration - cursor);
    const segmentDuration =
      index === pages.length - 1
        ? remainingDuration
        : Math.max(1, Math.min(remainingDuration - (remainingPages - 1), duration * (weights[index] / totalWeight)));
    const outputPath = path.join(audioDir, page.outputFileName);

    await run(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      formatSeconds(cursor),
      "-t",
      formatSeconds(segmentDuration),
      "-i",
      sourceAudioPath,
      "-vn",
      "-ac",
      "1",
      "-b:a",
      "96k",
      outputPath
    ]);

    paths.push(path.posix.join("prepared", path.basename(path.dirname(audioDir)), "audio", page.outputFileName));
    cursor += segmentDuration;
  }

  return { paths, status: "estimated" };
}

type AudioTimingFile = {
  bookId: string;
  status: "verified";
  notes?: string;
  pages: {
    sourcePageNumber: number;
    start: number;
    end: number;
    note?: string;
  }[];
};

async function readAudioTimingFile(bookId: string): Promise<AudioTimingFile | undefined> {
  const filePath = path.join(audioTimingDir, `${bookId}.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as AudioTimingFile;
    if (parsed.bookId !== bookId) {
      throw new Error(`Timing file ${filePath} has bookId=${parsed.bookId}`);
    }
    if (parsed.status !== "verified") {
      throw new Error(`Timing file ${filePath} must have status=verified`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function splitAudioByManualTimings(
  sourceAudioPath: string,
  audioDir: string,
  bookId: string,
  expectedPages: number[],
  timing: AudioTimingFile
): Promise<{ paths: string[]; status: "verified" }> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide a binary path.");
  }

  validateManualTimings(bookId, expectedPages, timing);

  const paths: string[] = [];
  for (const page of timing.pages) {
    const outputFileName = `page-${String(page.sourcePageNumber).padStart(3, "0")}.mp3`;
    const outputPath = path.join(audioDir, outputFileName);

    await run(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      formatSeconds(page.start),
      "-to",
      formatSeconds(page.end),
      "-i",
      sourceAudioPath,
      "-vn",
      "-ac",
      "1",
      "-b:a",
      "96k",
      outputPath
    ]);

    paths.push(path.posix.join("prepared", path.basename(path.dirname(audioDir)), "audio", outputFileName));
  }

  return { paths, status: "verified" };
}

function validateManualTimings(bookId: string, expectedPages: number[], timing: AudioTimingFile): void {
  if (timing.pages.length !== expectedPages.length) {
    throw new Error(
      `${bookId}: timing page count ${timing.pages.length} does not match rendered pages ${expectedPages.length}`
    );
  }

  for (const [index, page] of timing.pages.entries()) {
    const expectedPage = expectedPages[index];
    if (page.sourcePageNumber !== expectedPage) {
      throw new Error(`${bookId}: timing page ${page.sourcePageNumber} should be ${expectedPage} at index ${index}`);
    }
    if (!Number.isFinite(page.start) || !Number.isFinite(page.end) || page.start < 0 || page.end <= page.start) {
      throw new Error(`${bookId}: invalid timing for source page ${page.sourcePageNumber}`);
    }
    const previous = timing.pages[index - 1];
    if (previous && page.start < previous.end - 0.05) {
      throw new Error(`${bookId}: page ${page.sourcePageNumber} overlaps previous page`);
    }
  }
}

async function audioDurationSeconds(audioPath: string): Promise<number> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide a binary path.");
  }

  const { output } = await spawnProcess(ffmpegPath, ["-i", audioPath]);
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`Could not read audio duration for ${audioPath}`);

  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function pageInkWeight(imagePath: string): Promise<number> {
  const buffer = await fs.readFile(imagePath);
  const image = PNG.sync.read(buffer);
  const { width, height, data } = image;
  const xFrom = Math.floor(width * 0.04);
  const xTo = Math.ceil(width * 0.96);
  const yFrom = Math.floor(height * 0.06);
  const yTo = Math.ceil(height * 0.96);
  let ink = 0;

  for (let y = yFrom; y < yTo; y += 2) {
    for (let x = xFrom; x < xTo; x += 2) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      if (alpha < 128) continue;

      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const brightness = red * 0.299 + green * 0.587 + blue * 0.114;

      if (brightness < 232 || max - min > 32) ink += 1;
    }
  }

  return Math.max(ink, 1);
}

function formatSeconds(seconds: number): string {
  return Math.max(0, seconds).toFixed(3);
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
