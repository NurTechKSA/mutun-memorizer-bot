import path from "node:path";
import { Input, Markup, type Telegraf } from "telegraf";
import { chunksPerDay, findBook, readCatalog } from "./content.js";
import type { AppConfig } from "./config.js";
import { JsonStore } from "./storage.js";
import type { CatalogBook, CatalogChunk, Subscription } from "./types.js";

export async function sendDailyPortion(
  bot: Telegraf,
  config: AppConfig,
  store: JsonStore,
  chatId: number,
  bookId?: string
): Promise<void> {
  const subscription = bookId
    ? await store.getSubscription(chatId, bookId)
    : await store.getActiveSubscription(chatId);

  if (!subscription) {
    await bot.telegram.sendMessage(chatId, "Сначала выбери книгу через /start. Потом я буду присылать страницы матна и аудио к ним.");
    return;
  }

  await sendLessonForSubscription(bot, config, store, subscription, { manual: true });
}

export async function sendDuePortions(bot: Telegraf, config: AppConfig, store: JsonStore): Promise<void> {
  const now = new Date();
  const today = dateKeyInTimezone(now, config.timezone);
  const hour = hourInTimezone(now, config.timezone);
  const subscriptions = await store.listSubscriptions();

  for (const subscription of subscriptions) {
    if (!subscription.active) continue;
    if (subscription.dailyHour !== hour) continue;
    if (subscription.lastScheduledDeliveryDate === today) continue;
    if (subscription.pausedUntil && new Date(subscription.pausedUntil) > now) continue;

    try {
      await sendLessonForSubscription(bot, config, store, subscription, { scheduledDate: today });
    } catch (error) {
      console.error(`Failed to send daily lesson to ${subscription.chatId}`, error);
    }
  }
}

export async function sendStudyReminders(bot: Telegraf, config: AppConfig, store: JsonStore): Promise<void> {
  const now = new Date();
  const today = dateKeyInTimezone(now, config.timezone);
  const hour = hourInTimezone(now, config.timezone);
  const subscriptions = await store.listSubscriptions();
  const activeChatIds = [...new Set(subscriptions.filter((subscription) => subscription.active).map((subscription) => subscription.chatId))];

  for (const chatId of activeChatIds) {
    const settings = await store.getUserSettings(chatId);
    if (hour < settings.reminderHour) continue;

    const events = await store.listActivityEvents(chatId);
    const todayEvents = events.filter((event) => event.date === today);
    if (todayEvents.some((event) => event.type === "feedback")) continue;
    if (todayEvents.some((event) => event.type === "reminder_sent")) continue;

    try {
      await bot.telegram.sendMessage(
        chatId,
        [
          "Сегодня еще не занимался.",
          "",
          "Открой кабинет, получи страницу или отметь результат по уже выданной странице."
        ].join("\n"),
        Markup.inlineKeyboard([[Markup.button.webApp("Открыть кабинет", `${config.publicUrl}/app`)]])
      );
      await store.recordReminderSent(chatId, today);
    } catch (error) {
      console.error(`Failed to send study reminder to ${chatId}`, error);
    }
  }
}

export async function sendNextPage(
  bot: Telegraf,
  config: AppConfig,
  store: JsonStore,
  chatId: number,
  bookId?: string
): Promise<void> {
  const subscription = bookId
    ? await store.getSubscription(chatId, bookId)
    : await store.getActiveSubscription(chatId);

  if (!subscription) {
    await bot.telegram.sendMessage(chatId, "Сначала выбери книгу через /start.");
    return;
  }

  if (!subscription.active) {
    await bot.telegram.sendMessage(chatId, "Эта книга на паузе. Открой «Мои книги» и верни ее в занятия.");
    return;
  }

  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, subscription.bookId);
  if (!book) {
    await bot.telegram.sendMessage(chatId, "Книга не найдена в каталоге. Запусти /start и выбери заново.");
    return;
  }

  const chunk = book.chunks[subscription.nextChunkIndex];
  if (!chunk) {
    await bot.telegram.sendMessage(
      chatId,
      `В книге «${book.titleRu}» новые страницы закончились. Дальше будут приходить повторения по расписанию.`
    );
    return;
  }

  await bot.telegram.sendMessage(
    chatId,
    [
      "Следующая страница",
      "",
      `${book.titleRu} / ${book.titleAr}`,
      `Страница ${chunk.index + 1} из ${book.chunks.length}`
    ].join("\n")
  );

  await sendChunk(bot, config, subscription, book, chunk, false);
  await store.recordLessonSent(chatId, subscription.bookId, chunk.index + 1, [chunk.index]);
  await sendLessonControls(bot, chatId, book.id);
}

export async function sendSelfCheck(
  bot: Telegraf,
  config: AppConfig,
  store: JsonStore,
  chatId: number,
  bookId?: string
): Promise<void> {
  const subscription = bookId
    ? await store.getSubscription(chatId, bookId)
    : await store.getActiveSubscription(chatId);

  if (!subscription || subscription.lastLessonChunkIndexes.length === 0) {
    await bot.telegram.sendMessage(chatId, "Пока нечего проверять. Сначала получи задание через /today.");
    return;
  }

  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, subscription.bookId);
  if (!book) return;

  const buttons = subscription.lastLessonChunkIndexes.map((index) => [
    Markup.button.callback(`Показать страницу ${index + 1}`, `show:${book.id}:${index}`)
  ]);

  await bot.telegram.sendMessage(
    chatId,
    [
      "Проверка по памяти.",
      "",
      `Книга: ${book.titleRu}`,
      `Страницы: ${subscription.lastLessonChunkIndexes.map((index) => index + 1).join(", ")}`,
      "",
      "Сначала прочитай по памяти. Потом открой текст и сверяйся."
    ].join("\n"),
    Markup.inlineKeyboard(buttons)
  );
}

export async function showChunk(
  bot: Telegraf,
  config: AppConfig,
  chatId: number,
  bookId: string,
  chunkIndex: number
): Promise<void> {
  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, bookId);
  const chunk = book?.chunks[chunkIndex];
  if (!book || !chunk) {
    await bot.telegram.sendMessage(chatId, "Не нашел эту страницу. Открой /books и выбери книгу заново.");
    return;
  }

  await bot.telegram.sendPhoto(chatId, Input.fromLocalFile(path.resolve(config.contentDir, chunk.imagePath)), {
    caption: `${book.titleRu} / ${book.titleAr}\nПроверка: страница ${chunk.index + 1} из ${book.chunks.length}`
  });
}

async function sendLessonForSubscription(
  bot: Telegraf,
  config: AppConfig,
  store: JsonStore,
  subscription: Subscription,
  options: { manual?: boolean; scheduledDate?: string }
): Promise<void> {
  if (!subscription.active && options.manual) {
    await bot.telegram.sendMessage(subscription.chatId, "Занятия сейчас на паузе. Чтобы продолжить, открой /books и выбери книгу.");
    return;
  }

  if (subscription.pausedUntil && new Date(subscription.pausedUntil) > new Date()) {
    if (options.manual) {
      await bot.telegram.sendMessage(subscription.chatId, `Пауза до ${formatDate(subscription.pausedUntil)}. Можно продолжить раньше через /pause.`);
    }
    return;
  }

  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, subscription.bookId);
  if (!book) {
    await bot.telegram.sendMessage(subscription.chatId, "Книга не найдена в каталоге. Запусти /start и выбери заново.");
    return;
  }

  const dueReviewIndexes = dueReviews(subscription);
  const reviewChunks = dueReviewIndexes.map((index) => book.chunks[index]).filter(Boolean);
  const newChunks = subscription.mode === "review" ? [] : nextNewChunks(subscription, book);
  const lessonChunks = uniqueChunks([...reviewChunks, ...newChunks]);

  if (lessonChunks.length === 0) {
    if (subscription.nextChunkIndex >= book.chunks.length) {
      await bot.telegram.sendMessage(subscription.chatId, `Ты дошел до конца книги: ${book.titleRu} (${book.titleAr}). Повторения будут приходить по расписанию.`);
      return;
    }

    if (options.manual) {
      await bot.telegram.sendMessage(subscription.chatId, "На сейчас повторений нет. Новое задание придет по твоему расписанию.");
    }
    return;
  }

  await bot.telegram.sendMessage(
    subscription.chatId,
    lessonHeader(book, subscription, reviewChunks.length, newChunks.length)
  );

  for (const chunk of lessonChunks) {
    await sendChunk(bot, config, subscription, book, chunk, dueReviewIndexes.includes(chunk.index));
  }

  const nextChunkIndex = Math.max(
    subscription.nextChunkIndex,
    newChunks.length === 0 ? subscription.nextChunkIndex : newChunks[newChunks.length - 1].index + 1
  );

  await store.recordLessonSent(
    subscription.chatId,
    subscription.bookId,
    nextChunkIndex,
    lessonChunks.map((chunk) => chunk.index),
    options.scheduledDate
  );

  await sendLessonControls(bot, subscription.chatId, book.id);
}

async function sendLessonControls(bot: Telegraf, chatId: number, bookId: string): Promise<void> {
  await bot.telegram.sendMessage(
    chatId,
    [
      "Отметь результат.",
      "",
      "После отметки я покажу, что поставил в повторение, и дам кнопку для следующей страницы."
    ].join("\n"),
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Выучил", `mark:${bookId}:learned`),
        Markup.button.callback("Сложно", `mark:${bookId}:hard`)
      ],
      [Markup.button.callback("Повторить завтра", `mark:${bookId}:repeat`)],
      [
        Markup.button.callback("Проверить себя", `check:${bookId}`),
        Markup.button.callback("Расписание", "schedule")
      ]
    ])
  );
}

async function sendChunk(
  bot: Telegraf,
  config: AppConfig,
  subscription: Subscription,
  book: CatalogBook,
  chunk: CatalogChunk,
  isReview: boolean
): Promise<void> {
  const caption = [
    isReview ? "Повторение" : "Новая страница",
    `${book.titleRu} / ${book.titleAr}`,
    `Страница ${chunk.index + 1} из ${book.chunks.length}`,
    !chunk.audioPath && book.audioPath ? "Аудио ниже - чтение всего матна, не отдельной страницы." : undefined,
    chunk.audioPath && (chunk.audioStatus ?? book.audioStatus) !== "verified"
      ? "Аудио страницы пока предварительное: таймкоды сверяются."
      : undefined
  ].filter(Boolean).join("\n");

  if (subscription.mode !== "listen") {
    await bot.telegram.sendPhoto(subscription.chatId, Input.fromLocalFile(path.resolve(config.contentDir, chunk.imagePath)), {
      caption
    });
  }

  const audioPath = chunk.audioPath ?? book.audioPath;
  if (subscription.mode !== "read" && audioPath) {
    await bot.telegram.sendAudio(subscription.chatId, Input.fromLocalFile(path.resolve(config.contentDir, audioPath)), {
      title: chunk.audioPath ? `${book.titleRu}: страница ${chunk.index + 1}` : `${book.titleRu}: аудио матна`,
      performer: book.author,
      caption: subscription.mode === "listen" ? caption : undefined
    });
  }
}

function lessonHeader(book: CatalogBook, subscription: Subscription, reviewCount: number, newCount: number): string {
  const lines = [
    "Сегодняшнее задание",
    "",
    `${book.titleRu} / ${book.titleAr}`,
    `Прогресс: ${Math.min(subscription.nextChunkIndex, book.chunks.length)} из ${book.chunks.length} страниц`
  ];

  if (newCount > 0) lines.push(`Новые страницы: ${newCount}`);
  if (reviewCount > 0) lines.push(`Повторение: ${reviewCount}`);
  lines.push(`Режим: ${modeLabel(subscription.mode)}`);
  return lines.join("\n");
}

function nextNewChunks(subscription: Subscription, book: CatalogBook): CatalogChunk[] {
  if (subscription.nextChunkIndex >= book.chunks.length) return [];
  return book.chunks.slice(subscription.nextChunkIndex, subscription.nextChunkIndex + chunksPerDay(subscription.pace));
}

function dueReviews(subscription: Subscription): number[] {
  const today = new Date().toISOString().slice(0, 10);
  return [...new Set(subscription.reviewQueue.filter((item) => item.dueDate <= today).map((item) => item.chunkIndex))].sort(
    (a, b) => a - b
  );
}

function uniqueChunks(chunks: CatalogChunk[]): CatalogChunk[] {
  const seen = new Set<number>();
  return chunks.filter((chunk) => {
    if (seen.has(chunk.index)) return false;
    seen.add(chunk.index);
    return true;
  });
}

function hourInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: timezone
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value ?? "0");
}

function dateKeyInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function modeLabel(mode: Subscription["mode"]): string {
  if (mode === "read") return "только текст";
  if (mode === "listen") return "только аудио";
  if (mode === "review") return "только повторение";
  return "текст и аудио";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date(value));
}
