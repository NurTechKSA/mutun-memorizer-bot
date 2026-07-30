import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { findBook, isBookReadyForLessons, readCatalog } from "./content.js";
import type { AppConfig } from "./config.js";
import { JsonStore } from "./storage.js";
import type { ActivityEvent, CatalogBook, LessonFeedback, Pace, StudyMode, Subscription, UserSettings } from "./types.js";

const maxActiveBooks = 2;
const qasimMutoonBookIds = new Set([
  "al-usul-ath-thalatha",
  "al-qawaid-al-arbaa",
  "nawaqid-al-islam",
  "al-arbaun-an-nawawiyyah",
  "tuhfat-al-atfal",
  "shurut-as-salah",
  "al-usul-as-sitta",
  "shurut-la-ilaha-illa-llah",
  "kitab-at-tawhid",
  "al-bayquniyyah",
  "al-ilbiri",
  "al-ajurrumiyyah",
  "al-aqidah-al-wasitiyyah",
  "kashf-ash-shubuhat"
]);

type AuthUser = {
  chatId: number;
  firstName?: string;
  username?: string;
};

type RequestBody = Record<string, unknown>;

export async function handleAppRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  config: AppConfig,
  store: JsonStore
): Promise<boolean> {
  if (url.pathname === "/app") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderProductApp());
    return true;
  }

  if (url.pathname.startsWith("/content/")) {
    await serveContent(url.pathname, response, config);
    return true;
  }

  if (!url.pathname.startsWith("/api/app")) return false;

  const auth = authenticateTelegram(request, config);
  if (!auth) {
    sendJson(response, 401, {
      ok: false,
      error: "Открой кабинет из Telegram-бота, чтобы я понял, чей это прогресс."
    });
    return true;
  }

  const body = request.method === "POST" ? await readBody(request) : {};

  if (request.method === "GET" && url.pathname === "/api/app/state") {
    sendJson(response, 200, { ok: true, ...(await buildAppState(config, store, auth)) });
    return true;
  }

  const startMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/start$/);
  if (request.method === "POST" && startMatch) {
    const result = await startBook(config, store, auth.chatId, startMatch[1], body);
    sendJson(response, result.status, result.payload);
    return true;
  }

  const activeMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/active$/);
  if (request.method === "POST" && activeMatch) {
    const catalog = await readCatalog(config.contentDir);
    const book = findBook(catalog, activeMatch[1]);
    if (!book || !qasimMutoonBookIds.has(book.id) || !isBookReadyForLessons(book)) {
      sendJson(response, 409, { ok: false, error: "Для этой книги пока нет проверенной нарезки." });
      return true;
    }
    const subscription = await store.setActiveBook(auth.chatId, activeMatch[1]);
    sendJson(response, subscription ? 200 : 404, subscription ? { ok: true } : { ok: false, error: "Книга не найдена." });
    return true;
  }

  const pauseMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/pause$/);
  if (request.method === "POST" && pauseMatch) {
    const subscription = await store.pauseBook(auth.chatId, pauseMatch[1]);
    sendJson(response, subscription ? 200 : 404, subscription ? { ok: true } : { ok: false, error: "Книга не найдена." });
    return true;
  }

  const resumeMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/resume$/);
  if (request.method === "POST" && resumeMatch) {
    const result = await resumeBook(config, store, auth.chatId, resumeMatch[1]);
    sendJson(response, result.status, result.payload);
    return true;
  }

  const removeMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/remove$/);
  if (request.method === "POST" && removeMatch) {
    const removed = await store.removeBook(auth.chatId, removeMatch[1]);
    sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: "Книга не найдена." });
    return true;
  }

  const resetMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/reset$/);
  if (request.method === "POST" && resetMatch) {
    const subscription = await store.resetBook(auth.chatId, resetMatch[1]);
    const catalog = await readCatalog(config.contentDir);
    const book = findBook(catalog, resetMatch[1]);
    sendJson(
      response,
      subscription ? 200 : 404,
      subscription ? { ok: true, subscription: serializeSubscription(book, subscription) } : { ok: false, error: "Книга не найдена." }
    );
    return true;
  }

  const settingsMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/settings$/);
  if (request.method === "POST" && settingsMatch) {
    const result = await updateSettings(store, auth.chatId, settingsMatch[1], body);
    sendJson(response, result.status, result.payload);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/app/settings/weekly-goal") {
    const pages = typeof body.weeklyGoalPages === "number" ? body.weeklyGoalPages : Number(body.weeklyGoalPages);
    const settings = await store.setWeeklyGoal(auth.chatId, pages);
    sendJson(response, 200, { ok: true, settings });
    return true;
  }

  const nextMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/next$/);
  if (request.method === "POST" && nextMatch) {
    const result = await nextLesson(config, store, auth.chatId, nextMatch[1]);
    sendJson(response, result.status, result.payload);
    return true;
  }

  const pageLessonMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/pages\/(\d+)\/lesson$/);
  if (request.method === "POST" && pageLessonMatch) {
    const result = await lessonFromPage(config, store, auth.chatId, pageLessonMatch[1], Number(pageLessonMatch[2]));
    sendJson(response, result.status, result.payload);
    return true;
  }

  const feedbackMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/feedback$/);
  if (request.method === "POST" && feedbackMatch) {
    const feedback = typeof body.feedback === "string" ? body.feedback : "";
    if (!isFeedback(feedback)) {
      sendJson(response, 400, { ok: false, error: "Не понял результат." });
      return true;
    }

    const subscription = await store.recordFeedback(auth.chatId, feedbackMatch[1], feedback);
    const catalog = await readCatalog(config.contentDir);
    const book = findBook(catalog, feedbackMatch[1]);
    sendJson(
      response,
      subscription ? 200 : 404,
      subscription ? { ok: true, subscription: serializeSubscription(book, subscription) } : { ok: false, error: "Книга не найдена." }
    );
    return true;
  }

  const undoFeedbackMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/undo-feedback$/);
  if (request.method === "POST" && undoFeedbackMatch) {
    const subscription = await store.undoLastFeedback(auth.chatId, undoFeedbackMatch[1]);
    const catalog = await readCatalog(config.contentDir);
    const book = findBook(catalog, undoFeedbackMatch[1]);
    sendJson(
      response,
      subscription ? 200 : 404,
      subscription ? { ok: true, subscription: serializeSubscription(book, subscription) } : { ok: false, error: "Книга не найдена." }
    );
    return true;
  }

  const undoLessonMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/undo-lesson$/);
  if (request.method === "POST" && undoLessonMatch) {
    const subscription = await store.undoLastLesson(auth.chatId, undoLessonMatch[1]);
    const catalog = await readCatalog(config.contentDir);
    const book = findBook(catalog, undoLessonMatch[1]);
    sendJson(
      response,
      subscription ? 200 : 404,
      subscription ? { ok: true, subscription: serializeSubscription(book, subscription) } : { ok: false, error: "Книга не найдена." }
    );
    return true;
  }

  const removeReviewMatch = url.pathname.match(/^\/api\/app\/books\/([^/]+)\/reviews\/(\d+)\/remove$/);
  if (request.method === "POST" && removeReviewMatch) {
    const subscription = await store.removeReview(auth.chatId, removeReviewMatch[1], Number(removeReviewMatch[2]));
    const catalog = await readCatalog(config.contentDir);
    const book = findBook(catalog, removeReviewMatch[1]);
    sendJson(
      response,
      subscription ? 200 : 404,
      subscription ? { ok: true, subscription: serializeSubscription(book, subscription) } : { ok: false, error: "Книга не найдена." }
    );
    return true;
  }

  sendJson(response, 404, { ok: false, error: "Not found" });
  return true;
}

async function startBook(
  config: AppConfig,
  store: JsonStore,
  chatId: number,
  bookId: string,
  body: RequestBody
): Promise<{ status: number; payload: unknown }> {
  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, bookId);
  if (!book) return { status: 404, payload: { ok: false, error: "Книга не найдена." } };
  if (!qasimMutoonBookIds.has(book.id) || !isBookReadyForLessons(book)) {
    return { status: 409, payload: { ok: false, error: "Для этой книги пока нет проверенной нарезки. Добавим ее после проверки аудио." } };
  }

  const pace = isPace(body.pace) ? body.pace : "slow";
  const existing = await store.getSubscription(chatId, bookId);
  const readyBookIds = new Set(catalog.books.filter((item) => qasimMutoonBookIds.has(item.id) && isBookReadyForLessons(item)).map((item) => item.id));
  const activeCount = (await store.listSubscriptions(chatId)).filter((item) => item.active && readyBookIds.has(item.bookId)).length;

  if ((!existing || !existing.active) && activeCount >= maxActiveBooks) {
    return { status: 409, payload: { ok: false, error: "Можно учить максимум 2 книги одновременно." } };
  }

  const subscription = await store.upsertSubscription(chatId, bookId, pace);
  return { status: 200, payload: { ok: true, subscription: serializeSubscription(book, subscription) } };
}

async function resumeBook(
  config: AppConfig,
  store: JsonStore,
  chatId: number,
  bookId: string
): Promise<{ status: number; payload: unknown }> {
  const existing = await store.getSubscription(chatId, bookId);
  if (!existing) return { status: 404, payload: { ok: false, error: "Книга не найдена." } };

  const catalog = await readCatalog(config.contentDir);
  const readyBookIds = new Set(catalog.books.filter((item) => qasimMutoonBookIds.has(item.id) && isBookReadyForLessons(item)).map((item) => item.id));
  const activeCount = (await store.listSubscriptions(chatId)).filter((item) => item.active && readyBookIds.has(item.bookId)).length;
  if (!existing.active && activeCount >= maxActiveBooks) {
    return { status: 409, payload: { ok: false, error: "Сначала поставь одну активную книгу на паузу." } };
  }

  const book = findBook(catalog, bookId);
  if (!book || !qasimMutoonBookIds.has(book.id) || !isBookReadyForLessons(book)) {
    return { status: 409, payload: { ok: false, error: "Для этой книги пока нет проверенной нарезки." } };
  }

  const subscription = await store.resumeBook(chatId, bookId);
  return { status: 200, payload: { ok: true, subscription: serializeSubscription(findBook(catalog, bookId), subscription!) } };
}

async function updateSettings(
  store: JsonStore,
  chatId: number,
  bookId: string,
  body: RequestBody
): Promise<{ status: number; payload: unknown }> {
  let subscription: Subscription | undefined;

  if (isPace(body.pace)) subscription = await store.setBookPace(chatId, bookId, body.pace);
  if (isMode(body.mode)) subscription = await store.setBookMode(chatId, bookId, body.mode);
  if (typeof body.dailyHour === "number" && Number.isInteger(body.dailyHour) && body.dailyHour >= 0 && body.dailyHour <= 23) {
    subscription = await store.setBookDailyHour(chatId, bookId, body.dailyHour);
  }

  return subscription
    ? { status: 200, payload: { ok: true } }
    : { status: 404, payload: { ok: false, error: "Книга не найдена." } };
}

async function nextLesson(
  config: AppConfig,
  store: JsonStore,
  chatId: number,
  bookId: string
): Promise<{ status: number; payload: unknown }> {
  const subscription = await store.getSubscription(chatId, bookId);
  if (!subscription) return { status: 404, payload: { ok: false, error: "Книга не найдена." } };
  if (!subscription.active) return { status: 409, payload: { ok: false, error: "Эта книга на паузе." } };

  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, bookId);
  const chunk = book?.chunks[subscription.nextChunkIndex];
  if (!book || !chunk) return { status: 409, payload: { ok: false, error: "Новые фрагменты закончились." } };
  if (!qasimMutoonBookIds.has(book.id) || !isBookReadyForLessons(book)) {
    return { status: 409, payload: { ok: false, error: "Для этой книги пока нет проверенной нарезки." } };
  }

  await store.recordLessonSent(chatId, bookId, chunk.index + 1, [chunk.index]);
  const updated = await store.getSubscription(chatId, bookId);
  return {
    status: 200,
    payload: {
      ok: true,
      lesson: serializeLesson(config.publicUrl, book, chunk),
      subscription: serializeSubscription(book, updated!)
    }
  };
}

async function lessonFromPage(
  config: AppConfig,
  store: JsonStore,
  chatId: number,
  bookId: string,
  pageIndex: number
): Promise<{ status: number; payload: unknown }> {
  const subscription = await store.getSubscription(chatId, bookId);
  if (!subscription) return { status: 404, payload: { ok: false, error: "Сначала добавь книгу в занятия." } };
  if (!subscription.active) return { status: 409, payload: { ok: false, error: "Книга не участвует в ежедневных занятиях." } };

  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, bookId);
  const chunk = book?.chunks[pageIndex];
  if (!book || !chunk) return { status: 404, payload: { ok: false, error: "Фрагмент не найден." } };
  if (!qasimMutoonBookIds.has(book.id) || !isBookReadyForLessons(book)) {
    return { status: 409, payload: { ok: false, error: "Для этой книги пока нет проверенной нарезки." } };
  }

  await store.recordLessonSent(chatId, bookId, Math.max(subscription.nextChunkIndex, chunk.index + 1), [chunk.index]);
  const updated = await store.getSubscription(chatId, bookId);
  return {
    status: 200,
    payload: {
      ok: true,
      lesson: serializeLesson(config.publicUrl, book, chunk),
      subscription: serializeSubscription(book, updated!)
    }
  };
}

async function buildAppState(config: AppConfig, store: JsonStore, auth: AuthUser): Promise<Record<string, unknown>> {
  const catalog = await readCatalog(config.contentDir);
  const qasimBooks = catalog.books.filter((book) => qasimMutoonBookIds.has(book.id) && isBookReadyForLessons(book));
  const availableBookIds = new Set(qasimBooks.map((book) => book.id));
  const state = await store.read();
  const storedActiveBookId = state.activeBooks[String(auth.chatId)];
  const activeBookId = storedActiveBookId && availableBookIds.has(storedActiveBookId) ? storedActiveBookId : undefined;
  const rawSubscriptions = await store.listSubscriptions(auth.chatId);
  const subscriptions = rawSubscriptions
    .filter((subscription) => availableBookIds.has(subscription.bookId))
    .map((subscription) => serializeSubscription(findBook(catalog, subscription.bookId), subscription));
  const settings = await store.getUserSettings(auth.chatId);
  const activityEvents = await store.listActivityEvents(auth.chatId);

  return {
    user: auth,
    maxActiveBooks,
    activeBookId,
    books: qasimBooks.map((book) => serializeBook(config.publicUrl, book)),
    subscriptions,
    schedule: buildSchedule(config.publicUrl, qasimBooks, rawSubscriptions.filter((subscription) => availableBookIds.has(subscription.bookId))),
    activity: buildActivity(config.publicUrl, qasimBooks, rawSubscriptions.filter((subscription) => availableBookIds.has(subscription.bookId)), activityEvents, settings)
  };
}

function buildActivity(
  publicUrl: string,
  books: CatalogBook[],
  subscriptions: Subscription[],
  events: ActivityEvent[],
  settings: UserSettings
): Record<string, unknown> {
  const today = todayKey();
  const calendarDates = lastDateKeys(28);
  const historyDates = lastDateKeys(14);
  const weekDates = currentWeekDateKeys();
  const byDate = groupEventsByDate(events);
  const learnedThisWeek = weekDates.reduce((sum, date) => sum + countFeedbackPages(byDate.get(date) ?? [], "learned"), 0);
  const studiedToday = (byDate.get(today) ?? []).some((event) => event.type === "feedback");
  const lessonSentToday = (byDate.get(today) ?? []).some((event) => event.type === "lesson_sent");
  const activeCount = subscriptions.filter((subscription) => subscription.active).length;

  return {
    settings,
    today: {
      date: today,
      studied: studiedToday,
      lessonSent: lessonSentToday,
      shouldRemind: activeCount > 0 && !studiedToday,
      text: activeCount > 0 && !studiedToday
        ? "Сегодня еще не отмечал результат. Открой текущий фрагмент и нажми «Выучил», «Сложно» или «Повторить завтра»."
        : "Сегодня занятие отмечено."
    },
    weeklyGoal: {
      pages: settings.weeklyGoalPages,
      learned: learnedThisWeek,
      remaining: Math.max(0, settings.weeklyGoalPages - learnedThisWeek),
      percent: settings.weeklyGoalPages === 0 ? 0 : Math.min(100, Math.round((learnedThisWeek / settings.weeklyGoalPages) * 100)),
      dates: weekDates
    },
    calendar: calendarDates.map((date) => serializeActivityDay(date, byDate.get(date) ?? [])),
    history: historyDates.map((date) => serializeActivityDay(date, byDate.get(date) ?? [])).reverse(),
    weakPages: buildWeakPages(publicUrl, books, subscriptions, events).slice(0, 20)
  };
}

function serializeActivityDay(date: string, events: ActivityEvent[]): Record<string, unknown> {
  const lessonPages = events
    .filter((event) => event.type === "lesson_sent")
    .reduce((sum, event) => sum + event.chunkIndexes.length, 0);
  const learned = countFeedbackPages(events, "learned");
  const hard = countFeedbackPages(events, "hard");
  const repeat = countFeedbackPages(events, "repeat");
  return {
    date,
    label: formatDayLabel(date),
    lessonPages,
    learned,
    hard,
    repeat,
    studied: learned + hard + repeat > 0,
    score: learned * 2 + hard + repeat
  };
}

function buildWeakPages(
  publicUrl: string,
  books: CatalogBook[],
  subscriptions: Subscription[],
  events: ActivityEvent[]
): Record<string, unknown>[] {
  const bookMap = new Map(books.map((book) => [book.id, book]));
  const hardEventCounts = new Map<string, { count: number; lastDate: string }>();
  for (const event of events) {
    if (event.type !== "feedback" || event.feedback !== "hard" || !event.bookId) continue;
    for (const index of event.chunkIndexes) {
      const key = `${event.bookId}:${index}`;
      const existing = hardEventCounts.get(key);
      hardEventCounts.set(key, {
        count: (existing?.count ?? 0) + 1,
        lastDate: existing && existing.lastDate > event.date ? existing.lastDate : event.date
      });
    }
  }

  const fromSubscriptions = subscriptions.flatMap((subscription) =>
    subscription.hardChunkIndexes.map((index) => ({ bookId: subscription.bookId, index }))
  );

  const weakPages: Record<string, unknown>[] = [];
  for (const { bookId, index } of fromSubscriptions) {
    const book = bookMap.get(bookId);
    const chunk = book?.chunks[index];
    if (!book || !chunk) continue;
    const stats = hardEventCounts.get(`${bookId}:${index}`);
    weakPages.push({
      bookId,
      titleRu: book.titleRu,
      page: index + 1,
      count: stats?.count ?? 1,
      lastDate: stats?.lastDate,
      imageUrl: `${publicUrl}/content/${chunk.imagePath}`,
      audioUrl: verifiedChunkAudioUrl(publicUrl, book, chunk),
      audioScope: verifiedChunkAudioUrl(publicUrl, book, chunk) ? "page" : undefined,
      audioStatus: chunk.audioStatus ?? book.audioStatus
    });
  }

  return weakPages.sort((a, b) => Number(b.count) - Number(a.count) || String(b.lastDate ?? "").localeCompare(String(a.lastDate ?? "")));
}

function serializeBook(publicUrl: string, book: CatalogBook): Record<string, unknown> {
  return {
    id: book.id,
    titleRu: book.titleRu,
    titleAr: book.titleAr,
    author: book.author,
    coverUrl: `${publicUrl}/assets/book-cover-${book.id}.svg`,
    fullPdfUrl: book.fullPdfPath ? `${publicUrl}/content/${book.fullPdfPath}` : undefined,
    bookAudioUrl: book.audioPath ? `${publicUrl}/content/${book.audioPath}` : undefined,
    audioScope: book.audioScope ?? "book",
    audioStatus: book.audioStatus,
    totalChunks: book.chunks.length,
    pages: book.chunks.map((chunk) => ({
      index: chunk.index,
      page: chunk.index + 1,
      title: chunk.title,
      sourcePageNumber: chunk.sourcePageNumber,
      imageUrl: `${publicUrl}/content/${chunk.imagePath}`,
      audioUrl: verifiedChunkAudioUrl(publicUrl, book, chunk),
      audioStatus: chunk.audioStatus ?? book.audioStatus,
      textUrl: chunk.textPath ? `${publicUrl}/content/${chunk.textPath}` : undefined
    }))
  };
}

function serializeSubscription(book: CatalogBook | undefined, subscription: Subscription): Record<string, unknown> {
  const total = book?.chunks.length ?? 0;
  const nextChunk = book?.chunks[subscription.nextChunkIndex];
  return {
    bookId: subscription.bookId,
    titleRu: book?.titleRu ?? subscription.bookId,
    titleAr: book?.titleAr ?? "",
    active: subscription.active,
    pace: subscription.pace,
    mode: subscription.mode,
    dailyHour: subscription.dailyHour,
    nextChunkIndex: subscription.nextChunkIndex,
    totalChunks: total,
    completedCount: subscription.completedChunkIndexes.length,
    hardCount: subscription.hardChunkIndexes.length,
    streakDays: subscription.streakDays,
    progressPercent: total === 0 ? 0 : Math.round((Math.min(subscription.nextChunkIndex, total) / total) * 100),
    lastLessonChunkIndexes: subscription.lastLessonChunkIndexes,
    nextPreview: nextChunk ? { index: nextChunk.index, title: nextChunk.title } : undefined,
    dueReviews: subscription.reviewQueue.filter((item) => item.dueDate <= todayKey()).length,
    reviewQueue: subscription.reviewQueue.slice(0, 20)
  };
}

function serializeLesson(publicUrl: string, book: CatalogBook, chunk: CatalogBook["chunks"][number]): Record<string, unknown> {
  return {
    bookId: book.id,
    titleRu: book.titleRu,
    titleAr: book.titleAr,
    index: chunk.index,
    page: chunk.index + 1,
    total: book.chunks.length,
    imageUrl: `${publicUrl}/content/${chunk.imagePath}`,
    audioUrl: verifiedChunkAudioUrl(publicUrl, book, chunk),
    audioScope: verifiedChunkAudioUrl(publicUrl, book, chunk) ? "page" : undefined,
    audioStatus: chunk.audioStatus ?? book.audioStatus,
    fullPdfUrl: book.fullPdfPath ? `${publicUrl}/content/${book.fullPdfPath}` : undefined,
    textUrl: chunk.textPath ? `${publicUrl}/content/${chunk.textPath}` : undefined
  };
}

function verifiedChunkAudioUrl(publicUrl: string, book: CatalogBook, chunk: CatalogBook["chunks"][number]): string | undefined {
  if ((chunk.audioStatus ?? book.audioStatus) !== "verified") return undefined;
  if (!chunk.audioPath) return undefined;
  return `${publicUrl}/content/${chunk.audioPath}`;
}

function buildSchedule(publicUrl: string, books: CatalogBook[], subscriptions: Subscription[]): Record<string, unknown>[] {
  const bookMap = new Map(books.map((book) => [book.id, book]));
  const daily = subscriptions
    .filter((subscription) => subscription.active)
    .map((subscription) => ({
      type: "daily",
      dueDate: todayKey(),
      bookId: subscription.bookId,
      titleRu: bookMap.get(subscription.bookId)?.titleRu ?? subscription.bookId,
      label: `Каждый день в ${formatHour(subscription.dailyHour)}`,
      page: subscription.nextChunkIndex + 1
    }));
  const reviews = subscriptions.flatMap((subscription) =>
    subscription.reviewQueue.slice(0, 30).map((item) => {
      const book = bookMap.get(subscription.bookId);
      const chunk = book?.chunks[item.chunkIndex];
      return {
        type: "review",
        dueDate: item.dueDate,
        bookId: subscription.bookId,
        titleRu: book?.titleRu ?? subscription.bookId,
      label: `Повторить фрагмент ${item.chunkIndex + 1}`,
        page: item.chunkIndex + 1,
        imageUrl: book && chunk ? `${publicUrl}/content/${chunk.imagePath}` : undefined
      };
    })
  );
  return [...daily, ...reviews].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(0, 40);
}

async function serveContent(urlPath: string, response: http.ServerResponse, config: AppConfig): Promise<void> {
  const relative = decodeURIComponent(urlPath.replace(/^\/content\//, ""));
  const contentRoot = path.resolve(config.contentDir);
  const filePath = path.resolve(config.contentDir, relative);

  if (filePath !== contentRoot && !filePath.startsWith(`${contentRoot}${path.sep}`)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "cache-control": "public, max-age=86400",
      "content-type": contentType(filePath)
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function authenticateTelegram(request: http.IncomingMessage, config: AppConfig): AuthUser | undefined {
  const rawHeader = request.headers["x-telegram-init-data"];
  const initData = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!initData) return undefined;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const userRaw = params.get("user");
  if (!hash || !userRaw) return undefined;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(config.botToken).digest();
  const calculated = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const calculatedBuffer = Buffer.from(calculated, "hex");
  const hashBuffer = Buffer.from(hash, "hex");
  if (calculatedBuffer.length !== hashBuffer.length) return undefined;
  if (!crypto.timingSafeEqual(calculatedBuffer, hashBuffer)) return undefined;

  try {
    const user = JSON.parse(userRaw) as { id?: number; first_name?: string; username?: string };
    if (!user.id) return undefined;
    return { chatId: user.id, firstName: user.first_name, username: user.username };
  } catch {
    return undefined;
  }
}

function readBody(request: http.IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as RequestBody) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".mp3")) return "audio/mpeg";
  if (filePath.endsWith(".pdf")) return "application/pdf";
  if (filePath.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function isPace(value: unknown): value is Pace {
  return value === "slow" || value === "normal" || value === "fast";
}

function isMode(value: unknown): value is StudyMode {
  return value === "read_listen" || value === "read" || value === "listen" || value === "review";
}

function isFeedback(value: unknown): value is LessonFeedback {
  return value === "learned" || value === "hard" || value === "repeat";
}

function groupEventsByDate(events: ActivityEvent[]): Map<string, ActivityEvent[]> {
  const grouped = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    grouped.set(event.date, [...(grouped.get(event.date) ?? []), event]);
  }
  return grouped;
}

function countFeedbackPages(events: ActivityEvent[], feedback: LessonFeedback): number {
  return events
    .filter((event) => event.type === "feedback" && event.feedback === feedback)
    .reduce((sum, event) => sum + event.chunkIndexes.length, 0);
}

function lastDateKeys(days: number): string[] {
  return Array.from({ length: days }, (_, index) => dateKey(addDays(new Date(), index - days + 1)));
}

function currentWeekDateKeys(): string[] {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = addDays(now, mondayOffset);
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(monday, index)));
}

function formatDayLabel(dateKeyValue: string): string {
  return new Date(`${dateKeyValue}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function todayKey(): string {
  return dateKey(new Date());
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function renderApp(publicUrl: string): string {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>NurTech Hifz Cabinet</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      * { box-sizing: border-box; }
      :root {
        color-scheme: dark;
        --bg: #07111f;
        --panel: rgba(255,255,255,.08);
        --panel-strong: rgba(255,255,255,.13);
        --line: rgba(255,255,255,.14);
        --ink: #f6fbf8;
        --muted: #b8cac2;
        --emerald: #62dfac;
        --gold: #f4cb72;
        --danger: #ff817c;
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 15% 0%, rgba(98,223,172,.16), transparent 34%),
          radial-gradient(circle at 84% 16%, rgba(244,203,114,.11), transparent 28%),
          linear-gradient(145deg, #050a14, #07111f 55%, #0d2435);
        color: var(--ink);
      }
      button, select { font: inherit; }
      .app { width: min(1060px, 100%); margin: 0 auto; padding: calc(18px + env(safe-area-inset-top)) 14px calc(96px + env(safe-area-inset-bottom)); }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .logo { width: 42px; height: 42px; border-radius: 14px; background: linear-gradient(145deg, rgba(98,223,172,.28), rgba(244,203,114,.18)); display: grid; place-items: center; border: 1px solid var(--line); }
      .brand b { display: block; font-size: 18px; line-height: 1.1; }
      .brand span { color: var(--muted); font-size: 13px; }
      .chip { border: 1px solid var(--line); background: var(--panel); color: var(--muted); border-radius: 999px; padding: 9px 11px; font-size: 13px; }
      .panel { border: 1px solid var(--line); background: linear-gradient(145deg, rgba(255,255,255,.12), rgba(255,255,255,.055)); border-radius: 24px; box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 22px 56px rgba(0,0,0,.28); backdrop-filter: blur(20px); }
      .hero { padding: 18px; margin-bottom: 14px; }
      h1 { margin: 0 0 8px; font-size: clamp(26px, 7vw, 44px); line-height: 1.06; letter-spacing: 0; }
      h2 { margin: 0 0 12px; font-size: 22px; line-height: 1.15; letter-spacing: 0; }
      h3 { margin: 16px 0 8px; font-size: 16px; line-height: 1.2; letter-spacing: 0; }
      p { margin: 0; color: var(--muted); line-height: 1.5; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
      .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
      .stat { min-height: 72px; padding: 12px; border-radius: 18px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1); }
      .stat b { display: block; font-size: 20px; }
      .stat span { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; }
      .analytics-grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 12px; }
      .metric { min-height: 92px; padding: 13px; border-radius: 18px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1); }
      .metric b { display: block; font-size: 24px; line-height: 1; }
      .metric span { display: block; color: var(--muted); font-size: 13px; line-height: 1.35; margin-top: 7px; }
      .metric.good { border-color: rgba(98,223,172,.3); background: rgba(98,223,172,.1); }
      .metric.warn { border-color: rgba(244,203,114,.32); background: rgba(244,203,114,.1); }
      .metric.bad { border-color: rgba(255,129,124,.32); background: rgba(255,129,124,.09); }
      .analytics-card { padding: 14px; }
      .bar-row { display: grid; gap: 7px; margin-top: 12px; }
      .bar-label { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 13px; }
      .insight { margin-top: 10px; padding: 11px; border-radius: 16px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); color: #e9f8f1; line-height: 1.4; }
      .habit-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; margin-top: 12px; }
      .habit-day { min-height: 54px; border-radius: 14px; border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.06); padding: 7px 5px; text-align: center; color: var(--muted); font-size: 11px; }
      .habit-day b { display: block; color: var(--ink); font-size: 13px; margin-bottom: 4px; }
      .habit-day.done { background: rgba(98,223,172,.18); border-color: rgba(98,223,172,.34); }
      .habit-day.hard { background: rgba(244,203,114,.14); border-color: rgba(244,203,114,.28); }
      .history-row { display: grid; grid-template-columns: 74px 1fr; gap: 10px; align-items: center; padding: 10px; border-radius: 16px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); }
      .history-row b { display: block; font-size: 13px; color: var(--gold); }
      .history-row span { display: block; color: var(--muted); font-size: 13px; line-height: 1.35; }
      .weak-page { display: grid; grid-template-columns: 66px 1fr; gap: 10px; align-items: center; padding: 10px; border-radius: 16px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); }
      .weak-page img { width: 66px; height: 82px; object-fit: cover; border-radius: 10px; background: #eef1f0; }
      .weak-page b { display: block; font-size: 14px; }
      .weak-page span { display: block; color: var(--muted); font-size: 13px; margin-top: 4px; }
      .guide { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 14px; }
      .guide-step { display: grid; grid-template-columns: 34px 1fr; gap: 10px; align-items: start; padding: 11px; border-radius: 18px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1); }
      .guide-step i { width: 34px; height: 34px; border-radius: 999px; display: grid; place-items: center; background: rgba(98,223,172,.18); color: var(--emerald); font-style: normal; font-weight: 900; }
      .guide-step b { display: block; font-size: 14px; }
      .guide-step span { display: block; color: var(--muted); font-size: 13px; line-height: 1.35; margin-top: 2px; }
      .book-list { display: grid; grid-template-columns: 1fr; gap: 10px; }
      .book { padding: 14px; }
      .book-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
      .book-title { min-width: 0; }
      .book-title b { display: block; font-size: 18px; }
      .book-title span { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .book-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .mini { border: 1px solid rgba(255,255,255,.12); color: var(--muted); background: rgba(255,255,255,.06); border-radius: 999px; padding: 6px 8px; font-size: 12px; }
      .next-box { margin-top: 12px; padding: 11px; border-radius: 16px; background: rgba(98,223,172,.1); border: 1px solid rgba(98,223,172,.18); color: #ddfff1; }
      .next-box b { display: block; font-size: 14px; }
      .next-box span { display: block; color: var(--muted); font-size: 13px; margin-top: 3px; }
      .progress { height: 8px; background: rgba(255,255,255,.09); border-radius: 999px; overflow: hidden; margin: 12px 0; }
      .progress i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--emerald), var(--gold)); border-radius: inherit; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .btn { border: 0; border-radius: 15px; padding: 11px 13px; min-height: 44px; color: #06120e; background: linear-gradient(135deg, #93f2ce, #4bd59e); font-weight: 800; }
      .btn.secondary { color: var(--ink); background: rgba(255,255,255,.08); border: 1px solid var(--line); }
      .btn.warn { color: #1f1006; background: linear-gradient(135deg, #ffe3a3, #f4cb72); }
      .btn.danger { color: #270806; background: linear-gradient(135deg, #ffc1bc, #ff817c); }
      .btn:disabled { opacity: .55; }
      .lesson { overflow: hidden; }
      .lesson-media { background: rgba(0,0,0,.2); border-bottom: 1px solid var(--line); }
      .lesson-media img { display: block; width: 100%; max-height: 58vh; object-fit: contain; background: #eef1f0; }
      .lesson-body { padding: 14px; }
      audio { width: 100%; margin-top: 12px; }
      .reader { position: fixed; inset: 0; z-index: 20; display: none; background: rgba(3,8,15,.92); backdrop-filter: blur(18px); padding: calc(14px + env(safe-area-inset-top)) 12px calc(14px + env(safe-area-inset-bottom)); overflow: auto; }
      .reader.active { display: block; }
      .reader-shell { width: min(860px, 100%); margin: 0 auto; display: grid; gap: 10px; }
      .reader-bar { position: sticky; top: calc(8px + env(safe-area-inset-top)); z-index: 2; display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; padding: 10px; }
      .reader-bar b { display: block; font-size: 16px; }
      .reader-bar span { display: block; color: var(--muted); font-size: 13px; margin-top: 2px; }
      .reader-page { overflow: hidden; }
      .reader-page img { display: block; width: 100%; max-height: 72vh; object-fit: contain; background: #eef1f0; }
      .reader-body { padding: 12px; }
      .page-strip { display: flex; gap: 6px; overflow-x: auto; padding: 8px 2px 2px; }
      .page-dot { flex: 0 0 auto; min-width: 40px; height: 36px; border: 1px solid var(--line); border-radius: 12px; color: var(--muted); background: rgba(255,255,255,.06); }
      .page-dot.active { color: #06120e; background: var(--emerald); border-color: transparent; font-weight: 900; }
      .schedule { display: grid; gap: 9px; }
      .schedule-item { display: grid; grid-template-columns: 92px 1fr; gap: 10px; align-items: start; padding: 12px; border-radius: 18px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1); }
      .schedule-date { color: var(--gold); font-weight: 800; font-size: 13px; }
      .schedule-item b { display: block; font-size: 15px; }
      .schedule-item span { color: var(--muted); font-size: 13px; }
      .settings { display: grid; gap: 10px; }
      .field { display: grid; gap: 7px; }
      .field label { color: var(--muted); font-size: 13px; }
      select { width: 100%; min-height: 44px; border-radius: 14px; border: 1px solid var(--line); background: rgba(255,255,255,.08); color: var(--ink); padding: 0 12px; }
      .tabs { position: fixed; left: 50%; bottom: calc(10px + env(safe-area-inset-bottom)); transform: translateX(-50%); width: min(560px, calc(100% - 20px)); display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; padding: 8px; border-radius: 24px; z-index: 5; }
      .tab { border: 0; min-height: 46px; border-radius: 18px; color: var(--muted); background: transparent; font-weight: 800; font-size: 12px; }
      .tab.active { color: #07120d; background: linear-gradient(135deg, #93f2ce, #4bd59e); }
      .view { display: none; }
      .view.active { display: grid; gap: 12px; }
      .empty { padding: 18px; text-align: center; }
      .notice { padding: 12px; border-radius: 16px; background: rgba(244,203,114,.12); border: 1px solid rgba(244,203,114,.25); color: #ffe8ad; }
      .notice.soft { background: rgba(98,223,172,.09); border-color: rgba(98,223,172,.22); color: #dffdef; }
      .toast { position: fixed; left: 50%; bottom: calc(78px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 30; max-width: calc(100% - 28px); padding: 11px 14px; border-radius: 999px; background: rgba(6,18,14,.94); border: 1px solid rgba(98,223,172,.24); color: #eafff6; box-shadow: 0 18px 42px rgba(0,0,0,.34); display: none; }
      @media (min-width: 820px) {
        .grid.two { grid-template-columns: minmax(0, 1.1fr) minmax(340px, .9fr); align-items: start; }
        .book-list.catalog { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .analytics-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .guide { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <main class="app">
      <header class="top">
        <div class="brand"><div class="logo">✓</div><div><b>NurTech Hifz</b><span id="userLabel">личный кабинет</span></div></div>
        <button class="chip" id="refreshBtn">Обновить</button>
      </header>

      <section class="hero panel">
        <h1>Твой учебный день</h1>
        <p id="heroText">Выбери одну или две книги. Каждый день получай новый фрагмент с аудио, отмечай результат и повторяй по расписанию.</p>
        <div class="stats">
          <div class="stat"><b id="statBooks">0</b><span>активные книги</span></div>
          <div class="stat"><b id="statPages">0</b><span>фрагменты пройдены</span></div>
          <div class="stat"><b id="statReviews">0</b><span>повторения</span></div>
        </div>
        <div class="guide">
          <div class="guide-step"><i>1</i><div><b>Добавь книгу</b><span>На вкладке «Книги» выбери матн и темп.</span></div></div>
          <div class="guide-step"><i>2</i><div><b>Открой полный текст</b><span>Кнопка «Читать полный текст» показывает весь матн.</span></div></div>
          <div class="guide-step"><i>3</i><div><b>Учи фрагмент</b><span>Нажми «Получить следующий фрагмент», прочитай и послушай аудио.</span></div></div>
          <div class="guide-step"><i>4</i><div><b>Отметь результат</b><span>Бот сам поставит повторение в план.</span></div></div>
        </div>
      </section>

      <section id="authView" class="panel empty" style="display:none">
        <h2>Открой из Telegram</h2>
        <p>Личный кабинет привязан к твоему Telegram. Открой бота и нажми кнопку «Кабинет».</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="https://t.me/nurtechhifzbot">Открыть бота</a></div>
      </section>

      <section class="view active" id="todayView">
        <div class="grid two">
          <div class="panel" style="padding:14px">
            <h2>Сегодня</h2>
            <p>Здесь книги, которые ты сейчас учишь. Нажми «Получить следующий фрагмент», когда готов заниматься.</p>
            <div id="todayBooks" class="book-list"></div>
          </div>
          <div id="lessonBox" class="panel empty">
            <h2>Фрагмент появится здесь</h2>
            <p>Выбери книгу и нажми «Получить следующий фрагмент».</p>
          </div>
        </div>
        <div class="grid two">
          <div class="panel analytics-card">
            <h2>История по дням</h2>
            <div id="historyList" class="schedule"></div>
          </div>
          <div class="panel analytics-card">
            <h2>Календарь привычки</h2>
            <p>Дни закрашиваются после отметки результата.</p>
            <div id="habitCalendar" class="habit-grid"></div>
          </div>
        </div>
        <div class="panel analytics-card">
          <h2>Слабые фрагменты</h2>
          <p>Сюда попадают фрагменты, которые ты отмечал как «Сложно».</p>
          <div id="weakPages" class="book-list"></div>
        </div>
      </section>

      <section class="view" id="booksView">
        <div class="panel" style="padding:14px">
          <h2>Книги, которые ты выбрал</h2>
          <p>В «Сейчас учишь» приходят ежедневные фрагменты. Книги «На паузе» не приходят в задания, но их можно читать.</p>
          <div id="myBooks" class="book-list" style="margin-top:12px"></div>
        </div>
        <div class="panel" style="padding:14px">
          <h2>Добавить новую книгу</h2>
          <p>Одновременно можно учить 2 книги. Это ограничение нужно, чтобы не запутаться в заданиях.</p>
          <div id="catalogBooks" class="book-list catalog"></div>
        </div>
      </section>

      <section class="view" id="scheduleView">
        <div class="panel" style="padding:14px">
          <h2>Расписание</h2>
          <p>Новые фрагменты приходят каждый день в выбранное время. Повторения появляются после отметок «Выучил», «Сложно» или «Повторить завтра».</p>
          <div id="scheduleList" class="schedule"></div>
        </div>
      </section>

      <section class="view" id="progressView">
        <div class="panel" style="padding:14px">
          <h2>Аналитика</h2>
          <p>Здесь видно нагрузку на день, общий прогресс, прогноз окончания и места, которые требуют повторения.</p>
          <div id="analyticsSummary" class="analytics-grid"></div>
        </div>
        <div class="grid two">
          <div class="panel analytics-card">
            <h2>По книгам</h2>
            <div id="analyticsBooks" class="book-list"></div>
          </div>
          <div class="panel analytics-card">
            <h2>Повторения и нагрузка</h2>
            <div id="analyticsReviews" class="schedule"></div>
          </div>
        </div>
      </section>

      <section class="view" id="settingsView">
        <div class="panel" style="padding:14px">
          <h2>Настройки книги</h2>
          <p>Выбери книгу и настрой темп, время и режим занятий.</p>
          <div class="settings" id="settingsList" style="margin-top:12px"></div>
        </div>
      </section>
    </main>

    <section class="reader" id="reader">
      <div class="reader-shell">
        <div class="reader-bar panel">
          <div><b id="readerTitle">Книга</b><span id="readerMeta">Фрагмент 1</span></div>
          <button class="btn secondary" id="closeReader">Закрыть</button>
        </div>
        <div class="reader-page panel" id="readerPage"></div>
        <div class="reader-body panel">
          <div class="actions">
            <button class="btn secondary" id="readerPrev">Назад</button>
            <button class="btn" id="readerNext">Вперед</button>
            <button class="btn warn" id="readerMemorize">Учить этот фрагмент</button>
          </div>
          <audio id="readerAudio" controls></audio>
          <div class="page-strip" id="readerStrip"></div>
        </div>
      </div>
    </section>

    <div class="toast" id="toast"></div>

    <nav class="tabs panel">
      <button class="tab active" data-view="todayView">Сегодня</button>
      <button class="tab" data-view="booksView">Книги</button>
      <button class="tab" data-view="scheduleView">План</button>
      <button class="tab" data-view="progressView">Аналитика</button>
      <button class="tab" data-view="settingsView">Настройки</button>
    </nav>

    <script>
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg) { tg.ready(); tg.expand(); }
      var initData = tg ? tg.initData : "";
      var state = null;
      var activeBookId = null;
      var lesson = null;
      var readerBookId = null;
      var readerPageIndex = 0;
      var paceLabels = { slow: "1 фрагмент/день", normal: "2 фрагмента/день", fast: "3 фрагмента/день" };
      var paceValues = { slow: 1, normal: 2, fast: 3 };
      var modeLabels = { read_listen: "текст и аудио", read: "только текст", listen: "только аудио", review: "только повторение" };

      document.querySelectorAll(".tab").forEach(function(tab) {
        tab.addEventListener("click", function() {
          document.querySelectorAll(".tab").forEach(function(item) { item.classList.remove("active"); });
          document.querySelectorAll(".view").forEach(function(item) { item.classList.remove("active"); });
          tab.classList.add("active");
          document.getElementById(tab.dataset.view).classList.add("active");
        });
      });
      document.getElementById("refreshBtn").addEventListener("click", loadState);
      document.getElementById("closeReader").addEventListener("click", closeReader);
      document.getElementById("readerPrev").addEventListener("click", function() { moveReader(-1); });
      document.getElementById("readerNext").addEventListener("click", function() { moveReader(1); });
      document.getElementById("readerMemorize").addEventListener("click", async function() {
        var book = getBook(readerBookId);
        if (!book) return;
        var sub = getSubscription(readerBookId);
        if (!sub) {
          closeReader();
          await startBook(readerBookId, "slow");
          return;
        }
        closeReader();
        nextPage(readerBookId);
      });

      async function api(path, options) {
        options = options || {};
        var res = await fetch("/api/app" + path, {
          method: options.method || "GET",
          headers: { "content-type": "application/json", "x-telegram-init-data": initData },
          body: options.body ? JSON.stringify(options.body) : undefined
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || "Ошибка");
        return data;
      }

      async function loadState() {
        if (!initData) {
          document.getElementById("authView").style.display = "block";
          document.querySelectorAll(".view,.hero,.tabs").forEach(function(item) { item.style.display = "none"; });
          return;
        }
        try {
          state = await api("/state");
          activeBookId = state.activeBookId || (state.subscriptions[0] && state.subscriptions[0].bookId);
          render();
        } catch (error) {
          document.getElementById("authView").style.display = "block";
          document.getElementById("authView").querySelector("p").textContent = error.message;
        }
      }

      function render() {
        var active = state.subscriptions.filter(function(item) { return item.active; });
        var completed = state.subscriptions.reduce(function(sum, item) { return sum + item.completedCount; }, 0);
        var reviews = state.subscriptions.reduce(function(sum, item) { return sum + item.dueReviews; }, 0);
        document.getElementById("userLabel").textContent = state.user.firstName ? state.user.firstName : "личный кабинет";
        document.getElementById("statBooks").textContent = active.length + "/" + state.maxActiveBooks;
        document.getElementById("statPages").textContent = completed;
        document.getElementById("statReviews").textContent = reviews;
        renderToday();
        renderBooks();
        renderSchedule();
        renderProgress();
        renderSettings();
        if (lesson) renderLesson();
      }

      function bookCard(sub, controls) {
        var el = document.createElement("article");
        el.className = "book panel";
        var status = sub.active ? "Учишь сейчас" : "На паузе";
        var nextText = sub.active
          ? (sub.nextPreview ? "Следующий для заучивания: фрагмент " + (sub.nextPreview.index + 1) + " из " + sub.totalChunks : "Все фрагменты пройдены")
          : "Задания по этой книге сейчас не приходят";
        var nextHelp = sub.active
          ? "Нажми «Получить следующий фрагмент», чтобы открыть текст и аудио для заучивания."
          : "Нажми «Снова учить эту книгу», если хочешь получать по ней ежедневные фрагменты.";
        el.innerHTML =
          '<div class="book-head"><div class="book-title"><b>' + esc(sub.titleRu) + '</b><span>' + esc(sub.titleAr || "") + '</span></div><span class="chip">' + status + '</span></div>' +
          '<div class="progress"><i style="width:' + sub.progressPercent + '%"></i></div>' +
          '<div class="book-meta"><span class="mini">' + sub.nextChunkIndex + '/' + sub.totalChunks + ' фрагментов</span><span class="mini">' + paceLabels[sub.pace] + '</span><span class="mini">' + pad(sub.dailyHour) + ':00</span><span class="mini">' + modeLabels[sub.mode] + '</span></div>' +
          '<div class="next-box"><b>' + esc(nextText) + '</b><span>' + esc(nextHelp) + '</span></div>';
        var actions = document.createElement("div");
        actions.className = "actions";
        controls(actions, sub);
        el.appendChild(actions);
        return el;
      }

      function renderToday() {
        var box = document.getElementById("todayBooks");
        box.innerHTML = "";
        var active = state.subscriptions.filter(function(item) { return item.active; });
        if (state.activity && state.activity.today && state.activity.today.shouldRemind) {
          box.innerHTML = '<div class="notice">' + esc(state.activity.today.text) + '</div>';
        }
        if (active.length === 0) {
          box.innerHTML += '<div class="notice">Нет активных книг. Открой вкладку «Книги» и добавь одну.</div>';
          return;
        }
        active.forEach(function(sub) {
          box.appendChild(bookCard(sub, function(actions) {
            actions.appendChild(button("Получить следующий фрагмент", "btn", function() { nextPage(sub.bookId); }));
            actions.appendChild(button("Читать полный текст", "btn secondary", function() { openReader(sub.bookId, Math.max(0, sub.nextChunkIndex)); }));
            actions.appendChild(button("Посмотреть план повторений", "btn secondary", function() { switchView("scheduleView"); }));
          }));
        });
      }

      function renderBooks() {
        var mine = document.getElementById("myBooks");
        mine.innerHTML = "";
        var active = state.subscriptions.filter(function(item) { return item.active; });
        var paused = state.subscriptions.filter(function(item) { return !item.active; });
        if (state.subscriptions.length === 0) {
          mine.innerHTML = '<div class="notice soft">Ты еще не выбрал книги. Ниже открой любую книгу, прочитай полный текст или добавь ее в занятия.</div>';
        }
        if (active.length > 0) {
          mine.insertAdjacentHTML("beforeend", '<h3>Сейчас учишь</h3>');
        }
        active.forEach(function(sub) {
          mine.appendChild(bookCard(sub, function(actions) {
            actions.appendChild(button("Перейти к занятиям", "btn", function() { activeBookId = sub.bookId; switchView("todayView"); }));
            actions.appendChild(button("Читать полный текст", "btn secondary", function() { openReader(sub.bookId, 0); }));
            actions.appendChild(button("Поставить на паузу", "btn warn", function() { toggleBook(sub); }));
          }));
        });
        if (paused.length > 0) {
          mine.insertAdjacentHTML("beforeend", '<h3>На паузе</h3><div class="notice soft">По этим книгам ежедневные фрагменты не приходят. Их можно читать или снова добавить в занятия.</div>');
        }
        paused.forEach(function(sub) {
          mine.appendChild(bookCard(sub, function(actions) {
            actions.appendChild(button("Снова учить эту книгу", "btn", function() { toggleBook(sub); }));
            actions.appendChild(button("Читать полный текст", "btn secondary", function() { openReader(sub.bookId, 0); }));
          }));
        });

        var catalog = document.getElementById("catalogBooks");
        catalog.innerHTML = "";
        var activeCount = state.subscriptions.filter(function(item) { return item.active; }).length;
        if (activeCount >= state.maxActiveBooks) {
          catalog.innerHTML = '<div class="notice">Сейчас уже учатся 2 книги. Чтобы добавить новую, сначала нажми «Поставить на паузу» у одной книги выше.</div>';
        }
        state.books.forEach(function(book) {
          var existing = state.subscriptions.find(function(item) { return item.bookId === book.id; });
          var el = document.createElement("article");
          el.className = "book panel";
          el.innerHTML = '<div class="book-title"><b>' + esc(book.titleRu) + '</b><span>' + esc(book.titleAr) + '</span></div><div class="book-meta"><span class="mini">' + book.totalChunks + ' фрагментов</span><span class="mini">полный текст</span><span class="mini">проверенное аудио</span></div><p style="margin-top:10px">Можно сначала прочитать книгу целиком, а потом добавить ее в ежедневные занятия.</p>';
          var actions = document.createElement("div");
          actions.className = "actions";
          actions.appendChild(button("Читать полный текст", "btn secondary", function() { openReader(book.id, 0); }));
          if (existing) {
            if (existing.active) {
              actions.appendChild(button("Уже учишь. Перейти к занятиям", "btn", function() { activeBookId = existing.bookId; switchView("todayView"); }));
            } else {
              actions.appendChild(button("Снова учить эту книгу", "btn", function() { toggleBook(existing); }));
            }
          } else {
            var disabled = activeCount >= state.maxActiveBooks;
            if (disabled) {
              var disabledButton = button("Нельзя добавить: уже учатся 2 книги", "btn secondary", function() {});
              disabledButton.disabled = true;
              actions.appendChild(disabledButton);
            } else {
              [["slow", "Добавить: 1 фрагмент/день"], ["normal", "Добавить: 2 фрагмента/день"], ["fast", "Добавить: 3 фрагмента/день"]].forEach(function(pace) {
                actions.appendChild(button(pace[1], pace[0] === "slow" ? "btn" : "btn secondary", function() { startBook(book.id, pace[0]); }));
              });
            }
          }
          el.appendChild(actions);
          catalog.appendChild(el);
        });
      }

      function renderSchedule() {
        var box = document.getElementById("scheduleList");
        box.innerHTML = "";
        if (state.schedule.length === 0) {
          box.innerHTML = '<div class="notice">Пока нет расписания. Получи фрагмент и отметь результат.</div>';
          return;
        }
        state.schedule.forEach(function(item) {
          var el = document.createElement("div");
          el.className = "schedule-item";
          el.innerHTML = '<div class="schedule-date">' + dateLabel(item.dueDate) + '</div><div><b>' + esc(item.titleRu) + '</b><span>' + esc(item.label) + '</span></div>';
          box.appendChild(el);
        });
      }

      function renderProgress() {
        var summary = document.getElementById("analyticsSummary");
        var books = document.getElementById("analyticsBooks");
        var reviews = document.getElementById("analyticsReviews");
        var history = document.getElementById("historyList");
        var calendar = document.getElementById("habitCalendar");
        var weakPages = document.getElementById("weakPages");
        summary.innerHTML = "";
        books.innerHTML = "";
        reviews.innerHTML = "";
        history.innerHTML = "";
        calendar.innerHTML = "";
        weakPages.innerHTML = "";

        if (state.subscriptions.length === 0) {
          summary.innerHTML = '<div class="notice soft">Аналитика появится после выбора первой книги.</div>';
          books.innerHTML = '<div class="notice">Открой вкладку «Книги» и добавь матн в занятия.</div>';
          reviews.innerHTML = '<div class="notice">Повторения появятся после отметок «Выучил», «Сложно» или «Повторить завтра».</div>';
          history.innerHTML = '<div class="notice">История появится после первого занятия.</div>';
          calendar.innerHTML = "";
          weakPages.innerHTML = '<div class="notice">Слабые фрагменты появятся после отметки «Сложно».</div>';
          return;
        }

        var activity = state.activity;
        var active = state.subscriptions.filter(function(item) { return item.active; });
        var totalPages = state.subscriptions.reduce(function(sum, sub) { return sum + sub.totalChunks; }, 0);
        var sentPages = state.subscriptions.reduce(function(sum, sub) { return sum + Math.min(sub.nextChunkIndex, sub.totalChunks); }, 0);
        var learnedPages = state.subscriptions.reduce(function(sum, sub) { return sum + sub.completedCount; }, 0);
        var hardPages = state.subscriptions.reduce(function(sum, sub) { return sum + sub.hardCount; }, 0);
        var dueToday = state.subscriptions.reduce(function(sum, sub) { return sum + sub.dueReviews; }, 0);
        var reviewTotal = state.subscriptions.reduce(function(sum, sub) { return sum + sub.reviewQueue.length; }, 0);
        var newPagesPerDay = active.reduce(function(sum, sub) { return sum + paceValue(sub.pace); }, 0);
        var progressPercent = totalPages === 0 ? 0 : Math.round((sentPages / totalPages) * 100);
        var workload = newPagesPerDay + dueToday;
        var workloadClass = workload <= 3 ? "good" : workload <= 6 ? "warn" : "bad";
        var workloadText = workload <= 3 ? "спокойная нагрузка" : workload <= 6 ? "средняя нагрузка" : "лучше снизить темп";

        summary.appendChild(metric("Сегодня", workload + " задач", newPagesPerDay + " новых фрагм. + " + dueToday + " повтор.", workloadClass));
        summary.appendChild(metric("Прогресс", progressPercent + "%", sentPages + " из " + totalPages + " фрагментов уже выданы", "good"));
        summary.appendChild(metric("Цель недели", activity.weeklyGoal.learned + "/" + activity.weeklyGoal.pages, "осталось " + activity.weeklyGoal.remaining + " фрагм.", activity.weeklyGoal.percent >= 100 ? "good" : "warn"));
        summary.appendChild(metric("Сложно", hardPages, "фрагментов отмечено сложными", hardPages > 0 ? "warn" : ""));
        summary.appendChild(weeklyGoalControl(activity.weeklyGoal.pages));

        if (activity.today.shouldRemind) {
          reviews.appendChild(plainInsight(activity.today.text));
        }

        reviews.appendChild(plainInsight("Нагрузка сейчас: " + workloadText + ". Новые фрагменты считаются по темпу активных книг, повторения - по расписанию."));
        if (reviewTotal === 0) {
          reviews.appendChild(plainNotice("Пока нет фрагментов в повторении. Они появятся после отметки результата."));
        } else {
          var dueItems = state.schedule.filter(function(item) { return item.type === "review"; }).slice(0, 8);
          reviews.appendChild(metric("Всего повторений", reviewTotal, dueToday + " нужно повторить сегодня", dueToday > 0 ? "warn" : "good"));
          dueItems.forEach(function(item) {
            var el = document.createElement("div");
            el.className = "schedule-item";
            el.innerHTML = '<div class="schedule-date">' + dateLabel(item.dueDate) + '</div><div><b>' + esc(item.titleRu) + '</b><span>' + esc(item.label) + '</span></div>';
            reviews.appendChild(el);
          });
        }

        state.subscriptions.forEach(function(sub) {
          books.appendChild(analyticsBookCard(sub));
        });

        activity.history.forEach(function(day) {
          history.appendChild(historyRow(day));
        });
        activity.calendar.forEach(function(day) {
          calendar.appendChild(habitDay(day));
        });
        if (activity.weakPages.length === 0) {
          weakPages.innerHTML = '<div class="notice soft">Пока нет слабых фрагментов. Если фрагмент дается трудно, отметь «Сложно».</div>';
        } else {
          activity.weakPages.forEach(function(item) {
            weakPages.appendChild(weakPageCard(item));
          });
        }
      }

      function analyticsBookCard(sub) {
        var el = document.createElement("article");
        el.className = "book panel";
        var sent = Math.min(sub.nextChunkIndex, sub.totalChunks);
        var remaining = Math.max(0, sub.totalChunks - sent);
        var daysLeft = sub.active ? Math.ceil(remaining / paceValue(sub.pace)) : null;
        var finishText = sub.active
          ? (remaining === 0 ? "Книга пройдена" : "примерно " + daysLeft + " дн. до конца при текущем темпе")
          : "прогноз появится, когда снова начнешь эту книгу";
        var finishDateText = sub.active && remaining > 0 ? "Ориентир: " + formatFutureDate(daysLeft) : "";
        var accuracy = sent === 0 ? 0 : Math.round((sub.completedCount / sent) * 100);
        el.innerHTML =
          '<div class="book-head"><div class="book-title"><b>' + esc(sub.titleRu) + '</b><span>' + (sub.active ? "Учишь сейчас" : "На паузе") + '</span></div><span class="chip">' + sub.progressPercent + '%</span></div>' +
          '<div class="bar-row"><div class="bar-label"><span>Выдано фрагментов</span><b>' + sent + '/' + sub.totalChunks + '</b></div><div class="progress"><i style="width:' + sub.progressPercent + '%"></i></div></div>' +
          '<div class="analytics-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">' +
          '<div class="metric"><b>' + sub.completedCount + '</b><span>отмечено «Выучил»</span></div>' +
          '<div class="metric ' + (sub.hardCount > 0 ? 'warn' : '') + '"><b>' + sub.hardCount + '</b><span>сложные фрагменты</span></div>' +
          '<div class="metric ' + (sub.dueReviews > 0 ? 'warn' : 'good') + '"><b>' + sub.dueReviews + '</b><span>повторить сегодня</span></div>' +
          '<div class="metric"><b>' + accuracy + '%</b><span>доля выученных из выданных</span></div>' +
          '</div>' +
          '<div class="insight"><b>Прогноз:</b> ' + esc(finishText) + (finishDateText ? '<br>' + esc(finishDateText) : '') + '</div>';
        var actions = document.createElement("div");
        actions.className = "actions";
        actions.appendChild(
          sub.active
            ? button("Получить следующий фрагмент", "btn", function() { nextPage(sub.bookId); })
            : button("Снова учить эту книгу", "btn", function() { toggleBook(sub); })
        );
        actions.appendChild(button("Читать полный текст", "btn secondary", function() { openReader(sub.bookId, 0); }));
        actions.appendChild(button("Настроить темп", "btn secondary", function() { switchView("settingsView"); }));
        el.appendChild(actions);
        return el;
      }

      function weeklyGoalControl(currentGoal) {
        var el = document.createElement("div");
        el.className = "metric";
        el.innerHTML = '<b>' + esc(currentGoal) + '</b><span>цель на неделю<br>сколько фрагментов хочешь выучить</span>';
        var actions = document.createElement("div");
        actions.className = "actions";
        [3, 5, 7, 10, 14].forEach(function(goal) {
          var btn = button(String(goal), goal === currentGoal ? "btn" : "btn secondary", function() { updateWeeklyGoal(goal); });
          actions.appendChild(btn);
        });
        el.appendChild(actions);
        return el;
      }

      function historyRow(day) {
        var el = document.createElement("div");
        el.className = "history-row";
        var parts = [];
        if (day.lessonPages) parts.push(day.lessonPages + " фрагм. получено");
        if (day.learned) parts.push(day.learned + " выучено");
        if (day.hard) parts.push(day.hard + " сложно");
        if (day.repeat) parts.push(day.repeat + " повторить");
        el.innerHTML = '<b>' + esc(day.label) + '</b><span>' + esc(parts.length ? parts.join(", ") : "занятий не было") + '</span>';
        return el;
      }

      function habitDay(day) {
        var el = document.createElement("div");
        el.className = "habit-day" + (day.studied ? " done" : "") + (day.hard ? " hard" : "");
        el.innerHTML = '<b>' + esc(day.label.split(" ")[0]) + '</b><span>' + (day.studied ? "есть" : "пусто") + '</span>';
        el.title = day.label + ": " + day.learned + " выучено, " + day.hard + " сложно";
        return el;
      }

      function weakPageCard(item) {
        var el = document.createElement("article");
        el.className = "weak-page";
        el.innerHTML =
          '<img src="' + item.imageUrl + '" alt="">' +
          '<div><b>' + esc(item.titleRu) + ': фрагмент ' + item.page + '</b><span>Отмечался сложным: ' + item.count + ' раз' + (item.lastDate ? '. Последний раз: ' + dateLabel(item.lastDate) : '') + '</span><div class="actions"><button class="btn secondary" data-read>Открыть фрагмент</button></div></div>';
        el.querySelector("[data-read]").addEventListener("click", function() { openReader(item.bookId, item.page - 1); });
        return el;
      }

      function renderSettings() {
        var box = document.getElementById("settingsList");
        box.innerHTML = "";
        state.subscriptions.forEach(function(sub) {
          var el = document.createElement("article");
          el.className = "book panel";
          el.innerHTML = '<div class="book-title"><b>' + esc(sub.titleRu) + '</b><span>Настройки этой книги</span></div>';
          el.appendChild(selectField("Темп", sub.pace, [["slow","1 фрагмент"],["normal","2 фрагмента"],["fast","3 фрагмента"]], function(v) { updateSettings(sub.bookId, { pace: v }); }));
          el.appendChild(selectField("Время", String(sub.dailyHour), [6,8,10,13,16,20,22].map(function(h){ return [String(h), pad(h)+":00"]; }), function(v) { updateSettings(sub.bookId, { dailyHour: Number(v) }); }));
          el.appendChild(selectField("Режим", sub.mode, [["read_listen","текст и аудио"],["read","только текст"],["listen","только аудио"],["review","только повторение"]], function(v) { updateSettings(sub.bookId, { mode: v }); }));
          box.appendChild(el);
        });
      }

      function renderLesson() {
        var box = document.getElementById("lessonBox");
        box.className = "panel lesson";
        var audioLabel = lesson.audioScope === "book"
          ? "Аудио - чтение всего матна. Для учебного фрагмента используй PDF выше."
          : lesson.audioStatus === "verified"
            ? "Проверенное аудио этого фрагмента."
            : "Аудио для этого фрагмента пока не проверено.";
        var audio = lesson.audioUrl ? '<audio src="' + lesson.audioUrl + '" controls></audio><p class="lead">' + audioLabel + '</p>' : '';
        box.innerHTML =
          '<div class="lesson-media"><img src="' + lesson.imageUrl + '" alt=""></div>' +
          '<div class="lesson-body"><h2>' + esc(lesson.titleRu) + ': фрагмент ' + lesson.page + ' из ' + lesson.total + '</h2>' +
          audio + '<div class="actions">' +
          '<button class="btn" data-feedback="learned">Выучил</button>' +
          '<button class="btn warn" data-feedback="hard">Сложно</button>' +
          '<button class="btn secondary" data-feedback="repeat">Повторить завтра</button>' +
          '</div></div>';
        box.querySelectorAll("[data-feedback]").forEach(function(btn) {
          btn.addEventListener("click", function() { sendFeedback(lesson.bookId, btn.dataset.feedback); });
        });
      }

      function openReader(bookId, pageIndex) {
        readerBookId = bookId;
        var book = getBook(bookId);
        readerPageIndex = Math.max(0, Math.min(pageIndex || 0, book ? book.pages.length - 1 : 0));
        document.getElementById("reader").classList.add("active");
        renderReader();
      }

      function closeReader() {
        document.getElementById("reader").classList.remove("active");
      }

      function moveReader(delta) {
        var book = getBook(readerBookId);
        if (!book) return;
        readerPageIndex = Math.max(0, Math.min(readerPageIndex + delta, book.pages.length - 1));
        renderReader();
      }

      function renderReader() {
        var book = getBook(readerBookId);
        if (!book) return;
        var page = book.pages[readerPageIndex];
        document.getElementById("readerTitle").textContent = book.titleRu;
        document.getElementById("readerMeta").textContent = "Фрагмент " + page.page + " из " + book.totalChunks;
        document.getElementById("readerPage").innerHTML = '<img src="' + page.imageUrl + '" alt="">';
        document.getElementById("readerAudio").src = page.audioUrl || book.bookAudioUrl || "";
        document.getElementById("readerPrev").disabled = readerPageIndex === 0;
        document.getElementById("readerNext").disabled = readerPageIndex >= book.pages.length - 1;
        var strip = document.getElementById("readerStrip");
        strip.innerHTML = "";
        book.pages.forEach(function(item, index) {
          var dot = document.createElement("button");
          dot.className = "page-dot" + (index === readerPageIndex ? " active" : "");
          dot.textContent = item.page;
          dot.addEventListener("click", function() {
            readerPageIndex = index;
            renderReader();
          });
          strip.appendChild(dot);
        });
      }

      async function startBook(bookId, pace) {
        await api("/books/" + bookId + "/start", { method: "POST", body: { pace: pace } });
        await loadState();
        toast("Книга добавлена. Открой «Сегодня» и получи первый фрагмент.");
        switchView("todayView");
      }

      async function nextPage(bookId) {
        var data = await api("/books/" + bookId + "/next", { method: "POST" });
        lesson = data.lesson;
        await loadState();
        toast("Фрагмент открыт. После заучивания отметь результат.");
        switchView("todayView");
      }

      async function sendFeedback(bookId, feedback) {
        await api("/books/" + bookId + "/feedback", { method: "POST", body: { feedback: feedback } });
        lesson = null;
        await loadState();
        toast("Отметка сохранена. Повторение добавлено в план.");
        switchView("scheduleView");
      }

      async function toggleBook(sub) {
        await api("/books/" + sub.bookId + (sub.active ? "/pause" : "/resume"), { method: "POST" });
        await loadState();
      }

      async function updateSettings(bookId, payload) {
        await api("/books/" + bookId + "/settings", { method: "POST", body: payload });
        await loadState();
      }

      async function updateWeeklyGoal(goal) {
        await api("/settings/weekly-goal", { method: "POST", body: { weeklyGoalPages: goal } });
        await loadState();
        toast("Цель на неделю обновлена.");
        switchView("progressView");
      }

      function switchView(id) {
        document.querySelector('.tab[data-view="' + id + '"]').click();
      }

      function getBook(bookId) {
        return state && state.books.find(function(book) { return book.id === bookId; });
      }

      function getSubscription(bookId) {
        return state && state.subscriptions.find(function(sub) { return sub.bookId === bookId; });
      }

      function metric(label, value, description, className) {
        var el = document.createElement("div");
        el.className = "metric" + (className ? " " + className : "");
        el.innerHTML = '<b>' + esc(value) + '</b><span>' + esc(label) + '<br>' + esc(description) + '</span>';
        return el;
      }

      function plainInsight(text) {
        var el = document.createElement("div");
        el.className = "insight";
        el.textContent = text;
        return el;
      }

      function plainNotice(text) {
        var el = document.createElement("div");
        el.className = "notice";
        el.textContent = text;
        return el;
      }

      function button(text, className, onClick) {
        var btn = document.createElement("button");
        btn.className = className;
        btn.textContent = text;
        btn.addEventListener("click", onClick);
        return btn;
      }

      function selectField(label, value, options, onChange) {
        var wrap = document.createElement("div");
        wrap.className = "field";
        var html = '<label>' + esc(label) + '</label><select>';
        options.forEach(function(opt) {
          html += '<option value="' + esc(opt[0]) + '"' + (String(opt[0]) === String(value) ? ' selected' : '') + '>' + esc(opt[1]) + '</option>';
        });
        html += '</select>';
        wrap.innerHTML = html;
        wrap.querySelector("select").addEventListener("change", function(e) { onChange(e.target.value); });
        return wrap;
      }

      function esc(value) {
        return String(value || "").replace(/[&<>"']/g, function(ch) {
          return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[ch];
        });
      }
      function pad(value) { return String(value).padStart(2, "0"); }
      function paceValue(pace) { return paceValues[pace] || 1; }
      function formatFutureDate(days) {
        var date = new Date();
        date.setDate(date.getDate() + Math.max(0, Number(days) || 0));
        return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
      }
      function toast(text) {
        var el = document.getElementById("toast");
        el.textContent = text;
        el.style.display = "block";
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(function() { el.style.display = "none"; }, 3200);
      }
      function dateLabel(value) {
        if (value === new Date().toISOString().slice(0,10)) return "сегодня";
        return new Date(value + "T12:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
      }

      loadState();
    </script>
  </body>
</html>`;
}

function renderProductApp(): string {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-visual" />
    <meta name="theme-color" content="#101214" />
    <meta name="color-scheme" content="dark" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="NurTech Hifz" />
    <title>NurTech Hifz</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <link rel="stylesheet" href="/assets/hifz-app.css?v=20260714-cropfix01" />
  </head>
  <body>
    <main class="app-shell">
      <header class="app-top">
        <div class="brand-lockup">
          <span class="brand-mark">H</span>
          <div>
            <b>NurTech Hifz</b>
            <span id="userLabel">личный кабинет</span>
          </div>
        </div>
        <button class="icon-btn" type="button" data-action="refresh" aria-label="Обновить">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.95 7.95 0 1 0 20 12"/><path d="M20 4.5v5h-5"/></svg>
        </button>
      </header>

      <section id="authView" class="state-card hidden">
        <h1>Открой из Telegram</h1>
        <p>Кабинет привязан к Telegram. Открой бота и нажми кнопку «Кабинет».</p>
      </section>

      <section class="view active" id="todayView">
        <div class="hero-card">
          <div>
            <span class="eyebrow" id="todayStatus">Сегодня</span>
            <h1>Твой план на сегодня</h1>
            <p id="todayLead">Загружаю занятия...</p>
          </div>
          <div class="hero-actions">
            <button class="btn primary" type="button" data-action="continue">Продолжить учебу</button>
            <button class="btn secondary" type="button" data-action="open-reader-current">Читать книгу</button>
          </div>
        </div>

        <div class="metrics-grid">
          <div class="metric-card"><b id="mNew">0</b><span>фрагментов сегодня</span></div>
          <div class="metric-card"><b id="mReviews">0</b><span>повторений</span></div>
          <div class="metric-card"><b id="mGoal">0/5</b><span>цель недели</span></div>
        </div>

        <div id="todayNotice"></div>
        <div class="section-card">
          <div class="section-head">
            <div>
              <h2>Что делать сейчас</h2>
              <p>Одна карточка — одно понятное действие.</p>
            </div>
          </div>
          <div id="todayPlan" class="stack"></div>
        </div>

        <div class="section-card">
          <div class="section-head">
            <div>
              <h2>Книги в обучении</h2>
              <p>В ежедневный план попадает максимум две книги.</p>
            </div>
            <button class="btn small secondary" type="button" data-view="booksView">Управлять</button>
          </div>
          <div id="todayProgress" class="stack"></div>
        </div>
      </section>

      <section class="view" id="studyView">
        <div id="lessonArea" class="study-layout"></div>
      </section>

      <section class="view" id="readView">
        <div class="reader-layout">
          <aside class="section-card reader-library-card">
            <div class="section-head">
              <div>
                <h2>Читать книгу</h2>
                <p>Полный текст и аудио. Это не меняет расписание, пока не нажмёшь «Учить фрагмент».</p>
              </div>
            </div>
            <div id="readBooks" class="stack compact"></div>
          </aside>
          <section class="section-card reader-card">
            <div id="readerBox"></div>
          </section>
        </div>
      </section>

      <section class="view" id="booksView">
        <div class="section-card">
          <div class="section-head">
            <div>
              <h2>Книги, которые я учу</h2>
              <p>По этим книгам бот может присылать ежедневные фрагменты.</p>
            </div>
            <span class="soft-pill" id="activeLimit">0/2</span>
          </div>
          <div id="activeBooks" class="stack"></div>
        </div>

        <div class="section-card">
          <div class="section-head">
            <div>
              <h2>Библиотека</h2>
              <p>Здесь все книги. Их можно читать без добавления в занятия.</p>
            </div>
          </div>
          <div id="catalogBooks" class="stack"></div>
        </div>

        <div class="section-card">
          <div class="section-head">
            <div>
              <h2>Сохранено, но не учу</h2>
              <p>Эти книги не приходят каждый день. Их можно вернуть в занятия или убрать совсем.</p>
            </div>
          </div>
          <div id="pausedBooks" class="stack"></div>
        </div>
      </section>

      <section class="view" id="progressView">
        <div class="section-card">
          <div class="section-head">
            <div>
              <h2>Прогресс</h2>
              <p>История занятий, цель недели и слабые фрагменты.</p>
            </div>
          </div>
          <div id="progressMetrics" class="metrics-grid inside"></div>
        </div>

        <div class="progress-grid">
          <div class="section-card">
            <h2>Цель недели</h2>
            <div id="weeklyGoal" class="stack"></div>
          </div>
          <div class="section-card">
            <h2>Календарь</h2>
            <div id="habitCalendar" class="habit-grid"></div>
          </div>
        </div>

        <div class="progress-grid">
          <div class="section-card">
            <h2>Повторения</h2>
            <div id="reviewsList" class="stack"></div>
          </div>
          <div class="section-card">
            <h2>Слабые фрагменты</h2>
            <div id="weakList" class="stack"></div>
          </div>
        </div>

        <div class="progress-grid">
          <div class="section-card">
            <h2>История</h2>
            <div id="historyList" class="stack"></div>
          </div>
        </div>
      </section>
    </main>

    <nav class="bottom-nav">
      <button class="nav-tab active" type="button" data-view="todayView">
        <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4.5 10.75 12 4.5l7.5 6.25v8.75a1 1 0 0 1-1 1h-4.25v-5.75h-4.5v5.75H5.5a1 1 0 0 1-1-1v-8.75Z"/></svg></span>
        <span>Сегодня</span>
      </button>
      <button class="nav-tab" type="button" data-view="studyView">
        <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 4.5h8.5A3.5 3.5 0 0 1 18 8v11.5H8A3 3 0 0 1 5 16.5V5.5a1 1 0 0 1 1-1Z"/><path d="M8 16.5h10"/><path d="M9 8h5"/><path d="M9 11h4"/></svg></span>
        <span>Учить</span>
      </button>
      <button class="nav-tab" type="button" data-view="readView">
        <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4.75 5.75A2.25 2.25 0 0 1 7 3.5h12.25v15H7A2.25 2.25 0 0 0 4.75 20.75v-15Z"/><path d="M7 18.5h12.25"/><path d="M8.5 7.5h7"/><path d="M8.5 10.5h5.5"/></svg></span>
        <span>Читать</span>
      </button>
      <button class="nav-tab" type="button" data-view="booksView">
        <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v16H7.5A2.5 2.5 0 0 1 5 16.5v-11Z"/><path d="M9 3v16"/><path d="M12 7h4.5"/><path d="M12 10h3.5"/></svg></span>
        <span>Книги</span>
      </button>
      <button class="nav-tab" type="button" data-view="progressView">
        <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 19V5"/><path d="M5 19h14"/><path d="M8.5 15.5v-4"/><path d="M12 15.5v-7"/><path d="M15.5 15.5v-10"/></svg></span>
        <span>Прогресс</span>
      </button>
    </nav>

    <div class="toast" id="toast"></div>
    <script src="/assets/hifz-app.js?v=20260714-cropfix01"></script>
  </body>
</html>`;
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>NurTech Hifz</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      * { box-sizing: border-box; }
      :root {
        color-scheme: dark;
        --bg: #101214;
        --surface: #17191c;
        --surface-2: #1f2226;
        --surface-3: #272b30;
        --line: #30353b;
        --line-soft: rgba(255,255,255,.08);
        --text: #f2f3f5;
        --muted: #a4abb3;
        --muted-2: #7e858d;
        --accent: #c4a261;
        --accent-2: #e2c985;
        --danger: #c98278;
        --ok: #b8c0aa;
      }
      html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
      body {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      button, select, input { font: inherit; }
      button { cursor: pointer; }
      .app {
        width: min(1060px, 100%);
        margin: 0 auto;
        padding: calc(16px + env(safe-area-inset-top)) 14px calc(94px + env(safe-area-inset-bottom));
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 14px;
      }
      .brand { min-width: 0; }
      .brand b { display: block; font-size: 18px; line-height: 1.1; }
      .brand span { color: var(--muted); font-size: 13px; }
      .pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 34px;
        padding: 7px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--muted);
        font-size: 13px;
        white-space: nowrap;
      }
      .card {
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 16px;
        box-shadow: 0 18px 52px rgba(0,0,0,.28);
      }
      .section { padding: 14px; }
      .view { display: none; gap: 12px; }
      .view.active { display: grid; }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: clamp(28px, 7vw, 48px); line-height: 1.05; letter-spacing: 0; }
      h2 { font-size: 21px; line-height: 1.18; letter-spacing: 0; }
      h3 { font-size: 16px; line-height: 1.22; letter-spacing: 0; }
      p { color: var(--muted); line-height: 1.5; }
      .lead { margin-top: 8px; color: #c5cbd0; font-size: 15px; }
      .hero {
        padding: 18px;
        background:
          linear-gradient(145deg, rgba(196,162,97,.12), transparent 48%),
          var(--surface);
      }
      .hero-row { display: grid; gap: 14px; }
      .hero-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
      .btn {
        border: 0;
        min-height: 44px;
        padding: 11px 14px;
        border-radius: 12px;
        background: var(--accent);
        color: #15110a;
        font-weight: 800;
      }
      .btn.secondary {
        background: var(--surface-2);
        color: var(--text);
        border: 1px solid var(--line);
      }
      .btn.ghost {
        background: transparent;
        color: var(--muted);
        border: 1px solid var(--line);
      }
      .btn.warn { background: #3a3024; color: var(--accent-2); border: 1px solid rgba(196,162,97,.35); }
      .btn.danger { background: #3b2928; color: #e0aaa4; border: 1px solid rgba(201,130,120,.32); }
      .btn:disabled { opacity: .55; cursor: default; }
      .grid { display: grid; gap: 12px; }
      .grid.two { grid-template-columns: 1fr; }
      .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .metric {
        padding: 12px;
        border-radius: 14px;
        background: var(--surface-2);
        border: 1px solid var(--line-soft);
        min-height: 76px;
      }
      .metric b { display: block; font-size: 22px; line-height: 1; }
      .metric span { display: block; color: var(--muted); font-size: 12px; line-height: 1.35; margin-top: 6px; }
      .notice {
        padding: 12px;
        border-radius: 14px;
        background: #211f1a;
        border: 1px solid rgba(196,162,97,.22);
        color: #e6d3aa;
        line-height: 1.45;
      }
      .list { display: grid; gap: 10px; }
      .book, .task, .history-row, .weak-row {
        padding: 13px;
        border-radius: 14px;
        background: var(--surface-2);
        border: 1px solid var(--line-soft);
      }
      .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
      .title { min-width: 0; }
      .title b { display: block; font-size: 16px; line-height: 1.25; }
      .title span { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .tag {
        border: 1px solid var(--line);
        color: var(--muted);
        background: #15171a;
        border-radius: 999px;
        padding: 5px 8px;
        font-size: 12px;
      }
      .bar { height: 8px; margin-top: 12px; border-radius: 999px; overflow: hidden; background: #111315; border: 1px solid var(--line-soft); }
      .bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border-radius: inherit; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .lesson-layout { display: grid; gap: 12px; }
      .lesson-media { overflow: hidden; background: #d8dadb; border-radius: 14px; border: 1px solid var(--line); }
      .lesson-media img { display: block; width: 100%; max-height: 58vh; object-fit: contain; }
      audio { width: 100%; margin-top: 10px; }
      .steps { display: grid; gap: 8px; }
      .step {
        display: grid;
        grid-template-columns: 34px 1fr;
        gap: 10px;
        padding: 10px;
        border-radius: 14px;
        background: var(--surface-2);
        border: 1px solid var(--line-soft);
      }
      .step i {
        width: 34px;
        height: 34px;
        border-radius: 999px;
        display: grid;
        place-items: center;
        background: #28231a;
        color: var(--accent-2);
        font-style: normal;
        font-weight: 900;
      }
      .reader-shell { display: grid; gap: 10px; }
      .reader-page { overflow: hidden; background: #d8dadb; border-radius: 14px; }
      .reader-page img { display: block; width: 100%; max-height: 62vh; object-fit: contain; }
      .page-strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
      .page-dot {
        flex: 0 0 auto;
        min-width: 40px;
        min-height: 36px;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--muted);
      }
      .page-dot.active { background: var(--accent); color: #15110a; border-color: transparent; font-weight: 900; }
      .habit { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
      .day {
        min-height: 50px;
        border-radius: 12px;
        border: 1px solid var(--line-soft);
        background: var(--surface-2);
        color: var(--muted);
        display: grid;
        place-items: center;
        font-size: 12px;
      }
      .day.done { background: #2b251b; color: var(--accent-2); border-color: rgba(196,162,97,.35); }
      .day.hard { background: #352a25; color: #e0aaa4; }
      .weak-row { display: grid; grid-template-columns: 58px 1fr; gap: 10px; align-items: center; }
      .weak-row img { width: 58px; height: 74px; object-fit: cover; border-radius: 9px; background: #d8dadb; }
      select {
        width: 100%;
        min-height: 44px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--text);
        padding: 0 12px;
      }
      .field { display: grid; gap: 7px; margin-top: 10px; }
      .field label { color: var(--muted); font-size: 13px; }
      .tabs {
        position: fixed;
        left: 50%;
        bottom: calc(10px + env(safe-area-inset-bottom));
        transform: translateX(-50%);
        width: min(720px, calc(100% - 18px));
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 4px;
        padding: 6px;
        border-radius: 18px;
        background: rgba(23,25,28,.96);
        border: 1px solid var(--line);
        z-index: 10;
      }
      .tab {
        min-height: 42px;
        border: 0;
        border-radius: 13px;
        background: transparent;
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
      }
      .tab.active { background: var(--surface-3); color: var(--accent-2); }
      .toast {
        display: none;
        position: fixed;
        z-index: 20;
        left: 50%;
        bottom: calc(76px + env(safe-area-inset-bottom));
        transform: translateX(-50%);
        width: min(520px, calc(100% - 24px));
        padding: 11px 13px;
        border-radius: 14px;
        background: #111315;
        border: 1px solid var(--line);
        color: var(--text);
        box-shadow: 0 18px 48px rgba(0,0,0,.38);
      }
      @media (min-width: 820px) {
        .hero-row { grid-template-columns: 1.1fr .9fr; align-items: center; }
        .grid.two { grid-template-columns: minmax(0,1fr) minmax(340px,.9fr); align-items: start; }
        .lesson-layout { grid-template-columns: minmax(0,1fr) 360px; align-items: start; }
      }
    </style>
  </head>
  <body>
    <main class="app">
      <header class="top">
        <div class="brand"><b>NurTech Hifz</b><span id="userLabel">личный кабинет</span></div>
        <button class="pill" id="refreshBtn">Обновить</button>
      </header>

      <section id="authView" class="card section" style="display:none">
        <h2>Открой из Telegram</h2>
        <p class="lead">Кабинет привязан к Telegram-пользователю. Открой бота и нажми «Кабинет».</p>
      </section>

      <section class="view active" id="todayView">
        <div class="card hero">
          <div class="hero-row">
            <div>
              <span class="pill" id="todayStatus">Сегодня</span>
              <h1 style="margin-top:12px">Что учим сегодня</h1>
              <p class="lead" id="todayLead">Здесь будет твой план на день.</p>
              <div class="hero-actions">
                <button class="btn" id="startLessonBtn">Начать занятие</button>
                <button class="btn secondary" data-jump="reviewView">Повторения</button>
                <button class="btn ghost" data-jump="readView">Читать</button>
              </div>
            </div>
            <div class="metrics">
              <div class="metric"><b id="mNew">0</b><span>новые фрагменты</span></div>
              <div class="metric"><b id="mReviews">0</b><span>повторить сегодня</span></div>
              <div class="metric"><b id="mGoal">0/5</b><span>цель недели</span></div>
            </div>
          </div>
        </div>
        <div id="todayNotice"></div>
        <div class="grid two">
          <div class="card section">
            <h2>План на сегодня</h2>
            <div id="todayPlan" class="list" style="margin-top:12px"></div>
          </div>
          <div class="card section">
            <h2>Текущий прогресс</h2>
            <div id="todayProgress" class="list" style="margin-top:12px"></div>
          </div>
        </div>
      </section>

      <section class="view" id="studyView">
        <div class="card section">
          <h2>Занятие</h2>
          <p class="lead">Один экран для заучивания: текст, аудио, самопроверка и отметка результата.</p>
        </div>
        <div id="lessonArea" class="lesson-layout"></div>
      </section>

      <section class="view" id="booksView">
        <div class="grid two">
          <div class="card section">
            <h2>Сейчас учу</h2>
            <p class="lead">Эти книги участвуют в ежедневных заданиях.</p>
            <div id="activeBooks" class="list" style="margin-top:12px"></div>
          </div>
          <div class="card section">
            <h2>Добавить книгу</h2>
            <p class="lead">Можно учить максимум две книги одновременно.</p>
            <div id="catalogBooks" class="list" style="margin-top:12px"></div>
          </div>
        </div>
        <div class="card section">
          <h2>Не в ежедневных заданиях</h2>
          <div id="pausedBooks" class="list" style="margin-top:12px"></div>
        </div>
      </section>

      <section class="view" id="readView">
        <div class="grid two">
          <div class="card section">
            <h2>Чтение</h2>
            <p class="lead">Открой полный текст любой книги без изменения учебного плана.</p>
            <div id="readBooks" class="list" style="margin-top:12px"></div>
          </div>
          <div class="card section">
            <div class="reader-shell" id="readerBox"></div>
          </div>
        </div>
      </section>

      <section class="view" id="reviewView">
        <div class="grid two">
          <div class="card section">
            <h2>Повторения</h2>
            <p class="lead">То, что нужно закрепить сегодня и в ближайшие дни.</p>
            <div id="reviewList" class="list" style="margin-top:12px"></div>
          </div>
          <div class="card section">
            <h2>Слабые фрагменты</h2>
            <p class="lead">Страницы, которые отмечались как сложные.</p>
            <div id="weakList" class="list" style="margin-top:12px"></div>
          </div>
        </div>
      </section>

      <section class="view" id="progressView">
        <div class="card section">
          <h2>Прогресс</h2>
          <div id="progressMetrics" class="metrics" style="margin-top:12px"></div>
        </div>
        <div class="grid two">
          <div class="card section">
            <h2>Цель недели</h2>
            <div id="weeklyGoal" style="margin-top:12px"></div>
          </div>
          <div class="card section">
            <h2>Календарь привычки</h2>
            <div id="habitCalendar" class="habit" style="margin-top:12px"></div>
          </div>
        </div>
        <div class="grid two">
          <div class="card section">
            <h2>По книгам</h2>
            <div id="bookAnalytics" class="list" style="margin-top:12px"></div>
          </div>
          <div class="card section">
            <h2>История</h2>
            <div id="historyList" class="list" style="margin-top:12px"></div>
          </div>
        </div>
      </section>
    </main>

    <nav class="tabs">
      <button class="tab active" data-view="todayView">Сегодня</button>
      <button class="tab" data-view="studyView">Учеба</button>
      <button class="tab" data-view="booksView">Книги</button>
      <button class="tab" data-view="readView">Читать</button>
      <button class="tab" data-view="reviewView">Повтор</button>
      <button class="tab" data-view="progressView">Прогресс</button>
    </nav>
    <div class="toast" id="toast"></div>

    <script>
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg) { tg.ready(); tg.expand(); }
      var initData = tg ? tg.initData : "";
      var state = null;
      var lesson = null;
      var readerBookId = null;
      var readerPageIndex = 0;
      var paceLabels = { slow: "1 фрагмент/день", normal: "2 фрагмента/день", fast: "3 фрагмента/день" };
      var paceValues = { slow: 1, normal: 2, fast: 3 };
      var modeLabels = { read_listen: "текст и аудио", read: "только текст", listen: "только аудио", review: "только повторение" };
      var feedbackLabels = { learned: "Выучил", hard: "Сложно", repeat: "Повторить завтра" };

      document.querySelectorAll(".tab").forEach(function(tab) {
        tab.addEventListener("click", function() { switchView(tab.dataset.view); });
      });
      document.querySelectorAll("[data-jump]").forEach(function(btn) {
        btn.addEventListener("click", function() { switchView(btn.dataset.jump); });
      });
      document.getElementById("refreshBtn").addEventListener("click", loadState);
      document.getElementById("startLessonBtn").addEventListener("click", startPrimaryLesson);

      async function api(path, options) {
        options = options || {};
        var res = await fetch("/api/app" + path, {
          method: options.method || "GET",
          headers: { "content-type": "application/json", "x-telegram-init-data": initData },
          body: options.body ? JSON.stringify(options.body) : undefined
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || "Ошибка");
        return data;
      }

      async function loadState() {
        if (!initData) {
          document.getElementById("authView").style.display = "block";
          document.querySelectorAll(".view,.tabs").forEach(function(item) { item.style.display = "none"; });
          return;
        }
        state = await api("/state");
        document.getElementById("userLabel").textContent = state.user.firstName || "личный кабинет";
        if (!readerBookId && state.books[0]) readerBookId = state.books[0].id;
        renderAll();
      }

      function renderAll() {
        renderToday();
        renderStudy();
        renderBooks();
        renderReading();
        renderReview();
        renderProgress();
      }

      function renderToday() {
        var active = activeSubs();
        var due = dueReviewItems();
        var newPages = active.reduce(function(sum, sub) { return sum + paceValue(sub.pace); }, 0);
        document.getElementById("mNew").textContent = newPages;
        document.getElementById("mReviews").textContent = due.length;
        document.getElementById("mGoal").textContent = state.activity.weeklyGoal.learned + "/" + state.activity.weeklyGoal.pages;
        document.getElementById("todayStatus").textContent = state.activity.today.studied ? "Сегодня выполнено" : "Сегодня";
        document.getElementById("todayLead").textContent = active.length ? "Открой занятие, пройди фрагмент и отметь результат." : "Добавь первую книгу, чтобы появился план занятий.";
        document.getElementById("todayNotice").innerHTML = state.activity.today.shouldRemind ? '<div class="notice">' + esc(state.activity.today.text) + '</div>' : "";

        var plan = document.getElementById("todayPlan");
        plan.innerHTML = "";
        if (!active.length) plan.appendChild(notice("Нет книг в занятиях. Открой «Книги» и добавь матн."));
        active.forEach(function(sub) {
          plan.appendChild(taskCard("Новый фрагмент", sub.titleRu, nextLabel(sub), [
            ["Начать", "btn", function() { nextPage(sub.bookId); }],
            ["Читать", "btn secondary", function() { openReader(sub.bookId, Math.max(0, sub.nextChunkIndex)); }]
          ]));
        });
        due.slice(0, 4).forEach(function(item) {
          plan.appendChild(taskCard("Повторение", item.titleRu, item.label, [
            ["Открыть", "btn secondary", function() { openReviewPage(item); }]
          ]));
        });

        var progress = document.getElementById("todayProgress");
        progress.innerHTML = "";
        active.forEach(function(sub) { progress.appendChild(compactBook(sub)); });
        if (!active.length) progress.appendChild(notice("Пока нет активных книг."));
      }

      function renderStudy() {
        var box = document.getElementById("lessonArea");
        box.innerHTML = "";
        if (!lesson) {
          var active = activeSubs();
          var panel = div("card section");
          panel.innerHTML = '<h2>Готов к занятию?</h2><p class="lead">Выбери книгу или нажми «Начать занятие». Я открою следующий фрагмент с аудио.</p>';
          var actions = div("actions");
          if (active[0]) actions.appendChild(button("Начать занятие", "btn", function() { nextPage(active[0].bookId); }));
          actions.appendChild(button("Выбрать книгу", "btn secondary", function() { switchView("booksView"); }));
          panel.appendChild(actions);
          box.appendChild(panel);
          box.appendChild(stepsPanel());
          return;
        }
        var media = div("card section");
        var audioLabel = lesson.audioScope === "book"
          ? "Аудио - чтение всего матна. Оно не привязано к отдельному фрагменту."
          : lesson.audioStatus === "verified"
            ? "Проверенное аудио этого фрагмента."
            : "Аудио для этого фрагмента пока не проверено.";
        media.innerHTML = '<div class="lesson-media"><img src="' + lesson.imageUrl + '" alt=""></div>' +
          (lesson.audioUrl ? '<audio src="' + lesson.audioUrl + '" controls></audio><p class="lead">' + audioLabel + '</p>' : '');
        var side = div("card section");
        side.innerHTML = '<h2>' + esc(lesson.titleRu) + '</h2><p class="lead">Фрагмент ' + lesson.page + ' из ' + lesson.total + '</p>';
        side.appendChild(stepsPanel());
        var actions = div("actions");
        actions.appendChild(button("Выучил", "btn", function() { sendFeedback(lesson.bookId, "learned"); }));
        actions.appendChild(button("Сложно", "btn warn", function() { sendFeedback(lesson.bookId, "hard"); }));
        actions.appendChild(button("Повторить завтра", "btn secondary", function() { sendFeedback(lesson.bookId, "repeat"); }));
        side.appendChild(actions);
        box.appendChild(media);
        box.appendChild(side);
      }

      function renderBooks() {
        var activeBox = document.getElementById("activeBooks");
        var pausedBox = document.getElementById("pausedBooks");
        var catalogBox = document.getElementById("catalogBooks");
        activeBox.innerHTML = "";
        pausedBox.innerHTML = "";
        catalogBox.innerHTML = "";
        var active = activeSubs();
        var paused = state.subscriptions.filter(function(sub) { return !sub.active; });
        if (!active.length) activeBox.appendChild(notice("Нет книг в ежедневных заданиях."));
        active.forEach(function(sub) { activeBox.appendChild(bookCard(sub)); });
        if (!paused.length) pausedBox.appendChild(notice("Пока нет книг вне занятий."));
        paused.forEach(function(sub) { pausedBox.appendChild(bookCard(sub)); });
        var activeCount = active.length;
        if (activeCount >= state.maxActiveBooks) catalogBox.appendChild(notice("Сейчас уже учатся 2 книги. Чтобы добавить новую, поставь одну книгу на паузу."));
        state.books.forEach(function(book) { catalogBox.appendChild(catalogCard(book, activeCount)); });
      }

      function renderReading() {
        var list = document.getElementById("readBooks");
        list.innerHTML = "";
        state.books.forEach(function(book) {
          list.appendChild(taskCard(book.totalChunks + " фрагментов", book.titleRu, book.titleAr || "полный текст и аудио", [
            ["Читать", "btn secondary", function() { openReader(book.id, 0); }],
            ["PDF целиком", "btn ghost", function() { openFullPdf(book); }]
          ]));
        });
        renderReader();
      }

      function renderReview() {
        var list = document.getElementById("reviewList");
        var weak = document.getElementById("weakList");
        list.innerHTML = "";
        weak.innerHTML = "";
        var items = state.schedule.filter(function(item) { return item.type === "review"; });
        if (!items.length) list.appendChild(notice("Повторений пока нет. Они появятся после отметки результата."));
        items.forEach(function(item) {
          list.appendChild(taskCard(dateLabel(item.dueDate), item.titleRu, item.label, [["Открыть", "btn secondary", function() { openReviewPage(item); }]]));
        });
        if (!state.activity.weakPages.length) weak.appendChild(notice("Слабые фрагменты появятся после отметки «Сложно»."));
        state.activity.weakPages.forEach(function(item) {
          weak.appendChild(weakCard(item));
        });
      }

      function renderProgress() {
        var metrics = document.getElementById("progressMetrics");
        var goal = document.getElementById("weeklyGoal");
        var cal = document.getElementById("habitCalendar");
        var books = document.getElementById("bookAnalytics");
        var hist = document.getElementById("historyList");
        metrics.innerHTML = "";
        goal.innerHTML = "";
        cal.innerHTML = "";
        books.innerHTML = "";
        hist.innerHTML = "";
        var total = state.subscriptions.reduce(function(sum, sub) { return sum + sub.totalChunks; }, 0);
        var sent = state.subscriptions.reduce(function(sum, sub) { return sum + Math.min(sub.nextChunkIndex, sub.totalChunks); }, 0);
        var hard = state.subscriptions.reduce(function(sum, sub) { return sum + sub.hardCount; }, 0);
        metrics.appendChild(metric(Math.round(total ? sent / total * 100 : 0) + "%", "общий прогресс"));
        metrics.appendChild(metric(state.activity.weeklyGoal.learned + "/" + state.activity.weeklyGoal.pages, "цель недели"));
        metrics.appendChild(metric(hard, "сложные фрагменты"));
        goal.appendChild(goalControl(state.activity.weeklyGoal.pages));
        state.activity.calendar.forEach(function(day) { cal.appendChild(habitDay(day)); });
        state.subscriptions.forEach(function(sub) { books.appendChild(analyticsBook(sub)); });
        state.activity.history.forEach(function(day) { hist.appendChild(historyRow(day)); });
      }

      function stepsPanel() {
        var panel = div("steps");
        panel.innerHTML =
          '<div class="step"><i>1</i><div><b>Прочитай</b><p>Посмотри фрагмент внимательно.</p></div></div>' +
          '<div class="step"><i>2</i><div><b>Послушай</b><p>Включи аудио и повтори за чтением.</p></div></div>' +
          '<div class="step"><i>3</i><div><b>Закрой текст</b><p>Попробуй воспроизвести по памяти.</p></div></div>' +
          '<div class="step"><i>4</i><div><b>Отметь результат</b><p>Так фрагмент попадет в нужное повторение.</p></div></div>';
        return panel;
      }

      function bookCard(sub) {
        var el = div("book");
        el.innerHTML = '<div class="head"><div class="title"><b>' + esc(sub.titleRu) + '</b><span>' + (sub.active ? "Сейчас учишь" : "Не приходит в задания") + '</span></div><span class="pill">' + sub.progressPercent + '%</span></div>' +
          '<div class="meta"><span class="tag">' + paceLabels[sub.pace] + '</span><span class="tag">' + pad(sub.dailyHour) + ':00</span><span class="tag">' + modeLabels[sub.mode] + '</span></div>' +
          '<div class="bar"><i style="width:' + sub.progressPercent + '%"></i></div>';
        var actions = div("actions");
        actions.appendChild(sub.active ? button("Начать", "btn", function() { nextPage(sub.bookId); }) : button("Снова учить", "btn", function() { toggleBook(sub); }));
        actions.appendChild(button("Читать", "btn secondary", function() { openReader(sub.bookId, 0); }));
        actions.appendChild(sub.active ? button("Не присылать задания", "btn ghost", function() { toggleBook(sub); }) : button("Настроить", "btn ghost", function() { switchView("progressView"); }));
        el.appendChild(actions);
        return el;
      }

      function catalogCard(book, activeCount) {
        var existing = getSubscription(book.id);
        var el = div("book");
        el.innerHTML = '<div class="head"><div class="title"><b>' + esc(book.titleRu) + '</b><span>' + esc(book.titleAr || "") + '</span></div><span class="pill">' + book.totalChunks + ' фрагм.</span></div>';
        var actions = div("actions");
        actions.appendChild(button("Читать", "btn secondary", function() { openReader(book.id, 0); }));
        if (existing) {
          actions.appendChild(existing.active ? button("Уже учишь", "btn", function() { switchView("todayView"); }) : button("Снова учить", "btn", function() { toggleBook(existing); }));
        } else if (activeCount >= state.maxActiveBooks) {
          var disabled = button("Сначала освободи место", "btn ghost", function() {});
          disabled.disabled = true;
          actions.appendChild(disabled);
        } else {
          actions.appendChild(button("1 фрагм./день", "btn", function() { startBook(book.id, "slow"); }));
          actions.appendChild(button("2 фрагм./день", "btn secondary", function() { startBook(book.id, "normal"); }));
          actions.appendChild(button("3 фрагм./день", "btn secondary", function() { startBook(book.id, "fast"); }));
        }
        el.appendChild(actions);
        return el;
      }

      function renderReader() {
        var box = document.getElementById("readerBox");
        if (!readerBookId && state.books[0]) readerBookId = state.books[0].id;
        var book = getBook(readerBookId);
        if (!book) {
          box.innerHTML = '<p class="lead">Выбери книгу для чтения.</p>';
          return;
        }
        readerPageIndex = Math.max(0, Math.min(readerPageIndex, book.pages.length - 1));
        var page = book.pages[readerPageIndex];
        var audio = page.audioUrl || book.bookAudioUrl;
        box.innerHTML =
          '<div class="head"><div class="title"><b>' + esc(book.titleRu) + '</b><span>Фрагмент ' + page.page + ' из ' + book.totalChunks + (page.sourcePageNumber ? ' · PDF стр. ' + page.sourcePageNumber : '') + '</span></div></div>' +
          '<div class="reader-page"><img src="' + page.imageUrl + '" alt=""></div>' +
          (audio ? '<audio src="' + audio + '" controls></audio><p class="lead">' + (page.audioUrl ? 'Аудио этого фрагмента.' : 'Аудио - чтение всего матна. Страницы PDF ниже точные, аудио включай как общее чтение.') + '</p>' : '') +
          '<div class="actions"><button class="btn secondary" id="readerPrev">Назад</button><button class="btn secondary" id="readerNext">Вперед</button><button class="btn" id="readerStudy">Учить этот фрагмент</button><button class="btn ghost" id="readerPdf">PDF целиком</button></div>' +
          '<div class="page-strip" id="pageStrip"></div>';
        document.getElementById("readerPrev").onclick = function() { moveReader(-1); };
        document.getElementById("readerNext").onclick = function() { moveReader(1); };
        document.getElementById("readerStudy").onclick = function() { studyFromReader(book.id); };
        document.getElementById("readerPdf").onclick = function() { openFullPdf(book); };
        var strip = document.getElementById("pageStrip");
        book.pages.forEach(function(item, index) {
          var dot = document.createElement("button");
          dot.className = "page-dot" + (index === readerPageIndex ? " active" : "");
          dot.textContent = item.page;
          dot.onclick = function() { readerPageIndex = index; renderReader(); };
          strip.appendChild(dot);
        });
      }

      function compactBook(sub) { return bookCard(sub); }
      function taskCard(kind, title, text, actionsDef) {
        var el = div("task");
        el.innerHTML = '<div class="head"><div class="title"><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div><span class="pill">' + esc(kind) + '</span></div>';
        var actions = div("actions");
        actionsDef.forEach(function(def) { actions.appendChild(button(def[0], def[1], def[2])); });
        el.appendChild(actions);
        return el;
      }
      function analyticsBook(sub) {
        var sent = Math.min(sub.nextChunkIndex, sub.totalChunks);
        var remaining = Math.max(0, sub.totalChunks - sent);
        var days = sub.active ? Math.ceil(remaining / paceValue(sub.pace)) : null;
        var el = div("book");
        el.innerHTML = '<div class="head"><div class="title"><b>' + esc(sub.titleRu) + '</b><span>' + sent + '/' + sub.totalChunks + ' фрагментов</span></div><span class="pill">' + sub.progressPercent + '%</span></div>' +
          '<div class="bar"><i style="width:' + sub.progressPercent + '%"></i></div><p class="lead">' + (sub.active ? (remaining ? "Около " + days + " дн. до конца" : "Книга пройдена") : "Не в ежедневных заданиях") + '</p>';
        return el;
      }
      function weakCard(item) {
        var el = div("weak-row");
        el.innerHTML = '<img src="' + item.imageUrl + '" alt=""><div><b>' + esc(item.titleRu) + ': фрагмент ' + item.page + '</b><span class="lead">Отмечался сложным: ' + item.count + ' раз</span><div class="actions"><button class="btn secondary">Открыть</button></div></div>';
        el.querySelector("button").onclick = function() { openReader(item.bookId, item.page - 1); };
        return el;
      }
      function goalControl(current) {
        var wrap = div("");
        wrap.appendChild(metric(state.activity.weeklyGoal.learned + "/" + current, "выучено на этой неделе"));
        var actions = div("actions");
        [3,5,7,10,14].forEach(function(goal) { actions.appendChild(button(String(goal), goal === current ? "btn" : "btn secondary", function() { updateWeeklyGoal(goal); })); });
        wrap.appendChild(actions);
        return wrap;
      }
      function historyRow(day) {
        var el = div("history-row");
        var parts = [];
        if (day.lessonPages) parts.push(day.lessonPages + " фрагм. получено");
        if (day.learned) parts.push(day.learned + " выучено");
        if (day.hard) parts.push(day.hard + " сложно");
        if (day.repeat) parts.push(day.repeat + " повторить");
        el.innerHTML = '<div><b>' + esc(day.label) + '</b></div><span>' + esc(parts.length ? parts.join(", ") : "занятий не было") + '</span>';
        return el;
      }
      function habitDay(day) {
        var el = div("day" + (day.studied ? " done" : "") + (day.hard ? " hard" : ""));
        el.textContent = day.label.split(" ")[0];
        return el;
      }
      function metric(value, label) {
        var el = div("metric");
        el.innerHTML = '<b>' + esc(value) + '</b><span>' + esc(label) + '</span>';
        return el;
      }
      function notice(text) {
        var el = div("notice");
        el.textContent = text;
        return el;
      }

      async function startPrimaryLesson() {
        var active = activeSubs();
        if (!active.length) { switchView("booksView"); return; }
        await nextPage(active[0].bookId);
      }
      async function nextPage(bookId) {
        var data = await api("/books/" + bookId + "/next", { method: "POST" });
        lesson = data.lesson;
        await loadState();
        switchView("studyView");
        toast("Фрагмент открыт. Пройди шаги и отметь результат.");
      }
      async function sendFeedback(bookId, feedback) {
        await api("/books/" + bookId + "/feedback", { method: "POST", body: { feedback: feedback } });
        lesson = null;
        await loadState();
        switchView("reviewView");
        toast("Отметка сохранена. Повторение добавлено в план.");
      }
      async function startBook(bookId, pace) {
        await api("/books/" + bookId + "/start", { method: "POST", body: { pace: pace } });
        await loadState();
        switchView("todayView");
        toast("Книга добавлена в занятия.");
      }
      async function toggleBook(sub) {
        await api("/books/" + sub.bookId + (sub.active ? "/pause" : "/resume"), { method: "POST" });
        await loadState();
      }
      async function updateWeeklyGoal(goal) {
        await api("/settings/weekly-goal", { method: "POST", body: { weeklyGoalPages: goal } });
        await loadState();
        toast("Цель недели обновлена.");
      }
      function openReader(bookId, pageIndex) {
        readerBookId = bookId;
        readerPageIndex = Math.max(0, pageIndex || 0);
        switchView("readView");
        renderReader();
      }

      function openFullPdf(book) {
        if (!book || !book.fullPdfUrl) return toast("PDF пока не подготовлен.");
        window.open(book.fullPdfUrl, "_blank");
      }
      function moveReader(delta) {
        var book = getBook(readerBookId);
        if (!book) return;
        readerPageIndex = Math.max(0, Math.min(readerPageIndex + delta, book.pages.length - 1));
        renderReader();
      }
      async function studyFromReader(bookId) {
        var sub = getSubscription(bookId);
        if (!sub) await startBook(bookId, "slow");
        else await nextPage(bookId);
      }
      function openReviewPage(item) { openReader(item.bookId, Math.max(0, item.page - 1)); }

      function switchView(id) {
        document.querySelectorAll(".tab").forEach(function(tab) { tab.classList.toggle("active", tab.dataset.view === id); });
        document.querySelectorAll(".view").forEach(function(view) { view.classList.toggle("active", view.id === id); });
      }
      function activeSubs() { return state.subscriptions.filter(function(sub) { return sub.active; }); }
      function dueReviewItems() { return state.schedule.filter(function(item) { return item.type === "review" && item.dueDate <= todayKey(); }); }
      function getBook(bookId) { return state.books.find(function(book) { return book.id === bookId; }); }
      function getSubscription(bookId) { return state.subscriptions.find(function(sub) { return sub.bookId === bookId; }); }
      function nextLabel(sub) { return sub.nextPreview ? "Фрагмент " + (sub.nextPreview.index + 1) + " из " + sub.totalChunks : "Новые фрагменты закончились"; }
      function paceValue(pace) { return paceValues[pace] || 1; }
      function pad(value) { return String(value).padStart(2, "0"); }
      function todayKey() { return new Date().toISOString().slice(0, 10); }
      function dateLabel(value) {
        if (value === todayKey()) return "сегодня";
        return new Date(value + "T12:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
      }
      function div(className) {
        var el = document.createElement("div");
        if (className) el.className = className;
        return el;
      }
      function button(text, className, onClick) {
        var btn = document.createElement("button");
        btn.className = className;
        btn.textContent = text;
        btn.onclick = onClick;
        return btn;
      }
      function esc(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) {
          return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[ch];
        });
      }
      function toast(text) {
        var el = document.getElementById("toast");
        el.textContent = text;
        el.style.display = "block";
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(function() { el.style.display = "none"; }, 3200);
      }

      loadState().catch(function(error) {
        document.getElementById("authView").style.display = "block";
        document.getElementById("authView").querySelector("p").textContent = error.message;
      });
    </script>
  </body>
</html>`;
}
