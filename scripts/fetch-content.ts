import fs from "node:fs/promises";
import path from "node:path";
import { readSources } from "../src/content.js";
import { resolveFromRoot } from "../src/paths.js";

const contentDir = resolveFromRoot(process.env.CONTENT_DIR ?? "./content");
const sources = await readSources(contentDir);

for (const book of sources.books) {
  const rawDir = path.join(contentDir, "raw", book.id);
  await fs.mkdir(rawDir, { recursive: true });

  await downloadIfMissing(book.pdf.url, path.join(rawDir, book.pdf.filename));
  await downloadIfMissing(book.audio.url, path.join(rawDir, book.audio.filename));
}

async function downloadIfMissing(url: string, destination: string): Promise<void> {
  const marker = `${destination}.url`;
  try {
    const stat = await fs.stat(destination);
    const previousUrl = await fs.readFile(marker, "utf8").catch(() => "");
    if (stat.size > 0) {
      if (previousUrl.trim() === url) {
        console.log(`exists ${path.relative(process.cwd(), destination)}`);
        return;
      }
      console.log(`refresh ${path.relative(process.cwd(), destination)} (source changed)`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  console.log(`download ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, data);
  await fs.writeFile(marker, `${url}\n`);
  console.log(`saved ${path.relative(process.cwd(), destination)} (${data.byteLength} bytes)`);
}
