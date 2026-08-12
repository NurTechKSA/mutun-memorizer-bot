import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const contentDir = path.resolve(process.env.CONTENT_DIR || "./content");
const catalogPath = path.join(contentDir, "catalog.json");
const minArabicChars = Number(process.env.MIN_ARABIC_CHARS || 18);
const minArabicRatio = Number(process.env.MIN_ARABIC_RATIO || 0.24);
const maxTextChars = Number(process.env.MAX_TEXT_CHARS || 7000);

const arabicRe = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/g;
const harakatRe = /[\u064b-\u065f\u0670]/g;
const controlRe = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const bidiRe = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
const stats = [];

for (const book of catalog.books || []) {
  const pdfPath = path.join(contentDir, book.fullPdfPath);
  const textDir = path.join(contentDir, "prepared", book.id, "text");
  await fs.rm(textDir, { recursive: true, force: true });
  await fs.mkdir(textDir, { recursive: true });

  let usable = 0;
  let withHarakat = 0;

  for (const chunk of book.chunks || []) {
    const page = Number(chunk.index) + 1;
    const raw = await pdftotext(pdfPath, page);
    const text = cleanText(raw);
    const quality = textQuality(text);

    if (quality.usable) {
      const fileName = `page-${String(page).padStart(2, "0")}.txt`;
      await fs.writeFile(path.join(textDir, fileName), `${text}\n`);
      chunk.textPath = path.posix.join("prepared", book.id, "text", fileName);
      usable += 1;
      if (quality.harakat > 0) withHarakat += 1;
    } else {
      delete chunk.textPath;
    }
  }

  if (usable === 0) {
    await fs.rm(textDir, { recursive: true, force: true });
  }

  stats.push({ id: book.id, pages: book.chunks.length, textPages: usable, harakatPages: withHarakat });
}

await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

for (const item of stats) {
  console.log(`${item.id}: ${item.textPages}/${item.pages} text pages, ${item.harakatPages} with harakat`);
}

function cleanText(value) {
  return value
    .normalize("NFKC")
    .replace(/\f/g, "\n")
    .replace(bidiRe, "")
    .replace(controlRe, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textQuality(text) {
  const compact = text.replace(/\s/g, "");
  const arabic = text.match(arabicRe)?.length || 0;
  const harakat = text.match(harakatRe)?.length || 0;
  const controls = text.match(controlRe)?.length || 0;
  const ratio = compact.length ? arabic / compact.length : 0;
  return {
    arabic,
    harakat,
    ratio,
    usable:
      compact.length >= 40 &&
      compact.length <= maxTextChars &&
      arabic >= minArabicChars &&
      ratio >= minArabicRatio &&
      controls <= 1
  };
}

function pdftotext(pdfPath, page) {
  return new Promise((resolve, reject) => {
    const child = spawn("pdftotext", ["-layout", "-enc", "UTF-8", "-f", String(page), "-l", String(page), pdfPath, "-"]);
    let output = "";
    let error = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      error += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`pdftotext failed for ${pdfPath} page ${page}: ${error}`));
      else resolve(output);
    });
  });
}
