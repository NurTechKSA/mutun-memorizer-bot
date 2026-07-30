import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

type CliOptions = {
  peer: string;
  limit: number;
  ids?: number[];
  send?: string;
  download: boolean;
  click?: string;
  waitMs: number;
};

type MessageSummary = {
  id: number;
  date?: string;
  text: string;
  media?: {
    type: string;
    mimeType?: string;
    fileName?: string;
    size?: string;
    downloadedTo?: string;
  };
  buttons: Array<Array<{
    text?: string;
    type: string;
    dataBase64?: string;
    url?: string;
  }>>;
};

const envPath = process.env.TELEGRAM_ENV ?? ".env.telegram.local";
dotenv.config({ path: envPath, override: true });

const options = parseCli(process.argv.slice(2));
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionPath = process.env.TELEGRAM_SESSION_FILE ?? ".secrets/telegram-hifz.session";
const importDir = process.env.TELEGRAM_IMPORT_DIR ?? "content/imports/hifzun";

if (!Number.isFinite(apiId) || !apiHash) {
  console.error(`Fill TELEGRAM_API_ID and TELEGRAM_API_HASH in ${envPath} first.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
fs.mkdirSync(importDir, { recursive: true });

const rl = readline.createInterface({ input, output });

try {
  const session = new StringSession(readTextIfExists(sessionPath));
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: "NurTech Hifz Importer",
    appVersion: "1.0.0",
    langCode: "ru",
  });

  await client.start({
    phoneNumber: async () => rl.question("Telegram phone number: "),
    phoneCode: async () => rl.question("Telegram login code: "),
    password: async () => rl.question("Telegram 2FA password: "),
    onError: (error) => console.error("Telegram auth error:", error.message),
  });

  fs.writeFileSync(sessionPath, session.save(), { mode: 0o600 });

  const peer = normalizePeer(options.peer);
  const entity = await client.getEntity(peer);

  if (options.send) {
    await client.sendMessage(entity, { message: options.send });
    await wait(options.waitMs);
  }

  if (options.click) {
    await clickButton(client, entity, options.click);
    await wait(options.waitMs);
  }

  const messages = options.ids?.length
    ? await getMessagesByIds(client, entity, options.ids)
    : await client.getMessages(entity, { limit: options.limit });
  const mediaDir = path.join(importDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  const summaries: MessageSummary[] = [];

  for (const message of messages) {
    const summary = summarizeMessage(message);
    if (options.download && isDownloadableMedia((message as any).media)) {
      const fileName = buildMediaFileName(message);
      const outputFile = path.join(mediaDir, fileName);
      if (!fs.existsSync(outputFile)) {
        await client.downloadFile((message as any).media, { outputFile });
      }
      summary.media = {
        ...(summary.media ?? { type: (message as any).media.className ?? "media" }),
        downloadedTo: outputFile,
      };
    }
    summaries.push(summary);
  }

  const reportPath = path.join(importDir, `scan-${new Date().toISOString().replaceAll(":", "-")}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    peer,
    scannedAt: new Date().toISOString(),
    count: summaries.length,
    messages: summaries,
  }, null, 2));

  console.log(`Saved scan: ${reportPath}`);
  console.log(`Session saved locally: ${sessionPath}`);
} finally {
  rl.close();
}

function parseCli(args: string[]): CliOptions {
  const options: CliOptions = {
    peer: "hifzun",
    limit: 50,
    download: false,
    waitMs: 3000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--peer" && next) {
      options.peer = next;
      index += 1;
    } else if (arg === "--limit" && next) {
      options.limit = Number(next);
      index += 1;
    } else if (arg === "--ids" && next) {
      options.ids = parseIds(next);
      index += 1;
    } else if (arg === "--send" && next) {
      options.send = next;
      index += 1;
    } else if (arg === "--click" && next) {
      options.click = next;
      index += 1;
    } else if (arg === "--wait-ms" && next) {
      options.waitMs = Number(next);
      index += 1;
    } else if (arg === "--download") {
      options.download = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive number");
  }

  return options;
}

function parseIds(value: string): number[] {
  const ids: number[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes("-")) {
      const [fromRaw, toRaw] = trimmed.split("-");
      const from = Number(fromRaw);
      const to = Number(toRaw);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error(`Invalid --ids range: ${trimmed}`);
      }
      const step = from <= to ? 1 : -1;
      for (let id = from; step > 0 ? id <= to : id >= to; id += step) {
        ids.push(id);
      }
    } else {
      const id = Number(trimmed);
      if (!Number.isFinite(id)) throw new Error(`Invalid --ids value: ${trimmed}`);
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

function normalizePeer(peer: string): string {
  return peer.startsWith("@") ? peer : `@${peer}`;
}

function readTextIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
}

async function getMessagesByIds(client: TelegramClient, entity: unknown, ids: number[]): Promise<unknown[]> {
  const messages: unknown[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const chunkMessages = await client.getMessages(entity as never, { ids: chunk as never });
    for (const message of chunkMessages) {
      if (message) messages.push(message);
    }
  }
  return messages;
}

function summarizeMessage(message: any): MessageSummary {
  const media = message.media ? summarizeMedia(message.media) : undefined;
  return {
    id: Number(message.id),
    date: message.date ? new Date(Number(message.date) * 1000).toISOString() : undefined,
    text: message.message ?? "",
    media,
    buttons: summarizeButtons(message.replyMarkup),
  };
}

function summarizeMedia(media: any): MessageSummary["media"] {
  const document = media.document;
  return {
    type: media.className ?? "media",
    mimeType: document?.mimeType,
    fileName: getDocumentFileName(document),
    size: document?.size?.toString(),
  };
}

function isDownloadableMedia(media: any): boolean {
  if (!media) return false;
  return media.className === "MessageMediaPhoto" || Boolean(media.document);
}

function summarizeButtons(replyMarkup: any): MessageSummary["buttons"] {
  if (!replyMarkup?.rows) return [];
  return replyMarkup.rows.map((row: any) => {
    return (row.buttons ?? []).map((button: any) => ({
      text: button.text,
      type: button.className ?? "button",
      dataBase64: button.data ? Buffer.from(button.data).toString("base64") : undefined,
      url: button.url,
    }));
  });
}

function getDocumentFileName(document: any): string | undefined {
  const attributes = document?.attributes ?? [];
  const fileNameAttr = attributes.find((attr: any) => typeof attr.fileName === "string");
  return fileNameAttr?.fileName;
}

function buildMediaFileName(message: any): string {
  const media = message.media;
  const document = media?.document;
  const original = getDocumentFileName(document);
  if (original) return `${message.id}-${sanitizeFileName(original)}`;

  const extension = extensionFromMime(document?.mimeType) ?? extensionFromClass(media?.className);
  return `${message.id}.${extension}`;
}

function extensionFromMime(mimeType?: string): string | undefined {
  if (!mimeType) return undefined;
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  return undefined;
}

function extensionFromClass(className?: string): string {
  if (className === "MessageMediaPhoto") return "jpg";
  return "bin";
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 180);
}

async function clickButton(client: TelegramClient, entity: any, click: string): Promise<void> {
  const [messageIdRaw, rowRaw, colRaw] = click.split(":");
  const messageId = Number(messageIdRaw);
  const row = Number(rowRaw);
  const col = Number(colRaw);

  if (![messageId, row, col].every(Number.isFinite)) {
    throw new Error("--click format must be messageId:row:col");
  }

  const [message] = await client.getMessages(entity, { ids: [messageId] as any });
  const button = (message as any)?.replyMarkup?.rows?.[row]?.buttons?.[col];
  if (!button) throw new Error(`Button not found: ${click}`);
  if (!button.data) throw new Error(`Button ${click} is not a callback button`);

  await client.invoke(new Api.messages.GetBotCallbackAnswer({
    peer: entity,
    msgId: messageId,
    data: Buffer.from(button.data),
  }));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
