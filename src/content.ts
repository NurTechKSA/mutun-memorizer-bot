import fs from "node:fs/promises";
import path from "node:path";
import type { CatalogBook, CatalogFile, SourcesFile } from "./types.js";

export async function readSources(contentDir: string): Promise<SourcesFile> {
  const file = path.join(contentDir, "sources.json");
  return JSON.parse(await fs.readFile(file, "utf8")) as SourcesFile;
}

export async function readCatalog(contentDir: string): Promise<CatalogFile> {
  const file = path.join(contentDir, "catalog.json");
  return JSON.parse(await fs.readFile(file, "utf8")) as CatalogFile;
}

export function findBook(catalog: CatalogFile, bookId: string): CatalogBook | undefined {
  return catalog.books.find((book) => book.id === bookId);
}

export function chunksPerDay(pace: string): number {
  if (pace === "fast") return 3;
  if (pace === "normal") return 2;
  return 1;
}
