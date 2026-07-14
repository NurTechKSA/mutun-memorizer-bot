import { Markup, Telegraf, type Context } from "telegraf";
import { findBook, readCatalog } from "./content.js";
import type { AppConfig } from "./config.js";
import { sendDailyPortion, sendNextPage, sendSelfCheck, showChunk } from "./delivery.js";
import { JsonStore } from "./storage.js";
import type { CatalogBook, LessonFeedback, Pace, StudyMode, Subscription } from "./types.js";

const maxActiveBooks = 2;

const paceLabels: Record<Pace, string> = {
  slow: "1 страница в день",
  normal: "2 страницы в день",
  fast: "3 страницы в день"
};

const modeLabels: Record<StudyMode, string> = {
  read_listen: "текст и аудио",
  read: "только текст",
  listen: "только аудио",
  review: "только повторение"
};

const feedbackLabels: Record<LessonFeedback, string> = {
  learned: "Выучил",
  hard: "Сложно",
  repeat: "Повторить завтра"
};

export async function createBot(config: AppConfig, store: JsonStore): Promise<Telegraf> {
  const bot = new Telegraf(config.botToken);

  bot.start(async (ctx) => showMainMenu(ctx, config, store));
  bot.command("app", async (ctx) => showCabinetLink(ctx, config));
  bot.command("menu", async (ctx) => showMainMenu(ctx, config, store));
  bot.command("books", async (ctx) => showBooks(ctx, config, store));
  bot.command("today", async (ctx) => sendDailyPortion(bot, config, store, ctx.chat.id));
  bot.command("next", async (ctx) => sendNextPage(bot, config, store, ctx.chat.id));
  bot.command("progress", async (ctx) => showProgress(ctx, config, store));
  bot.command("schedule", async (ctx) => showSchedule(ctx, config, store));
  bot.command("time", async (ctx) => showTimePicker(ctx, store));
  bot.command("mode", async (ctx) => showModePicker(ctx, store));
  bot.command("check", async (ctx) => sendSelfCheck(bot, config, store, ctx.chat.id));
  bot.command("pause", async (ctx) => showPausePicker(ctx, store));

  bot.action("menu", async (ctx) => {
    await ctx.answerCbQuery();
    await showMainMenu(ctx, config, store);
  });

  bot.action("books", async (ctx) => {
    await ctx.answerCbQuery();
    await showBooks(ctx, config, store);
  });

  bot.action("mybooks", async (ctx) => {
    await ctx.answerCbQuery();
    await showMyBooks(ctx, config, store);
  });

  bot.action("today", async (ctx) => {
    await ctx.answerCbQuery();
    await sendDailyPortion(bot, config, store, ctx.chat!.id);
  });

  bot.action("next", async (ctx) => {
    await ctx.answerCbQuery();
    await sendNextPage(bot, config, store, ctx.chat!.id);
  });

  bot.action(/^next:([^:]+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await sendNextPage(bot, config, store, ctx.chat!.id, ctx.match[1]);
  });

  bot.action("schedule", async (ctx) => {
    await ctx.answerCbQuery();
    await showSchedule(ctx, config, store);
  });

  bot.action("settings", async (ctx) => {
    await ctx.answerCbQuery();
    await showSettings(ctx, config, store);
  });

  bot.action("pick_time", async (ctx) => {
    await ctx.answerCbQuery();
    await showTimePicker(ctx, store);
  });

  bot.action("pick_mode", async (ctx) => {
    await ctx.answerCbQuery();
    await showModePicker(ctx, store);
  });

  bot.action("pick_pause", async (ctx) => {
    await ctx.answerCbQuery();
    await showPausePicker(ctx, store);
  });

  bot.action("progress", async (ctx) => {
    await ctx.answerCbQuery();
    await showProgress(ctx, config, store);
  });

  bot.action("done_today", async (ctx) => {
    await ctx.answerCbQuery("Хорошо");
    await showMainMenu(ctx, config, store);
  });

  bot.action(/^book:(.+)$/, async (ctx) => {
    const bookId = ctx.match[1];
    const existing = await store.getSubscription(ctx.chat!.id, bookId);
    await ctx.answerCbQuery();

    if (existing) {
      await store.setActiveBook(ctx.chat!.id, bookId);
      await showBookPanel(ctx, config, existing);
      return;
    }

    const activeCount = (await activeSubscriptions(store, ctx.chat!.id)).length;
    if (activeCount >= maxActiveBooks) {
      await showBookLimit(ctx, config, store, bookId);
      return;
    }

    await ctx.reply(
      [
        "Выбери темп занятий.",
        "",
        "Темп - это сколько новых страниц бот будет присылать в обычный день.",
        "Если захочешь идти быстрее, в меню будет отдельная кнопка «Следующая страница»."
      ].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("Спокойно - 1 страница в день", `pace:${bookId}:slow`)],
        [Markup.button.callback("Средне - 2 страницы в день", `pace:${bookId}:normal`)],
        [Markup.button.callback("Быстро - 3 страницы в день", `pace:${bookId}:fast`)],
        [Markup.button.callback("Назад к книгам", "books")]
      ])
    );
  });

  bot.action(/^open:(.+)$/, async (ctx) => {
    const bookId = ctx.match[1];
    const subscription = await store.setActiveBook(ctx.chat!.id, bookId);
    await ctx.answerCbQuery();

    if (!subscription) {
      await ctx.reply("Не нашел эту книгу в твоих занятиях. Открой «Добавить книгу» и выбери заново.");
      return;
    }

    await showBookPanel(ctx, config, subscription);
  });

  bot.action(/^pace:([^:]+):(slow|normal|fast)$/, async (ctx) => {
    const [, bookId, pace] = ctx.match;
    const activeCount = (await activeSubscriptions(store, ctx.chat!.id)).length;
    const existing = await store.getSubscription(ctx.chat!.id, bookId);

    await ctx.answerCbQuery();

    if (!existing && activeCount >= maxActiveBooks) {
      await showBookLimit(ctx, config, store, bookId);
      return;
    }

    const subscription = await store.upsertSubscription(ctx.chat!.id, bookId, pace as Pace);
    const catalog = await readCatalog(config.contentDir);
    const book = findBook(catalog, subscription.bookId);

    await ctx.reply(
      [
        "Готово. Книга добавлена в занятия.",
        "",
        `Книга: ${book?.titleRu ?? subscription.bookId}`,
        `Темп: ${paceLabels[subscription.pace]}`,
        `Когда присылать: каждый день в ${formatHour(subscription.dailyHour)}`,
        `Режим: ${modeLabels[subscription.mode]}`,
        "",
        "Что дальше: нажми «Следующая страница», чтобы получить первую страницу сейчас, или вернись в меню."
      ].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("Следующая страница", `next:${bookId}`)],
        [Markup.button.callback("Мои книги", "mybooks"), Markup.button.callback("Меню", "menu")]
      ])
    );
  });

  bot.action(/^mark:([^:]+):(learned|hard|repeat)$/, async (ctx) => {
    const [, bookId, feedback] = ctx.match;
    const subscription = await store.recordFeedback(ctx.chat!.id, bookId, feedback as LessonFeedback);
    await ctx.answerCbQuery("Сохранил");

    if (!subscription) {
      await ctx.reply("Не нашел занятие по этой книге. Открой «Мои книги».");
      return;
    }

    await ctx.reply(feedbackResultText(subscription, feedback as LessonFeedback), feedbackResultKeyboard(bookId));
  });

  bot.action(/^check:(.+)$/, async (ctx) => {
    const bookId = ctx.match[1];
    await ctx.answerCbQuery();
    await sendSelfCheck(bot, config, store, ctx.chat!.id, bookId);
  });

  bot.action(/^show:([^:]+):(\d+)$/, async (ctx) => {
    const [, bookId, rawIndex] = ctx.match;
    await ctx.answerCbQuery();
    await showChunk(bot, config, ctx.chat!.id, bookId, Number(rawIndex));
  });

  bot.action(/^time:(\d+)$/, async (ctx) => {
    const hour = Number(ctx.match[1]);
    const subscription = await store.setDailyHour(ctx.chat!.id, hour);
    await ctx.answerCbQuery();

    if (!subscription) {
      await ctx.reply("Сначала выбери книгу через «Добавить книгу».");
      return;
    }

    await ctx.reply(
      [`Готово.`, `По текущей книге задание будет приходить каждый день в ${formatHour(hour)}.`, "", "Расписание можно открыть из меню."].join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("Расписание", "schedule"), Markup.button.callback("Меню", "menu")]])
    );
  });

  bot.action(/^mode:(read_listen|read|listen|review)$/, async (ctx) => {
    const mode = ctx.match[1] as StudyMode;
    const subscription = await store.setMode(ctx.chat!.id, mode);
    await ctx.answerCbQuery();

    if (!subscription) {
      await ctx.reply("Сначала выбери книгу через «Добавить книгу».");
      return;
    }

    await ctx.reply(
      `Готово. Режим текущей книги: ${modeLabels[mode]}.`,
      Markup.inlineKeyboard([[Markup.button.callback("Настройки", "settings"), Markup.button.callback("Меню", "menu")]])
    );
  });

  bot.action(/^pause:(1|3|forever|resume)$/, async (ctx) => {
    const action = ctx.match[1];
    const subscription =
      action === "resume"
        ? await store.resume(ctx.chat!.id)
        : action === "forever"
          ? await store.pause(ctx.chat!.id)
          : await store.pause(ctx.chat!.id, Number(action));

    await ctx.answerCbQuery();

    if (!subscription) {
      await ctx.reply("Сначала выбери книгу через «Добавить книгу».");
      return;
    }

    await ctx.reply(pauseResultText(action), Markup.inlineKeyboard([[Markup.button.callback("Мои книги", "mybooks"), Markup.button.callback("Меню", "menu")]]));
  });

  bot.action(/^pausebook:([^:]+)$/, async (ctx) => {
    const bookId = ctx.match[1];
    await store.pauseBook(ctx.chat!.id, bookId);
    await ctx.answerCbQuery("Поставил на паузу");
    await ctx.reply("Книга поставлена на паузу. Теперь можно добавить другую книгу.", Markup.inlineKeyboard([[Markup.button.callback("Добавить книгу", "books"), Markup.button.callback("Мои книги", "mybooks")]]));
  });

  bot.action(/^resume:([^:]+)$/, async (ctx) => {
    const bookId = ctx.match[1];
    const activeCount = (await activeSubscriptions(store, ctx.chat!.id)).length;
    const existing = await store.getSubscription(ctx.chat!.id, bookId);
    await ctx.answerCbQuery();

    if (!existing) {
      await ctx.reply("Не нашел эту книгу в твоих занятиях.");
      return;
    }

    if (!existing.active && activeCount >= maxActiveBooks) {
      await showBookLimit(ctx, config, store, bookId);
      return;
    }

    const subscription = await store.resumeBook(ctx.chat!.id, bookId);
    if (subscription) await showBookPanel(ctx, config, subscription);
  });

  return bot;
}

async function showMainMenu(ctx: Context, config: AppConfig, store: JsonStore): Promise<void> {
  const catalog = await readCatalog(config.contentDir);
  const subscriptions = await store.listSubscriptions(ctx.chat!.id);
  const active = subscriptions.filter((subscription) => subscription.active);

  if (subscriptions.length === 0) {
    await ctx.reply(
      [
        "NurTech Hifz",
        "",
        "Я буду вести тебя по матнам: давать страницу, аудио, повторения и прогресс.",
        "",
        "Начни с одной книги. Одновременно можно вести максимум две, чтобы не запутаться."
      ].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.webApp("Открыть кабинет", `${config.publicUrl}/app`)],
        [Markup.button.callback("Выбрать книгу", "books")]
      ])
    );
    return;
  }

  const lines = ["Главное меню", ""];
  if (active.length === 0) {
    lines.push("Сейчас нет активных книг. Верни одну книгу из паузы или добавь новую.");
  } else {
    lines.push("Активные книги:");
    for (const subscription of active) {
      const book = findBook(catalog, subscription.bookId);
      if (!book) continue;
      lines.push(`- ${book.titleRu}: ${Math.min(subscription.nextChunkIndex, book.chunks.length)}/${book.chunks.length}, ${formatHour(subscription.dailyHour)}`);
    }
    lines.push("", "Что хочешь сделать сейчас?");
  }

  await ctx.reply(lines.join("\n"), mainKeyboard(active.length < maxActiveBooks, config.publicUrl));
}

async function showCabinetLink(ctx: Context, config: AppConfig): Promise<void> {
  await ctx.reply(
    [
      "Открой личный кабинет.",
      "",
      "Там видно активные книги, следующую страницу, расписание повторений, прогресс и настройки."
    ].join("\n"),
    Markup.inlineKeyboard([[Markup.button.webApp("Открыть кабинет", `${config.publicUrl}/app`)]])
  );
}

async function showBooks(ctx: Context, config: AppConfig, store: JsonStore): Promise<void> {
  const catalog = await readCatalog(config.contentDir);
  const subscriptions = await store.listSubscriptions(ctx.chat!.id);
  const active = subscriptions.filter((subscription) => subscription.active);

  if (active.length >= maxActiveBooks) {
    await showBookLimit(ctx, config, store);
    return;
  }

  const existingIds = new Set(subscriptions.map((subscription) => subscription.bookId));
  const keyboard = catalog.books.map((book) => {
    const label = existingIds.has(book.id)
      ? `Перейти к занятиям: ${book.titleRu}`
      : `${book.titleRu} (${book.chunks.length} стр.)`;
    return [Markup.button.callback(label, existingIds.has(book.id) ? `open:${book.id}` : `book:${book.id}`)];
  });
  keyboard.push([Markup.button.callback("Меню", "menu")]);

  await ctx.reply(
    [
      "Выбери книгу для заучивания.",
      "",
      `Активно сейчас: ${active.length}/${maxActiveBooks}.`,
      "Лучше начать с одной книги. Вторую добавляй только если реально успеваешь."
    ].join("\n"),
    Markup.inlineKeyboard(keyboard)
  );
}

async function showMyBooks(ctx: Context, config: AppConfig, store: JsonStore): Promise<void> {
  const catalog = await readCatalog(config.contentDir);
  const subscriptions = await store.listSubscriptions(ctx.chat!.id);

  if (subscriptions.length === 0) {
    await ctx.reply("Пока нет книг в занятиях.", Markup.inlineKeyboard([[Markup.button.callback("Выбрать книгу", "books")]]));
    return;
  }

  const lines = ["Мои книги", ""];
  const keyboard = [];

  for (const subscription of subscriptions) {
    const book = findBook(catalog, subscription.bookId);
    if (!book) continue;
    const status = subscription.active ? pauseStatus(subscription) : "на паузе, задания не приходят";
    lines.push(
      `${book.titleRu}`,
      `Статус: ${status}`,
      `Прогресс: ${Math.min(subscription.nextChunkIndex, book.chunks.length)}/${book.chunks.length}`,
      `Задание: каждый день в ${formatHour(subscription.dailyHour)}`,
      ""
    );
    keyboard.push([Markup.button.callback(subscription.active ? `Перейти к занятиям: ${book.titleRu}` : `Снова учить: ${book.titleRu}`, subscription.active ? `open:${book.id}` : `resume:${book.id}`)]);
  }

  if (subscriptions.filter((subscription) => subscription.active).length < maxActiveBooks) {
    keyboard.push([Markup.button.callback("Добавить книгу", "books")]);
  }
  keyboard.push([Markup.button.callback("Расписание", "schedule"), Markup.button.callback("Меню", "menu")]);

  await ctx.reply(lines.join("\n"), Markup.inlineKeyboard(keyboard));
}

async function showBookPanel(ctx: Context, config: AppConfig, subscription: Subscription): Promise<void> {
  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, subscription.bookId);
  await ctx.reply(
    [
      "Книга выбрана",
      "",
      subscriptionSummary(book, subscription),
      "",
      "Здесь можно сразу получить следующую страницу, посмотреть расписание или поставить книгу на паузу."
    ].join("\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback("Следующая страница", `next:${subscription.bookId}`)],
      [Markup.button.callback("Расписание", "schedule"), Markup.button.callback("Настройки", "settings")],
      [Markup.button.callback(subscription.active ? "Поставить на паузу" : "Снова учить эту книгу", subscription.active ? `pausebook:${subscription.bookId}` : `resume:${subscription.bookId}`)],
      [Markup.button.callback("Мои книги", "mybooks"), Markup.button.callback("Меню", "menu")]
    ])
  );
}

async function showProgress(ctx: Context, config: AppConfig, store: JsonStore): Promise<void> {
  const catalog = await readCatalog(config.contentDir);
  const subscriptions = await store.listSubscriptions(ctx.chat!.id);

  if (subscriptions.length === 0) {
    await ctx.reply("Пока нет занятий. Нажми «Выбрать книгу».", Markup.inlineKeyboard([[Markup.button.callback("Выбрать книгу", "books")]]));
    return;
  }

  const lines = ["Прогресс", ""];
  const buttons = [];

  for (const subscription of subscriptions) {
    const book = findBook(catalog, subscription.bookId);
    if (!book) continue;

    const sent = Math.min(subscription.nextChunkIndex, book.chunks.length);
    const learned = subscription.completedChunkIndexes.length;
    const dueReviews = subscription.reviewQueue.filter((item) => item.dueDate <= todayKey()).length;
    const percent = Math.round((sent / book.chunks.length) * 100);

    lines.push(
      `${book.titleRu}`,
      `${sent}/${book.chunks.length} страниц (${percent}%). Выучено: ${learned}. Повторений сейчас: ${dueReviews}.`,
      `Темп: ${paceLabels[subscription.pace]}. Время: ${formatHour(subscription.dailyHour)}. Режим: ${modeLabels[subscription.mode]}.`,
      `Статус: ${subscription.active ? pauseStatus(subscription) : "на паузе"}.`,
      ""
    );
    buttons.push([Markup.button.callback(`Перейти к занятиям: ${book.titleRu}`, `open:${book.id}`)]);
  }

  buttons.push([Markup.button.callback("Расписание", "schedule"), Markup.button.callback("Меню", "menu")]);
  await ctx.reply(lines.join("\n"), Markup.inlineKeyboard(buttons));
}

async function showSchedule(ctx: Context, config: AppConfig, store: JsonStore): Promise<void> {
  const catalog = await readCatalog(config.contentDir);
  const subscriptions = await store.listSubscriptions(ctx.chat!.id);
  const active = subscriptions.filter((subscription) => subscription.active);

  if (subscriptions.length === 0) {
    await ctx.reply("Расписания пока нет. Сначала выбери книгу.", Markup.inlineKeyboard([[Markup.button.callback("Выбрать книгу", "books")]]));
    return;
  }

  const lines = ["Расписание", ""];
  if (active.length > 0) {
    lines.push("Ежедневные задания:");
    for (const subscription of active) {
      const book = findBook(catalog, subscription.bookId);
      if (!book) continue;
      const status = pauseStatus(subscription);
      const delivery = status === "учишь сейчас" ? `каждый день в ${formatHour(subscription.dailyHour)}` : status;
      lines.push(`- ${book.titleRu}: ${delivery}, ${paceLabels[subscription.pace]}, ${modeLabels[subscription.mode]}`);
    }
  } else {
    lines.push("Ежедневных заданий нет: все книги на паузе.");
  }

  lines.push("", "Ближайшие повторения:");
  const reviewLines = upcomingReviewLines(catalog.books, subscriptions);
  lines.push(...(reviewLines.length > 0 ? reviewLines : ["Пока ничего не стоит в повторении."]));
  lines.push("", "После кнопки «Выучил» страница попадает в повторение. Здесь всегда можно посмотреть, когда она вернется.");

  await ctx.reply(
    lines.join("\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback("Мои книги", "mybooks"), Markup.button.callback("Настройки", "settings")],
      [Markup.button.callback("Меню", "menu")]
    ])
  );
}

async function showSettings(ctx: Context, config: AppConfig, store: JsonStore): Promise<void> {
  const subscription = await store.getActiveSubscription(ctx.chat!.id);
  if (!subscription) {
    await ctx.reply("Сначала выбери книгу.", Markup.inlineKeyboard([[Markup.button.callback("Выбрать книгу", "books")]]));
    return;
  }

  const catalog = await readCatalog(config.contentDir);
  const book = findBook(catalog, subscription.bookId);
  await ctx.reply(
    [
      "Настройки текущей книги",
      "",
      subscriptionSummary(book, subscription),
      "",
      "Важно: время и режим меняются для выбранной книги. Если книг две, открой нужную через «Мои книги»."
    ].join("\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback("Изменить время", "pick_time"), Markup.button.callback("Изменить режим", "pick_mode")],
      [Markup.button.callback("Поставить на паузу", "pick_pause"), Markup.button.callback("Расписание", "schedule")],
      [Markup.button.callback("Мои книги", "mybooks"), Markup.button.callback("Меню", "menu")]
    ])
  );
}

async function showTimePicker(ctx: Context, store: JsonStore): Promise<void> {
  const subscription = await store.getActiveSubscription(ctx.chat!.id);
  if (!subscription) {
    await ctx.reply("Сначала выбери книгу через «Добавить книгу».");
    return;
  }

  await ctx.reply(
    [`Сейчас задание приходит в ${formatHour(subscription.dailyHour)}.`, "Выбери новое время для текущей книги:"].join("\n"),
    Markup.inlineKeyboard([
      [6, 8, 10].map((hour) => Markup.button.callback(formatHour(hour), `time:${hour}`)),
      [13, 16, 20].map((hour) => Markup.button.callback(formatHour(hour), `time:${hour}`)),
      [Markup.button.callback("22:00", "time:22")],
      [Markup.button.callback("Назад", "settings")]
    ])
  );
}

async function showModePicker(ctx: Context, store: JsonStore): Promise<void> {
  const subscription = await store.getActiveSubscription(ctx.chat!.id);
  if (!subscription) {
    await ctx.reply("Сначала выбери книгу через «Добавить книгу».");
    return;
  }

  await ctx.reply(
    `Сейчас режим: ${modeLabels[subscription.mode]}. Выбери новый режим для текущей книги:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Текст и аудио", "mode:read_listen")],
      [Markup.button.callback("Только текст", "mode:read")],
      [Markup.button.callback("Только аудио", "mode:listen")],
      [Markup.button.callback("Только повторение", "mode:review")],
      [Markup.button.callback("Назад", "settings")]
    ])
  );
}

async function showPausePicker(ctx: Context, store: JsonStore): Promise<void> {
  const subscription = await store.getActiveSubscription(ctx.chat!.id);
  if (!subscription) {
    await ctx.reply("Сначала выбери книгу через «Добавить книгу».");
    return;
  }

  await ctx.reply(
    "Что сделать с текущей книгой?",
    Markup.inlineKeyboard([
      [Markup.button.callback("Пауза на 1 день", "pause:1")],
      [Markup.button.callback("Пауза на 3 дня", "pause:3")],
      [Markup.button.callback("Пауза без срока", "pause:forever")],
      [Markup.button.callback("Продолжить", "pause:resume")],
      [Markup.button.callback("Назад", "settings")]
    ])
  );
}

async function showBookLimit(ctx: Context, config: AppConfig, store: JsonStore, requestedBookId?: string): Promise<void> {
  const catalog = await readCatalog(config.contentDir);
  const active = await activeSubscriptions(store, ctx.chat!.id);
  const requested = requestedBookId ? findBook(catalog, requestedBookId) : undefined;
  const lines = [
    "Можно учить максимум 2 книги одновременно.",
    "",
    requested ? `Чтобы добавить «${requested.titleRu}», поставь одну активную книгу на паузу.` : "Чтобы добавить новую книгу, поставь одну активную книгу на паузу.",
    "",
    "Сейчас активны:"
  ];
  const keyboard = [];

  for (const subscription of active) {
    const book = findBook(catalog, subscription.bookId);
    if (!book) continue;
    lines.push(`- ${book.titleRu}`);
    keyboard.push([Markup.button.callback(`Пауза: ${book.titleRu}`, `pausebook:${book.id}`)]);
  }

  keyboard.push([Markup.button.callback("Мои книги", "mybooks"), Markup.button.callback("Меню", "menu")]);
  await ctx.reply(lines.join("\n"), Markup.inlineKeyboard(keyboard));
}

function mainKeyboard(canAddBook: boolean, publicUrl: string) {
  const rows = [
    [Markup.button.webApp("Кабинет", `${publicUrl}/app`)],
    [Markup.button.callback("Задание на сегодня", "today"), Markup.button.callback("Следующая страница", "next")],
    [Markup.button.callback("Мои книги", "mybooks"), Markup.button.callback("Расписание", "schedule")],
    [Markup.button.callback("Прогресс", "progress"), Markup.button.callback("Настройки", "settings")]
  ];
  if (canAddBook) rows.push([Markup.button.callback("Добавить книгу", "books")]);
  return Markup.inlineKeyboard(rows);
}

function feedbackResultKeyboard(bookId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Следующая страница", `next:${bookId}`)],
    [Markup.button.callback("На сегодня хватит", "done_today"), Markup.button.callback("Расписание", "schedule")],
    [Markup.button.callback("Мои книги", "mybooks"), Markup.button.callback("Меню", "menu")]
  ]);
}

function feedbackResultText(subscription: Subscription, feedback: LessonFeedback): string {
  const lines = [`Отметка сохранена: ${feedbackLabels[feedback]}.`, ""];

  if (subscription.lastLessonChunkIndexes.length > 0) {
    lines.push(`Страницы: ${subscription.lastLessonChunkIndexes.map((index) => index + 1).join(", ")}.`);
  }

  const scheduled = subscription.reviewQueue.filter((item) => subscription.lastLessonChunkIndexes.includes(item.chunkIndex));
  if (scheduled.length > 0) {
    lines.push("", "Эти страницы вернутся в повторение:");
    for (const line of groupedReviewLines(scheduled).slice(0, 6)) lines.push(line);
  } else if (feedback === "learned") {
    lines.push("", "Повторения для этой страницы уже стояли в расписании.");
  }

  lines.push("", "Что дальше?");
  return lines.join("\n");
}

function pauseResultText(action: string): string {
  if (action === "resume") return "Продолжаем занятия. Следующее задание придет по расписанию, или нажми «Следующая страница».";
  if (action === "forever") return "Поставил текущую книгу на паузу. Ежедневные задания по ней не будут приходить. Снова начать можно через «Мои книги».";
  return `Поставил паузу на ${action} дн. Снова начать раньше можно через «Настройки».`;
}

function subscriptionSummary(book: CatalogBook | undefined, subscription: Subscription): string {
  return [
    `Книга: ${book?.titleRu ?? subscription.bookId}`,
    `Статус: ${subscription.active ? pauseStatus(subscription) : "на паузе, задания не приходят"}`,
    `Прогресс: ${Math.min(subscription.nextChunkIndex, book?.chunks.length ?? subscription.nextChunkIndex)}/${book?.chunks.length ?? "?"} страниц`,
    `Темп: ${paceLabels[subscription.pace]}`,
    `Задание: каждый день в ${formatHour(subscription.dailyHour)}`,
    `Режим: ${modeLabels[subscription.mode]}`
  ].join("\n");
}

function upcomingReviewLines(books: CatalogBook[], subscriptions: Subscription[]): string[] {
  const byBook = new Map(books.map((book) => [book.id, book]));
  const items = subscriptions.flatMap((subscription) =>
    subscription.reviewQueue.map((item) => ({ ...item, bookId: subscription.bookId }))
  );

  return groupedReviewLines(items)
    .slice(0, 10)
    .map((line) => {
      const [date, rest] = line.split(": ");
      const [bookId, pages] = rest.split("|");
      const book = byBook.get(bookId);
      return `${date}: ${book?.titleRu ?? bookId}, стр. ${pages}`;
    });
}

function groupedReviewLines(items: Array<{ dueDate: string; chunkIndex: number; bookId?: string }>): string[] {
  const grouped = new Map<string, number[]>();
  for (const item of items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.chunkIndex - b.chunkIndex)) {
    const key = item.bookId ? `${item.dueDate}: ${item.bookId}` : item.dueDate;
    grouped.set(key, [...(grouped.get(key) ?? []), item.chunkIndex + 1]);
  }

  return [...grouped.entries()].map(([key, pages]) => {
    if (key.includes(": ")) {
      const [date, bookId] = key.split(": ");
      return `${formatDateKey(date)}: ${bookId}|${pages.join(", ")}`;
    }
    return `${formatDateKey(key)}: стр. ${pages.join(", ")}`;
  });
}

async function activeSubscriptions(store: JsonStore, chatId: number): Promise<Subscription[]> {
  return (await store.listSubscriptions(chatId)).filter((subscription) => subscription.active);
}

function pauseStatus(subscription: Subscription): string {
  if (subscription.pausedUntil && new Date(subscription.pausedUntil) > new Date()) {
    return `пауза до ${formatDate(subscription.pausedUntil)}, задания временно не приходят`;
  }
  return "учишь сейчас";
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(new Date(value));
}

function formatDateKey(value: string): string {
  return formatDate(`${value}T12:00:00.000Z`);
}
