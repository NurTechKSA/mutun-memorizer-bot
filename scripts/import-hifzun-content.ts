import fs from "node:fs/promises";
import path from "node:path";
import { resolveFromRoot } from "../src/paths.js";
import type { CatalogBook, CatalogFile } from "../src/types.js";

type HifzunMessage = {
  id: number;
  text?: string;
  media?: {
    type: string;
    mimeType?: string;
    fileName?: string;
  };
};

type HifzunScan = {
  messages: HifzunMessage[];
};

type HifzunBookRange = {
  bookId: string;
  titleRu: string;
  titleAr: string;
  author: string;
  from: number;
  to: number;
  titlePrefix: string;
};

const contentDir = resolveFromRoot(process.env.CONTENT_DIR ?? "./content");
const importDir = path.join(contentDir, "imports", "hifzun");
const mediaDir = path.join(importDir, "media");

const hifzunRanges: HifzunBookRange[] = [
  { bookId: "al-usul-ath-thalatha", titleRu: "Три основы", titleAr: "الأصول الثلاثة وأدلتها", author: "محمد بن عبد الوهاب", from: 23, to: 190, titlePrefix: "Три основы" },
  { bookId: "al-qawaid-al-arbaa", titleRu: "Четыре правила", titleAr: "القواعد الأربع", author: "محمد بن عبد الوهاب", from: 293, to: 366, titlePrefix: "Четыре правила" },
  { bookId: "nawaqid-al-islam", titleRu: "Навакид аль-Ислам", titleAr: "نواقض الإسلام", author: "محمد بن عبد الوهاب", from: 367, to: 546, titlePrefix: "Навакид аль-Ислам" },
  { bookId: "shurut-as-salah", titleRu: "Условия, столпы и обязанности молитвы", titleAr: "شروط الصلاة وأركانها وواجباتها", author: "محمد بن عبد الوهاب", from: 547, to: 646, titlePrefix: "Условия молитвы" },
  { bookId: "al-usul-as-sitta", titleRu: "Шесть основ", titleAr: "الأصول الستة", author: "محمد بن عبد الوهاب", from: 647, to: 674, titlePrefix: "Шесть основ" },
  { bookId: "al-arbaun-an-nawawiyyah", titleRu: "Сорок хадисов ан-Навави", titleAr: "الأربعون النووية", author: "يحيى بن شرف النووي", from: 675, to: 780, titlePrefix: "Арбаин ан-Навави" },
  { bookId: "al-ajurrumiyyah", titleRu: "Аль-Аджуррумия", titleAr: "المقدمة الآجرومية", author: "محمد بن محمد بن آجروم", from: 781, to: 853, titlePrefix: "Аджуррумия" },
  { bookId: "tuhfat-al-atfal", titleRu: "Тухфат аль-атфаль", titleAr: "تحفة الأطفال", author: "سليمان الجمزوري", from: 854, to: 987, titlePrefix: "Тухфат аль-атфаль" },
  { bookId: "shurut-la-ilaha-illa-llah", titleRu: "Условия ля иляха илля-Ллах", titleAr: "شروط لا إله إلا الله وأدلتها", author: "محمد بن عبد الوهاب", from: 988, to: 1028, titlePrefix: "Условия ля иляха илля-Ллах" },
  { bookId: "al-bayquniyyah", titleRu: "Аль-Байкуния", titleAr: "منظومة البيقوني", author: "عمر بن محمد البيقوني", from: 1101, to: 1171, titlePrefix: "Байкуния" }
];

const mutedAudio = new Set([
  // Source @hifzun file №71 for "Три основы" is only ~4s while the card is much longer.
  "al-usul-ath-thalatha:70"
]);

const scans = await readScans(importDir);
const messages = dedupeMessages(scans.flatMap((scan) => scan.messages)).sort((a, b) => a.id - b.id);
const catalog = JSON.parse(await fs.readFile(path.join(contentDir, "catalog.json"), "utf8")) as CatalogFile;
const mediaFiles = await fs.readdir(mediaDir);
const imported: string[] = [];

for (const range of hifzunRanges) {
  const book = upsertBook(catalog, range);

  const rangeMessages = messages.filter((message) => message.id >= range.from && message.id <= range.to);
  const pairs = pairImageAndAudio(rangeMessages);
  if (pairs.length === 0) {
    console.log(`skipped ${range.bookId}: no hifzun pairs`);
    continue;
  }

  const missing = missingDownloadedFiles(pairs);
  if (missing.length > 0) {
    console.log(`skipped ${range.bookId}: missing ${missing.length} downloaded file(s): ${missing.slice(0, 8).join(", ")}`);
    continue;
  }

  const preparedDir = path.join(contentDir, "prepared", book.id);
  const imageDir = path.join(preparedDir, "images");
  const audioDir = path.join(preparedDir, "audio");
  await fs.rm(imageDir, { recursive: true, force: true });
  await fs.rm(audioDir, { recursive: true, force: true });
  await fs.mkdir(imageDir, { recursive: true });
  await fs.mkdir(audioDir, { recursive: true });

  const chunks: CatalogBook["chunks"] = [];
  for (const [index, pair] of pairs.entries()) {
    const number = String(index + 1).padStart(3, "0");
    const sourceImage = resolveDownloadedFile(pair.image.id);
    const sourceAudio = resolveDownloadedFile(pair.audio.id);
    const imageName = `hifzun-${number}${path.extname(sourceImage).toLowerCase() || ".jpg"}`;
    const audioName = `hifzun-${number}${path.extname(sourceAudio).toLowerCase() || ".mp3"}`;
    const muteAudio = mutedAudio.has(`${book.id}:${index}`);

    await fs.copyFile(path.join(mediaDir, sourceImage), path.join(imageDir, imageName));
    if (!muteAudio) {
      await fs.copyFile(path.join(mediaDir, sourceAudio), path.join(audioDir, audioName));
    }

    chunks.push({
      index,
      title: buildChunkTitle(range.titlePrefix, pair.image.text, index + 1),
      imagePath: path.posix.join("prepared", book.id, "images", imageName),
      audioPath: muteAudio ? undefined : path.posix.join("prepared", book.id, "audio", audioName),
      audioStatus: muteAudio ? "missing" : "verified"
    });
  }

  book.chunks = chunks;
  book.audioScope = "page";
  book.audioStatus = "verified";
  book.sourcePage = "https://t.me/hifzun";
  const note = "Verified memorization cards and matching audio were imported from the public Telegram channel @hifzun.";
  if (!book.rightsNote.includes(note)) {
    book.rightsNote = [book.rightsNote, note].filter(Boolean).join(" ");
  }

  imported.push(`${book.id}: ${chunks.length}`);
}

catalog.generatedAt = new Date().toISOString();
await fs.writeFile(path.join(contentDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`imported hifzun books:\n${imported.map((line) => `- ${line}`).join("\n")}`);

async function readScans(dir: string): Promise<HifzunScan[]> {
  const files = (await fs.readdir(dir))
    .filter((file) => file.startsWith("scan-") && file.endsWith(".json"))
    .sort();
  return Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as HifzunScan));
}

function dedupeMessages(messages: HifzunMessage[]): HifzunMessage[] {
  const byId = new Map<number, HifzunMessage>();
  for (const message of messages) byId.set(message.id, message);
  return [...byId.values()];
}

function pairImageAndAudio(messages: HifzunMessage[]): { image: HifzunMessage; audio: HifzunMessage }[] {
  const pairs: { image: HifzunMessage; audio: HifzunMessage }[] = [];
  let pendingImage: HifzunMessage | undefined;

  for (const message of messages) {
    if (message.media?.type === "MessageMediaPhoto") {
      pendingImage = message;
      continue;
    }

    if (pendingImage && message.media?.mimeType?.startsWith("audio/")) {
      pairs.push({ image: pendingImage, audio: message });
      pendingImage = undefined;
    }
  }

  return pairs;
}

function upsertBook(catalog: CatalogFile, range: HifzunBookRange): CatalogBook {
  const existing = catalog.books.find((item) => item.id === range.bookId);
  if (existing) return existing;

  const book: CatalogBook = {
    id: range.bookId,
    titleRu: range.titleRu,
    titleAr: range.titleAr,
    author: range.author,
    sourcePage: "https://t.me/hifzun",
    rightsNote: "Verified memorization cards and matching audio were imported from the public Telegram channel @hifzun.",
    audioScope: "page",
    audioStatus: "verified",
    chunks: []
  };
  catalog.books.push(book);
  return book;
}

function resolveDownloadedFile(messageId: number): string {
  const prefix = String(messageId);
  const file = mediaFiles.find((candidate) => candidate.startsWith(`${prefix}.`) || candidate.startsWith(`${prefix}-`));
  if (!file) throw new Error(`Missing downloaded media for hifzun message ${messageId}`);
  return file;
}

function missingDownloadedFiles(pairs: { image: HifzunMessage; audio: HifzunMessage }[]): number[] {
  const missing: number[] = [];
  for (const pair of pairs) {
    for (const message of [pair.image, pair.audio]) {
      const prefix = String(message.id);
      const exists = mediaFiles.some((candidate) => candidate.startsWith(`${prefix}.`) || candidate.startsWith(`${prefix}-`));
      if (!exists) missing.push(message.id);
    }
  }
  return missing;
}

function buildChunkTitle(prefix: string, text: string | undefined, fallbackNumber: number): string {
  const cleanText = text
    ?.replace(/^▪️\s*/u, "")
    .replace(/^№\s*/u, "")
    .trim();
  if (!cleanText) return `${prefix}: фрагмент ${fallbackNumber}`;
  return `${prefix}: ${cleanText}`;
}
