(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    bootTelegramChrome();
  }

  var params = new URLSearchParams(window.location.search);
  var initData = (tg && tg.initData) || params.get("tgInitData") || "";
  var state = null;
  var activeView = "todayView";
  var selectedBookId = null;
  var readerPageIndex = 0;
  var readMode = "library";
  var readerDisplayMode = localStorage.getItem("hifzReaderDisplayMode") || "pdf";
  var arabicFontScale = clamp(Number(localStorage.getItem("hifzArabicFontScale") || 1), 0.82, 1.45);
  var lesson = null;
  var completion = null;
  var pending = false;
  var toastTimer = null;
  var lastScrollY = window.scrollY || 0;
  var textCache = {};

  var paceLabels = { slow: "1 стр./день", normal: "2 стр./день", fast: "3 стр./день" };
  var paceValues = { slow: 1, normal: 2, fast: 3 };
  var feedbackLabels = { learned: "Выучил", hard: "Сложно", repeat: "Повторить завтра" };
  var recommendedBookIds = ["al-usul-ath-thalatha", "al-qawaid-al-arbaa", "nawaqid-al-islam"];

  document.addEventListener("dblclick", preventZoom, { passive: false });
  document.addEventListener("gesturestart", preventZoom, { passive: false });
  window.visualViewport && window.visualViewport.addEventListener("resize", syncVisualViewport, { passive: true });
  window.visualViewport && window.visualViewport.addEventListener("scroll", syncVisualViewport, { passive: true });
  window.addEventListener("resize", syncVisualViewport, { passive: true });
  window.addEventListener("scroll", syncTopBarVisibility, { passive: true });
  syncViewportVars();
  syncArabicFontScale();

  document.addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button || button.disabled) return;

    if (button.dataset.view) {
      event.preventDefault();
      haptic("select");
      if (button.dataset.view === "readView") readMode = "library";
      switchView(button.dataset.view);
      return;
    }

    if (!button.dataset.action) return;
    event.preventDefault();
    haptic(button.dataset.action === "reader-page" ? "select" : "light");
    runAction(button).catch(function (error) {
      haptic("error");
      toast(error.message || "Не получилось выполнить действие.");
    });
  });

  loadState().catch(showAuthError);

  async function runAction(button) {
    if (pending && button.dataset.action !== "refresh") return;
    if (!state && button.dataset.action !== "refresh") return;

    var action = button.dataset.action;
    var bookId = button.dataset.bookId;
    var pageIndex = Number(button.dataset.pageIndex || 0);

    if (action === "refresh") return loadState({ force: true });
    if (action === "continue") return continueStudy();
    if (action === "open-reader-current") return activeSubs().length ? openReader(currentBookId(), currentPageIndex()) : showReaderLibrary();
    if (action === "reader-library") return showReaderLibrary();
    if (action === "close-reader") return showReaderLibrary();
    if (action === "read-book") return openReader(bookId, pageIndex);
    if (action === "open-pdf") return openFullPdf(bookId);
    if (action === "reader-display") return setReaderDisplayMode(button.dataset.mode);
    if (action === "reader-font") return setArabicFontScale(Number(button.dataset.delta || 0));
    if (action === "reader-move") return moveReader(Number(button.dataset.delta || 0));
    if (action === "reader-page") return openReader(selectedBookId, pageIndex);
    if (action === "study-reader") return studyReaderPage();
    if (action === "study-page") return studySpecificPage(bookId, pageIndex);
    if (action === "next-page") return openNextPage(bookId);
    if (action === "feedback") return sendFeedback(bookId, button.dataset.feedback);
    if (action === "start-and-open") return startAndOpenBook(bookId, button.dataset.pace || "slow");
    if (action === "start-book") return startBook(bookId, button.dataset.pace || "slow");
    if (action === "pause-book") return pauseBook(bookId);
    if (action === "resume-book") return resumeBook(bookId);
    if (action === "remove-book") return removeBook(bookId);
    if (action === "reset-book") return resetBook(bookId);
    if (action === "undo-feedback") return undoFeedback(bookId);
    if (action === "undo-lesson") return undoLastLesson(bookId);
    if (action === "cancel-review") return cancelReview(bookId, pageIndex);
    if (action === "weekly-goal") return updateWeeklyGoal(Number(button.dataset.goal));
  }

  async function api(path, options) {
    options = options || {};
    setPending(true);
    try {
      var res = await fetch("/api/app" + path, {
        method: options.method || "GET",
        headers: { "content-type": "application/json", "x-telegram-init-data": initData },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка сервера");
      return data;
    } finally {
      setPending(false);
    }
  }

  async function loadState(options) {
    if (!initData) {
      showAuthError(new Error("Открой кабинет из Telegram-бота."));
      return;
    }

    var data = await api("/state");
    state = data;
    document.getElementById("authView").classList.add("hidden");
    document.querySelector(".bottom-nav").classList.remove("hidden");
    document.getElementById("userLabel").textContent = (state.user && state.user.firstName) || "личный кабинет";

    if (!selectedBookId || !getBook(selectedBookId)) selectedBookId = currentBookId();
    renderAll();
    updateBackButton();
    if (options && options.force) toast("Обновлено.");
  }

  function renderAll() {
    renderToday();
    renderStudy();
    renderReaderList();
    renderReader();
    renderBooks();
    renderProgress();
  }

  function renderToday() {
    var active = activeSubs();
    var due = dueReviewItems();
    var newPages = active.reduce(function (sum, sub) { return sum + paceValue(sub.pace); }, 0);
    setText("mNew", newPages);
    setText("mReviews", due.length);
    setText("mGoal", state.activity.weeklyGoal.learned + "/" + state.activity.weeklyGoal.pages);
    setText("todayStatus", state.activity.today.studied ? "Сегодня отмечено" : "Сегодня");
    setText("todayLead", active.length
      ? "Здесь только сегодняшние действия. Лишнюю книгу можно убрать во вкладке «Книги»."
      : "Начни с одной книги. Я буду вести тебя по странице в день: текст, аудио, отметка результата и повторения.");
    var continueButton = document.querySelector('[data-action="continue"]');
    var readerButton = document.querySelector('[data-action="open-reader-current"]');
    if (continueButton) continueButton.textContent = active.length ? "Продолжить учебу" : "Выбрать первую книгу";
    if (readerButton) readerButton.textContent = active.length ? "Читать книгу" : "Открыть библиотеку";

    var noticeBox = document.getElementById("todayNotice");
    noticeBox.innerHTML = "";
    if (state.activity.today.shouldRemind) {
      noticeBox.appendChild(notice(state.activity.today.text));
    }

    var plan = byId("todayPlan");
    clear(plan);
    if (!active.length) {
      plan.appendChild(onboardingCard());
      plan.appendChild(howItWorksCard());
    } else {
      active.forEach(function (sub) {
        var nextPage = sub.nextPreview ? sub.nextPreview.index + 1 : null;
        plan.appendChild(taskCard({
          bookId: sub.bookId,
          kind: "Учить сегодня",
          title: sub.titleRu,
          text: nextPage ? "Откроется страница " + nextPage + " из " + sub.totalChunks + ". Это следующая новая страница этой книги." : "Новые страницы этой книги закончились.",
          tags: [paceLabels[sub.pace], "в " + pad(sub.dailyHour) + ":00"],
          actions: [
            action(nextPage ? "Открыть страницу " + nextPage : "Открыть книгу", "primary", "next-page", { bookId: sub.bookId }),
            action("Читать весь текст", "secondary", "read-book", { bookId: sub.bookId, pageIndex: Math.max(0, sub.nextChunkIndex) })
          ]
        }));
      });
    }

      due.slice(0, 3).forEach(function (item) {
      plan.appendChild(taskCard({
        bookId: item.bookId,
        kind: "Повторить",
        title: item.titleRu,
        text: "Повтори страницу " + item.page + ". Ты уже открывал её раньше, сейчас нужно закрепить.",
        tags: [dateLabel(item.dueDate)],
        actions: [
          action("Повторить страницу " + item.page, "secondary", "study-page", { bookId: item.bookId, pageIndex: Math.max(0, item.page - 1) }),
          action("Убрать повторение", "ghost", "cancel-review", { bookId: item.bookId, pageIndex: Math.max(0, item.page - 1) })
        ]
      }));
    });

    var progress = byId("todayProgress");
    clear(progress);
    if (!active.length) progress.appendChild(notice("Активных книг пока нет."));
    active.forEach(function (sub) { progress.appendChild(bookProgressCard(sub)); });
  }

  function renderStudy() {
    var area = byId("lessonArea");
    clear(area);

    if (lesson) {
      area.appendChild(lessonMedia(lesson));
      area.appendChild(lessonPanel(lesson));
      return;
    }

    if (completion) {
      area.appendChild(completionPanel(completion));
      return;
    }

    var active = activeSubs();
    if (!active.length) {
      area.appendChild(emptyAction("Занятие ещё не настроено", "Добавь одну книгу. После этого здесь будет конкретная страница для учебы.", "Добавить книгу", "booksView"));
      area.appendChild(stepsPanel());
      return;
    }

    var sub = active[0];
    area.appendChild(taskCard({
      bookId: sub.bookId,
      kind: "Готово к старту",
      title: sub.titleRu,
      text: nextLabel(sub),
      tags: [paceLabels[sub.pace], sub.progressPercent + "% пройдено"],
      actions: [
        action("Открыть страницу для учебы", "primary", "next-page", { bookId: sub.bookId }),
        action("Читать весь текст", "secondary", "read-book", { bookId: sub.bookId, pageIndex: Math.max(0, sub.nextChunkIndex) })
      ]
    }));
    area.appendChild(stepsPanel());
  }

  function onboardingCard() {
    var card = div("item-card onboarding-card");
    card.innerHTML =
      '<div class="item-title"><b>Начать за 1 минуту</b><span>Выбери один короткий матн. Оптимально начать с одной страницы в день, чтобы не запутаться.</span></div>' +
      '<div class="actions"></div>';
    var actions = card.querySelector(".actions");
    recommendedBooks().forEach(function (book, index) {
      actions.appendChild(makeButton(action(index === 0 ? "Начать: " + book.titleRu : book.titleRu, index === 0 ? "primary" : "secondary", "start-and-open", {
        bookId: book.id,
        pace: "slow"
      })));
    });
    actions.appendChild(viewButton("Вся библиотека", "ghost", "booksView"));
    return card;
  }

  function howItWorksCard() {
    var card = div("item-card quiet-card");
    card.innerHTML =
      '<div class="item-title"><b>Как будет проходить занятие</b><span>Каждый день: страница текстом, аудио, твоя отметка результата. Если сложно — страница попадёт в отдельный список для повторения.</span></div>';
    return card;
  }

  function lessonMedia(item) {
    var card = div("section-card");
    if (readerDisplayMode === "text" && item.textUrl) {
      var textBox = div("reader-text-page lesson-text-page");
      textBox.appendChild(textLoading());
      card.appendChild(textBox);
      loadArabicText(item.textUrl, textBox, item.titleRu + ": стр. " + item.page);
    } else {
      card.innerHTML = '<div class="page-media"><img src="' + esc(item.imageUrl) + '" alt=""></div>';
    }
    var mode = div("reader-mode-switch lesson-mode-switch");
    mode.appendChild(makeButton(action("PDF", readerDisplayMode === "pdf" ? "primary small" : "secondary small", "reader-display", { mode: "pdf" })));
    mode.appendChild(makeButton(action("Текст", readerDisplayMode === "text" ? "primary small" : item.textUrl ? "secondary small" : "secondary small disabled", "reader-display", { mode: "text" })));
    card.appendChild(mode);
    if (readerDisplayMode === "text") card.appendChild(fontControls());
    appendAudio(card, item.audioUrl, item.audioScope === "book");
    return card;
  }

  function lessonPanel(item) {
    var card = div("section-card lesson-panel");
    card.innerHTML =
      '<div><span class="eyebrow">Занятие</span><h1 style="margin-top:10px">' + esc(item.titleRu) + '</h1>' +
      '<p>Сейчас ты учишь страницу ' + item.page + ' из ' + item.total + ' в этой книге. Если открыл случайно — можешь вернуться в «Книги» и сбросить прогресс.</p></div>';
    card.appendChild(stepsPanel());
    var actions = div("actions");
    actions.appendChild(makeButton(action("Отменить открытие страницы", "ghost", "undo-lesson", { bookId: item.bookId })));
    actions.appendChild(makeButton(action("Выучил", "primary", "feedback", { bookId: item.bookId, feedback: "learned" })));
    actions.appendChild(makeButton(action("Сложно", "warn", "feedback", { bookId: item.bookId, feedback: "hard" })));
    actions.appendChild(makeButton(action("Повторить завтра", "secondary", "feedback", { bookId: item.bookId, feedback: "repeat" })));
    card.appendChild(actions);
    return card;
  }

  function completionPanel(result) {
    var card = div("section-card lesson-panel");
    var pageText = result.page ? "В книге «" + result.title + "» ты отметил страницу " + result.page + ". " : "";
    var copy = {
      learned: {
        eyebrow: "Страница сохранена",
        title: "Отметил как выученную",
        text: pageText + "Эту же страницу нужно будет повторить завтра, через 3 дня, через 7 дней и через 14 дней.",
        primary: "Открыть следующую страницу этой книги"
      },
      hard: {
        eyebrow: "Добавил в слабые",
        title: "Повтори эту страницу ещё раз",
        text: pageText + "Я добавил её в слабые страницы. Это список страниц, которые нужно отдельно закрепить.",
        primary: "Повторить эту страницу"
      },
      repeat: {
        eyebrow: "Оставил на повтор",
        title: "Вернёмся к странице завтра",
        text: pageText + "Завтра она снова появится в плане как повторение этой же страницы.",
        primary: "Повторить сейчас"
      }
    }[result.feedback] || {
      eyebrow: "Отметка сохранена",
      title: feedbackLabels[result.feedback] || "Готово",
      text: pageText + "Результат сохранён.",
      primary: "Открыть следующую страницу"
    };

    card.innerHTML =
      '<div><span class="eyebrow strong">' + esc(copy.eyebrow) + '</span><h1 style="margin-top:10px">' + esc(copy.title) + '</h1>' +
      '<p>' + esc(copy.text) + '</p></div>';
    var actions = div("actions");
    if (result.feedback === "hard" || result.feedback === "repeat") {
      actions.appendChild(makeButton(action(copy.primary, "primary", "study-page", { bookId: result.bookId, pageIndex: result.pageIndex })));
      actions.appendChild(makeButton(action("Всё равно дальше", "secondary", "next-page", { bookId: result.bookId })));
    } else {
      actions.appendChild(makeButton(action(copy.primary, "primary", "next-page", { bookId: result.bookId })));
    }
    actions.appendChild(viewButton("План на сегодня", "secondary", "todayView"));
    actions.appendChild(viewButton("Прогресс", "ghost", "progressView"));
    actions.appendChild(makeButton(action("Отменить отметку", "ghost", "undo-feedback", { bookId: result.bookId })));
    card.appendChild(actions);
    return card;
  }

  function renderReaderList() {
    var list = byId("readBooks");
    clear(list);
    list.appendChild(notice("Здесь библиотека для чтения. Чтобы заниматься по расписанию, нажми «Учить страницу» внутри книги."));
    booksOrderedForReading().forEach(function (book) {
      var sub = getSubscription(book.id);
      var actions = [action("Читать полностью", selectedBookId === book.id && readMode === "reader" ? "primary" : "secondary", "read-book", { bookId: book.id, pageIndex: sub ? Math.max(0, sub.nextChunkIndex) : 0 })];
      if (book.fullPdfUrl) actions.push(action("PDF целиком", "ghost", "open-pdf", { bookId: book.id }));
      list.appendChild(taskCard({
        kind: book.totalChunks + " стр.",
        title: book.titleRu,
        text: sub ? (sub.active ? "ты учишь эту книгу каждый день" : "книга сохранена, но задания не приходят") : "можно просто читать, без добавления в занятия",
        coverUrl: book.coverUrl,
        tags: sub ? [sub.progressPercent + "% пройдено"] : [],
        actions: actions
      }));
    });
  }

  function renderReader() {
    updateReadModeClass();
    var box = byId("readerBox");
    clear(box);
    box.classList.toggle("has-font-controls", readerDisplayMode === "text");
    var book = getBook(selectedBookId || currentBookId());
    if (!book) {
      box.appendChild(notice("Выбери книгу для чтения."));
      return;
    }

    selectedBookId = book.id;
    readerPageIndex = clamp(readerPageIndex, 0, Math.max(0, book.pages.length - 1));
    var page = book.pages[readerPageIndex];
    var sub = getSubscription(book.id);

    var top = div("reader-top");
    top.innerHTML =
      '<div><span class="eyebrow">Чтение</span><h2 style="margin-top:8px">' + esc(book.titleRu) + '</h2>' +
      '<p>Страница ' + page.page + ' из ' + book.totalChunks + (page.sourcePageNumber ? ' · PDF стр. ' + page.sourcePageNumber : '') + '</p></div>' +
      '<span class="soft-pill">' + (sub && sub.active ? "в занятиях" : "только чтение") + '</span>';
    box.appendChild(top);
    var back = div("actions reader-library-action reader-toolbar");
    back.appendChild(makeButton(action("Закрыть", "secondary small", "close-reader", {})));
    back.appendChild(makeButton(action("Библиотека", "ghost small", "reader-library", {})));
    if (book.fullPdfUrl) back.appendChild(makeButton(action("PDF целиком", "ghost small", "open-pdf", { bookId: book.id })));
    box.appendChild(back);

    var mode = div("reader-mode-switch");
    mode.appendChild(makeButton(action("PDF", readerDisplayMode === "pdf" ? "primary small" : "secondary small", "reader-display", { mode: "pdf" })));
    mode.appendChild(makeButton(action("Текст страницы", readerDisplayMode === "text" ? "primary small" : page.textUrl ? "secondary small" : "secondary small disabled", "reader-display", { mode: "text" })));
    box.appendChild(mode);
    if (readerDisplayMode === "text") box.appendChild(fontControls());

    if (readerDisplayMode === "text") {
      var textMedia = div("reader-text-page");
      if (page.textUrl) {
        textMedia.appendChild(textLoading());
        loadArabicText(page.textUrl, textMedia, book.titleRu + ": стр. " + page.page);
      } else {
        textMedia.appendChild(textUnavailable());
      }
      box.appendChild(textMedia);
    } else {
      var media = div("reader-page");
      media.innerHTML = '<img src="' + esc(page.imageUrl) + '" alt="">';
      box.appendChild(media);
    }

    appendAudio(box, page.audioUrl || book.bookAudioUrl, !page.audioUrl && Boolean(book.bookAudioUrl));

    var actions = div("actions");
    actions.appendChild(makeButton(action("Назад", "secondary", "reader-move", { delta: -1 })));
    actions.appendChild(makeButton(action("Вперёд", "secondary", "reader-move", { delta: 1 })));
    actions.appendChild(makeButton(action("Учить эту страницу", "primary", "study-reader", {})));
    box.appendChild(actions);
    var pageHint = div("reader-hint");
    pageHint.textContent = "На телефоне страницы листаются кнопками «Назад» и «Вперёд».";
    box.appendChild(pageHint);

    var strip = div("page-strip");
    book.pages.forEach(function (item, index) {
      strip.appendChild(makeButton(action(String(item.page), index === readerPageIndex ? "page active" : "page", "reader-page", { pageIndex: index })));
    });
    box.appendChild(strip);
  }

  function renderBooks() {
    var active = activeSubs();
    var paused = state.subscriptions.filter(function (sub) { return !sub.active; });
    setText("activeLimit", active.length + "/" + state.maxActiveBooks);

    var activeBox = byId("activeBooks");
    var pausedBox = byId("pausedBooks");
    var catalogBox = byId("catalogBooks");
    clear(activeBox);
    clear(pausedBox);
    clear(catalogBox);

    if (!active.length) activeBox.appendChild(notice("Ни одна книга не приходит в ежедневный план."));
    active.forEach(function (sub) { activeBox.appendChild(manageBookCard(sub)); });

    if (!paused.length) pausedBox.appendChild(notice("Здесь появятся книги, которые убраны из ежедневного плана."));
    paused.forEach(function (sub) { pausedBox.appendChild(manageBookCard(sub)); });

    if (active.length >= state.maxActiveBooks) catalogBox.appendChild(limitHelpCard(active));
    state.books.forEach(function (book) {
      catalogBox.appendChild(catalogBookCard(book, active.length));
    });
  }

  function renderProgress() {
    var metrics = byId("progressMetrics");
    var goal = byId("weeklyGoal");
    var calendar = byId("habitCalendar");
    var reviews = byId("reviewsList");
    var weak = byId("weakList");
    var history = byId("historyList");
    clear(metrics);
    clear(goal);
    clear(calendar);
    clear(reviews);
    clear(weak);
    clear(history);

    var total = state.subscriptions.reduce(function (sum, sub) { return sum + sub.totalChunks; }, 0);
    var sent = state.subscriptions.reduce(function (sum, sub) { return sum + Math.min(sub.nextChunkIndex, sub.totalChunks); }, 0);
    var hard = state.subscriptions.reduce(function (sum, sub) { return sum + sub.hardCount; }, 0);
    metrics.appendChild(metric(Math.round(total ? sent / total * 100 : 0) + "%", "общий прогресс"));
    metrics.appendChild(metric(state.activity.weeklyGoal.learned + "/" + state.activity.weeklyGoal.pages, "цель недели"));
    metrics.appendChild(metric(hard, "сложные страницы"));

    goal.appendChild(metric(state.activity.weeklyGoal.learned + "/" + state.activity.weeklyGoal.pages, "выучено на этой неделе"));
    var goalActions = div("actions");
    [3, 5, 7, 10, 14].forEach(function (value) {
      goalActions.appendChild(makeButton(action(String(value), value === state.activity.weeklyGoal.pages ? "primary small" : "secondary small", "weekly-goal", { goal: value })));
    });
    goal.appendChild(goalActions);

    state.activity.calendar.forEach(function (day) {
      var el = div("habit-day" + (day.studied ? " done" : ""));
      el.textContent = String(day.label).split(" ")[0];
      calendar.appendChild(el);
    });

    var reviewItems = (state.schedule || []).filter(function (item) { return item.type === "review"; });
    if (!reviewItems.length) reviews.appendChild(notice("Повторений пока нет."));
    reviewItems.slice(0, 20).forEach(function (item) {
      reviews.appendChild(taskCard({
        bookId: item.bookId,
        kind: dateLabel(item.dueDate),
        title: item.titleRu,
        text: "Страница " + item.page + ". Можно повторить сейчас или убрать это повторение из очереди.",
        coverUrl: getBook(item.bookId) && getBook(item.bookId).coverUrl,
        actions: [
          action("Повторить", "secondary", "study-page", { bookId: item.bookId, pageIndex: Math.max(0, item.page - 1) }),
          action("Убрать повторение", "ghost", "cancel-review", { bookId: item.bookId, pageIndex: Math.max(0, item.page - 1) })
        ]
      }));
    });

    if (!state.activity.weakPages.length) weak.appendChild(notice("Слабые страницы появятся после отметки «Сложно»."));
    state.activity.weakPages.forEach(function (item) { weak.appendChild(weakCard(item)); });

    state.activity.history.forEach(function (day) { history.appendChild(historyRow(day)); });
  }

  function manageBookCard(sub) {
    var resetAction = sub.nextChunkIndex > 0 || sub.completedCount > 0 || sub.hardCount > 0
      ? [action("Начать заново", "secondary", "reset-book", { bookId: sub.bookId })]
      : [];
    var item = taskCard({
      kind: sub.active ? "учу сейчас" : "не учу",
      title: sub.titleRu,
      text: sub.active ? nextLabel(sub) : "Книга сохранена, но не приходит в ежедневный план.",
      coverUrl: getBook(sub.bookId) && getBook(sub.bookId).coverUrl,
      tags: [paceLabels[sub.pace], sub.progressPercent + "%", pad(sub.dailyHour) + ":00"],
      actions: [
        action("Читать весь текст", "secondary", "read-book", { bookId: sub.bookId, pageIndex: Math.max(0, sub.nextChunkIndex) }),
        sub.active
          ? action("Не присылать каждый день", "ghost", "pause-book", { bookId: sub.bookId })
          : action("Вернуть в занятия", "primary", "resume-book", { bookId: sub.bookId })
      ].concat(resetAction, [action("Убрать совсем", "danger", "remove-book", { bookId: sub.bookId })]),
      progress: sub.progressPercent
    });
    return item;
  }

  function catalogBookCard(book, activeCount) {
    var existing = getSubscription(book.id);
    var actions = [action("Читать весь текст", "secondary", "read-book", { bookId: book.id, pageIndex: existing ? Math.max(0, existing.nextChunkIndex) : 0 })];

    if (existing && existing.active) {
      actions.push(action("Открыть занятие", "primary", "next-page", { bookId: book.id }));
    } else if (existing) {
      actions.push(action("Вернуть в занятия", "primary", "resume-book", { bookId: book.id }));
    } else if (activeCount >= state.maxActiveBooks) {
      actions.push(action("Сначала поставь одну книгу на паузу", "ghost disabled", "noop", {}));
    } else {
      actions.push(action("Добавить 1 стр./день", "primary", "start-book", { bookId: book.id, pace: "slow" }));
      actions.push(action("2 стр./день", "secondary", "start-book", { bookId: book.id, pace: "normal" }));
    }

    return taskCard({
      kind: book.totalChunks + " стр.",
      title: book.titleRu,
      text: existing ? (existing.active ? "ты сейчас учишь эту книгу" : "книга сохранена, но ежедневные задания выключены") : "можно читать или добавить в ежедневные занятия",
      coverUrl: book.coverUrl,
      tags: existing ? [existing.progressPercent + "% пройдено"] : [],
      actions: actions
    });
  }

  function limitHelpCard(active) {
    var card = div("item-card limit-card");
    card.innerHTML =
      '<div class="item-title"><b>В ежедневном плане уже две книги</b><span>Чтобы добавить новую книгу и не путаться, поставь одну текущую книгу на паузу. Читать её всё равно можно.</span></div>' +
      '<div class="actions"></div>';
    var actions = card.querySelector(".actions");
    active.forEach(function (sub) {
      actions.appendChild(makeButton(action("Пауза: " + sub.titleRu, "secondary", "pause-book", { bookId: sub.bookId })));
    });
    return card;
  }

  function bookProgressCard(sub) {
    return taskCard({
      kind: sub.progressPercent + "%",
      title: sub.titleRu,
      text: Math.min(sub.nextChunkIndex, sub.totalChunks) + " из " + sub.totalChunks + " страниц пройдено",
      coverUrl: getBook(sub.bookId) && getBook(sub.bookId).coverUrl,
      tags: [paceLabels[sub.pace], sub.dueReviews + " повтор."],
      actions: [
        action("Продолжить", "primary", "next-page", { bookId: sub.bookId }),
        action("Читать", "secondary", "read-book", { bookId: sub.bookId, pageIndex: Math.max(0, sub.nextChunkIndex) })
      ],
      progress: sub.progressPercent
    });
  }

  function weakCard(item) {
    var book = getBook(item.bookId);
    var card = div("item-card weak-row");
    card.innerHTML =
      '<img src="' + esc(book && book.coverUrl ? book.coverUrl : item.imageUrl) + '" alt="Обложка: ' + esc(item.titleRu) + '">' +
      '<div><div class="item-title"><b>' + esc(item.titleRu) + ': стр. ' + item.page + '</b><span>Отмечалась сложной: ' + item.count + ' раз</span></div>' +
      '<div class="actions"></div></div>';
    card.querySelector(".actions").appendChild(makeButton(action("Открыть", "secondary", "read-book", { bookId: item.bookId, pageIndex: item.page - 1 })));
    return card;
  }

  function historyRow(day) {
    var parts = [];
    if (day.lessonPages) parts.push(day.lessonPages + " стр. открыто");
    if (day.learned) parts.push(day.learned + " выучено");
    if (day.hard) parts.push(day.hard + " сложно");
    if (day.repeat) parts.push(day.repeat + " на повтор");

    var card = div("item-card");
    card.innerHTML = '<div class="item-title"><b>' + esc(day.label) + '</b><span>' + esc(parts.length ? parts.join(", ") : "занятий не было") + '</span></div>';
    return card;
  }

  function stepsPanel() {
    var panel = div("section-card steps");
    panel.innerHTML =
      '<div class="step"><i>1</i><div><b>Прочитай страницу</b><p>Не спеши, смотри на текст целиком.</p></div></div>' +
      '<div class="step"><i>2</i><div><b>Послушай аудио</b><p>Повтори за записью несколько раз.</p></div></div>' +
      '<div class="step"><i>3</i><div><b>Закрой текст</b><p>Попробуй воспроизвести по памяти.</p></div></div>' +
      '<div class="step"><i>4</i><div><b>Отметь результат</b><p>После отметки приложение покажет следующий шаг.</p></div></div>';
    return panel;
  }

  function taskCard(config) {
    var card = div("item-card");
    var tags = (config.tags || []).map(function (tag) { return '<span class="tag">' + esc(tag) + '</span>'; }).join("");
    var coverUrl = config.coverUrl || inferCoverUrl(config);
    card.innerHTML =
      '<div class="item-head">' + (coverUrl ? '<img class="book-cover" src="' + esc(coverUrl) + '" alt="Обложка: ' + esc(config.title) + '">' : "") +
      '<div class="item-title"><b>' + esc(config.title) + '</b><span>' + esc(config.text || "") + '</span></div>' +
      '<span class="soft-pill">' + esc(config.kind || "") + '</span></div>' +
      (tags ? '<div class="meta-row">' + tags + '</div>' : "") +
      (typeof config.progress === "number" ? '<div class="progress-bar"><i style="width:' + clamp(config.progress, 0, 100) + '%"></i></div>' : "") +
      '<div class="actions"></div>';
    var actions = card.querySelector(".actions");
    (config.actions || []).forEach(function (item) { actions.appendChild(makeButton(item)); });
    return card;
  }

  function inferCoverUrl(config) {
    var bookId = config.bookId;
    if (!bookId && config.actions) {
      var actionWithBook = config.actions.find(function (item) { return item && item.data && item.data.bookId; });
      bookId = actionWithBook && actionWithBook.data.bookId;
    }
    var book = bookId ? getBook(bookId) : null;
    return book && book.coverUrl;
  }

  function emptyAction(title, text, label, viewId) {
    var card = div("item-card");
    card.innerHTML = '<div class="item-title"><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div><div class="actions"></div>';
    card.querySelector(".actions").appendChild(viewButton(label, "primary", viewId));
    return card;
  }

  function recommendedBooks() {
    var books = [];
    recommendedBookIds.forEach(function (id) {
      var book = getBook(id);
      if (book && !getSubscription(book.id)) books.push(book);
    });
    (state.books || []).forEach(function (book) {
      if (books.length < 3 && !getSubscription(book.id) && books.indexOf(book) === -1) books.push(book);
    });
    return books.slice(0, 3);
  }

  function metric(value, label) {
    var el = div("metric-card");
    el.innerHTML = '<b>' + esc(value) + '</b><span>' + esc(label) + '</span>';
    return el;
  }

  function notice(text) {
    var el = div("notice");
    el.textContent = text;
    return el;
  }

  function action(label, style, name, data) {
    return { label: label, style: style, name: name, data: data || {} };
  }

  function makeButton(config) {
    var btn = document.createElement("button");
    var style = config.style || "secondary";
    var isPage = style.indexOf("page") !== -1;
    btn.type = "button";
    btn.className = isPage ? "page-dot" + (style.indexOf("active") !== -1 ? " active" : "") : "btn " + style.replace("disabled", "").trim();
    btn.textContent = config.label;
    btn.dataset.action = config.name;
    Object.keys(config.data || {}).forEach(function (key) {
      btn.dataset[key] = config.data[key];
    });
    if (style.indexOf("disabled") !== -1 || config.name === "noop") btn.disabled = true;
    return btn;
  }

  function viewButton(label, style, viewId) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn " + style;
    btn.textContent = label;
    btn.dataset.view = viewId;
    return btn;
  }

  async function continueStudy() {
    var active = activeSubs();
    if (!active.length) {
      switchView("todayView");
      var target = byId("todayPlan");
      target && target.scrollIntoView({ behavior: "smooth", block: "start" });
      toast("Выбери первую книгу ниже.");
      return;
    }
    return openNextPage(active[0].bookId);
  }

  async function openNextPage(bookId) {
    var data = await api("/books/" + encodeURIComponent(bookId) + "/next", { method: "POST" });
    lesson = data.lesson;
    completion = null;
    selectedBookId = lesson.bookId;
    readerPageIndex = Math.max(0, lesson.page - 1);
    await loadState();
    switchView("studyView");
    haptic("success");
    toast("Открыта страница " + lesson.page + " книги «" + lesson.titleRu + "».");
  }

  async function studyReaderPage() {
    var book = getBook(selectedBookId);
    if (!book) return;
    return studySpecificPage(book.id, readerPageIndex);
  }

  async function studySpecificPage(bookId, pageIndex) {
    var book = getBook(bookId);
    if (!book) return;
    var sub = getSubscription(book.id);
    if (!sub) {
      await api("/books/" + encodeURIComponent(book.id) + "/start", { method: "POST", body: { pace: "slow" } });
      await loadState();
    }
    var index = clamp(Number(pageIndex || 0), 0, Math.max(0, book.pages.length - 1));
    var data = await api("/books/" + encodeURIComponent(book.id) + "/pages/" + index + "/lesson", { method: "POST" });
    lesson = data.lesson;
    completion = null;
    selectedBookId = lesson.bookId;
    readerPageIndex = Math.max(0, lesson.page - 1);
    await loadState();
    switchView("studyView");
    haptic("success");
    toast("Открыта выбранная страница.");
  }

  async function sendFeedback(bookId, feedback) {
    if (!lesson) return;
    var finishedLesson = lesson;
    await api("/books/" + encodeURIComponent(bookId) + "/feedback", { method: "POST", body: { feedback: feedback } });
    completion = {
      bookId: bookId,
      feedback: feedback,
      title: finishedLesson.titleRu,
      page: finishedLesson.page,
      pageIndex: Math.max(0, finishedLesson.page - 1),
      total: finishedLesson.total
    };
    lesson = null;
    await loadState();
    switchView("studyView");
    haptic(feedback === "learned" ? "success" : "medium");
    toast("Результат сохранён.");
  }

  async function startBook(bookId, pace) {
    await api("/books/" + encodeURIComponent(bookId) + "/start", { method: "POST", body: { pace: pace } });
    selectedBookId = bookId;
    readerPageIndex = 0;
    await loadState();
    switchView("todayView");
    haptic("success");
    toast("Книга добавлена в ежедневные занятия.");
  }

  async function startAndOpenBook(bookId, pace) {
    await api("/books/" + encodeURIComponent(bookId) + "/start", { method: "POST", body: { pace: pace } });
    selectedBookId = bookId;
    readerPageIndex = 0;
    await loadState();
    return openNextPage(bookId);
  }

  async function pauseBook(bookId) {
    await api("/books/" + encodeURIComponent(bookId) + "/pause", { method: "POST" });
    await loadState();
    haptic("success");
    toast("Ежедневные задания по этой книге выключены.");
  }

  async function resumeBook(bookId) {
    await api("/books/" + encodeURIComponent(bookId) + "/resume", { method: "POST" });
    await loadState();
    haptic("success");
    toast("Книга снова в ежедневных занятиях.");
  }

  async function removeBook(bookId) {
    var book = getBook(bookId);
    if (!confirmAction("Убрать книгу «" + (book ? book.titleRu : bookId) + "» из твоих занятий? Прогресс по этой книге тоже очистится.")) return;
    await api("/books/" + encodeURIComponent(bookId) + "/remove", { method: "POST" });
    if (selectedBookId === bookId) selectedBookId = currentBookId();
    lesson = null;
    completion = null;
    await loadState();
    switchView("booksView");
    haptic("success");
    toast("Книга убрана из занятий.");
  }

  async function resetBook(bookId) {
    var book = getBook(bookId);
    if (!confirmAction("Начать книгу «" + (book ? book.titleRu : bookId) + "» заново? Все отметки по этой книге очистятся.")) return;
    await api("/books/" + encodeURIComponent(bookId) + "/reset", { method: "POST" });
    lesson = null;
    completion = null;
    await loadState();
    switchView("booksView");
    haptic("success");
    toast("Прогресс книги сброшен. Можно начать заново.");
  }

  async function undoFeedback(bookId) {
    await api("/books/" + encodeURIComponent(bookId) + "/undo-feedback", { method: "POST" });
    completion = null;
    await loadState();
    switchView("todayView");
    haptic("success");
    toast("Последняя отметка по книге отменена.");
  }

  async function undoLastLesson(bookId) {
    await api("/books/" + encodeURIComponent(bookId) + "/undo-lesson", { method: "POST" });
    lesson = null;
    completion = null;
    await loadState();
    switchView("todayView");
    haptic("success");
    toast("Последнее открытие страницы отменено.");
  }

  async function cancelReview(bookId, pageIndex) {
    await api("/books/" + encodeURIComponent(bookId) + "/reviews/" + Number(pageIndex || 0) + "/remove", { method: "POST" });
    await loadState();
    haptic("success");
    toast("Повторение убрано из очереди.");
  }

  async function updateWeeklyGoal(goal) {
    await api("/settings/weekly-goal", { method: "POST", body: { weeklyGoalPages: goal } });
    await loadState();
    haptic("success");
    toast("Цель недели обновлена.");
  }

  function openReader(bookId, pageIndex) {
    selectedBookId = bookId || currentBookId();
    readerPageIndex = Math.max(0, Number(pageIndex || 0));
    readMode = "reader";
    renderReaderList();
    renderReader();
    switchView("readView");
  }

  function openFullPdf(bookId) {
    var book = getBook(bookId || selectedBookId || currentBookId());
    if (!book || !book.fullPdfUrl) {
      toast("PDF пока не подготовлен.");
      return;
    }
    haptic("light");
    window.open(book.fullPdfUrl, "_blank", "noopener");
  }

  function appendAudio(parent, audioUrl, isBookAudio) {
    if (!audioUrl) return;
    var audio = document.createElement("audio");
    audio.className = "audio-player";
    audio.src = audioUrl;
    audio.controls = true;
    parent.appendChild(audio);

    var note = div("reader-hint audio-note");
    note.textContent = isBookAudio
      ? "Аудио - чтение всего матна. Оно не привязано к отдельной странице."
      : "Аудио этой страницы.";
    parent.appendChild(note);
  }

  function showReaderLibrary() {
    readMode = "library";
    renderReaderList();
    renderReader();
    switchView("readView");
  }

  function moveReader(delta) {
    var book = getBook(selectedBookId);
    if (!book) return;
    readerPageIndex = clamp(readerPageIndex + delta, 0, Math.max(0, book.pages.length - 1));
    haptic("select");
    renderReader();
  }

  function setReaderDisplayMode(mode) {
    readerDisplayMode = mode === "text" ? "text" : "pdf";
    localStorage.setItem("hifzReaderDisplayMode", readerDisplayMode);
    renderStudy();
    renderReader();
    haptic("select");
  }

  function setArabicFontScale(delta) {
    arabicFontScale = clamp(Math.round((arabicFontScale + delta) * 100) / 100, 0.82, 1.45);
    localStorage.setItem("hifzArabicFontScale", String(arabicFontScale));
    syncArabicFontScale();
    renderStudy();
    renderReader();
    haptic("select");
  }

  function syncArabicFontScale() {
    document.documentElement.style.setProperty("--arabic-font-scale", arabicFontScale);
  }

  function switchView(viewId) {
    activeView = viewId;
    if (viewId === "readView" && readMode !== "reader") readMode = "library";
    document.querySelectorAll(".view").forEach(function (view) {
      view.classList.toggle("active", view.id === viewId);
    });
    document.querySelectorAll(".nav-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.dataset.view === viewId);
    });
    updateReadModeClass();
    updateBackButton();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function updateReadModeClass() {
    var view = byId("readView");
    if (!view) return;
    view.classList.toggle("reader-mode-library", readMode === "library");
    view.classList.toggle("reader-mode-reader", readMode === "reader");
    document.body.classList.toggle("reader-fullscreen", activeView === "readView" && readMode === "reader");
  }

  function setPending(value) {
    pending = value;
    document.querySelectorAll("[data-action]").forEach(function (button) {
      if (button.dataset.action !== "refresh" && button.dataset.action !== "reader-move") button.disabled = value;
    });
  }

  function showAuthError(error) {
    byId("authView").classList.remove("hidden");
    byId("authView").querySelector("p").textContent = error.message || "Открой кабинет из Telegram-бота.";
    document.querySelectorAll(".view").forEach(function (view) { view.classList.remove("active"); });
    document.querySelector(".bottom-nav").classList.add("hidden");
  }

  function activeSubs() {
    return (state.subscriptions || []).filter(function (sub) { return sub.active; });
  }

  function booksOrderedForReading() {
    var activeIds = activeSubs().map(function (sub) { return sub.bookId; });
    return (state.books || []).slice().sort(function (a, b) {
      var ai = activeIds.indexOf(a.id);
      var bi = activeIds.indexOf(b.id);
      if (ai !== -1 && bi === -1) return -1;
      if (ai === -1 && bi !== -1) return 1;
      if (ai !== -1 && bi !== -1) return ai - bi;
      return a.titleRu.localeCompare(b.titleRu, "ru");
    });
  }

  function dueReviewItems() {
    var today = todayKey();
    return (state.schedule || []).filter(function (item) {
      return item.type === "review" && item.dueDate <= today;
    });
  }

  function currentBookId() {
    var active = activeSubs();
    if (active[0]) return active[0].bookId;
    if (state.books && state.books[0]) return state.books[0].id;
    return null;
  }

  function currentPageIndex() {
    var sub = getSubscription(currentBookId());
    return sub ? Math.max(0, sub.nextChunkIndex) : 0;
  }

  function getBook(bookId) {
    return (state.books || []).find(function (book) { return book.id === bookId; });
  }

  function getSubscription(bookId) {
    return (state.subscriptions || []).find(function (sub) { return sub.bookId === bookId; });
  }

  function nextLabel(sub) {
    if (!sub.nextPreview) return "Новые страницы закончились";
    return "Следующая для учебы: страница " + (sub.nextPreview.index + 1) + " из " + sub.totalChunks;
  }

  function paceValue(pace) {
    return paceValues[pace] || 1;
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function dateLabel(value) {
    if (value === todayKey()) return "сегодня";
    return new Date(value + "T12:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }

  function confirmAction(text) {
    if (typeof window.confirm !== "function") return true;
    return window.confirm(text);
  }

  function setText(id, value) {
    byId(id).textContent = value;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function div(className) {
    var el = document.createElement("div");
    if (className) el.className = className;
    return el;
  }

  function clear(el) {
    el.innerHTML = "";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function textLoading() {
    var el = div("text-loading");
    el.textContent = "Загружаю текст...";
    return el;
  }

  function textUnavailable() {
    var el = div("text-unavailable");
    el.innerHTML =
      '<b>Текст этой страницы пока не сверили</b>' +
      '<span>Цифровой текст появится только там, где он совпадает с этой же PDF-страницей. Сейчас открой PDF, чтобы не учить по неточному тексту.</span>';
    return el;
  }

  function fontControls() {
    var controls = div("font-controls");
    controls.appendChild(makeButton(action("A-", arabicFontScale <= 0.83 ? "secondary small disabled" : "secondary small", "reader-font", { delta: -0.08 })));
    var value = div("font-scale-label");
    value.textContent = Math.round(arabicFontScale * 100) + "%";
    controls.appendChild(value);
    controls.appendChild(makeButton(action("A+", arabicFontScale >= 1.44 ? "secondary small disabled" : "secondary small", "reader-font", { delta: 0.08 })));
    return controls;
  }

  async function loadArabicText(url, container, title) {
    try {
      var text = textCache[url];
      if (!text) {
        var res = await fetch(url);
        if (!res.ok) throw new Error("Не удалось загрузить текст.");
        text = await res.text();
        textCache[url] = text;
      }
      clear(container);
      var heading = div("arabic-title");
      heading.textContent = title || "Матн";
      var body = div("arabic-text");
      body.dir = "rtl";
      body.lang = "ar";
      body.textContent = text.trim();
      container.appendChild(heading);
      container.appendChild(body);
    } catch {
      clear(container);
      container.appendChild(textUnavailable());
    }
  }

  function toast(text) {
    var el = byId("toast");
    el.textContent = text;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("visible"); }, 2800);
  }

  function preventZoom(event) {
    event.preventDefault();
  }

  function bootTelegramChrome() {
    try { tg.ready(); } catch {}
    try { tg.expand(); } catch {}
    if (telegramVersionAtLeast("8.0")) {
      try { tg.requestFullscreen && tg.requestFullscreen(); } catch {}
    }
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch {}
    try { tg.setHeaderColor && tg.setHeaderColor("#101214"); } catch {}
    try { tg.setBackgroundColor && tg.setBackgroundColor("#101214"); } catch {}
    try { tg.setBottomBarColor && tg.setBottomBarColor("#101214"); } catch {}
    document.body.classList.add("tg-native");
    bindTelegramEvent("viewportChanged", syncViewportVars);
    bindTelegramEvent("safeAreaChanged", syncSafeAreaVars);
    bindTelegramEvent("contentSafeAreaChanged", syncSafeAreaVars);
    bindTelegramEvent("fullscreenChanged", syncSafeAreaVars);
    bindTelegramEvent("themeChanged", function () {
      try { tg.setHeaderColor && tg.setHeaderColor("#101214"); } catch {}
      try { tg.setBackgroundColor && tg.setBackgroundColor("#101214"); } catch {}
      try { tg.setBottomBarColor && tg.setBottomBarColor("#101214"); } catch {}
    });
    try { tg.BackButton && tg.BackButton.onClick(handleNativeBack); } catch {}
    syncViewportVars();
  }

  function telegramVersionAtLeast(required) {
    var current = String((tg && tg.version) || "0");
    var currentParts = current.split(".").map(Number);
    var requiredParts = String(required).split(".").map(Number);
    for (var i = 0; i < Math.max(currentParts.length, requiredParts.length); i++) {
      var a = Number(currentParts[i] || 0);
      var b = Number(requiredParts[i] || 0);
      if (a > b) return true;
      if (a < b) return false;
    }
    return true;
  }

  function bindTelegramEvent(name, callback) {
    try { tg.onEvent && tg.onEvent(name, callback); } catch {}
  }

  function syncViewportVars() {
    syncTelegramViewport();
    syncSafeAreaVars();
    syncVisualViewport();
  }

  function syncTelegramViewport() {
    var stable = Number(tg && (tg.viewportStableHeight || tg.viewportHeight));
    if (stable > 0) {
      document.documentElement.style.setProperty("--app-height", Math.round(stable) + "px");
    }
  }

  function syncSafeAreaVars() {
    var safe = (tg && tg.safeAreaInset) || {};
    var content = (tg && tg.contentSafeAreaInset) || {};
    setCssPx("--tg-safe-top", Number(safe.top || 0) + Number(content.top || 0));
    setCssPx("--tg-safe-bottom", Number(safe.bottom || 0) + Number(content.bottom || 0));
    setCssPx("--tg-safe-left", Number(safe.left || 0) + Number(content.left || 0));
    setCssPx("--tg-safe-right", Number(safe.right || 0) + Number(content.right || 0));
  }

  function syncVisualViewport() {
    var viewport = window.visualViewport;
    var height = viewport ? Math.round(viewport.height) : window.innerHeight;
    var top = viewport ? Math.round(viewport.offsetTop) : 0;
    var keyboardHeight = Math.max(0, Math.round(window.innerHeight - height - top));
    document.documentElement.style.setProperty("--vvh", height + "px");
    document.documentElement.style.setProperty("--vv-top", top + "px");
    document.documentElement.style.setProperty("--keyboard-height", keyboardHeight + "px");
    document.body.classList.toggle("kb-open", keyboardHeight > 80);
  }

  function syncTopBarVisibility() {
    if (document.body.classList.contains("reader-fullscreen")) return;
    var current = window.scrollY || document.documentElement.scrollTop || 0;
    var goingDown = current > lastScrollY + 8;
    var goingUp = current < lastScrollY - 8;
    if (current > 72 && goingDown) document.body.classList.add("topbar-hidden");
    if (current < 24 || goingUp) document.body.classList.remove("topbar-hidden");
    lastScrollY = Math.max(0, current);
  }

  function setCssPx(name, value) {
    document.documentElement.style.setProperty(name, Math.max(0, Math.round(value || 0)) + "px");
  }

  function haptic(kind) {
    var h = tg && tg.HapticFeedback;
    if (!h) return;
    try {
      if (kind === "success" || kind === "error" || kind === "warning") h.notificationOccurred && h.notificationOccurred(kind);
      else if (kind === "select") h.selectionChanged && h.selectionChanged();
      else h.impactOccurred && h.impactOccurred(kind || "light");
    } catch {}
  }

  function updateBackButton() {
    if (!tg || !tg.BackButton) return;
    try {
      if (activeView && activeView !== "todayView") tg.BackButton.show();
      else tg.BackButton.hide();
    } catch {}
  }

  function handleNativeBack() {
    haptic("light");
    if (activeView === "readView" && readMode === "reader") {
      showReaderLibrary();
      return;
    }
    if (activeView === "readView" || activeView === "booksView" || activeView === "progressView") {
      switchView("todayView");
      return;
    }
    if (activeView === "studyView" && !lesson && !completion) {
      switchView("todayView");
      return;
    }
    lesson = null;
    completion = null;
    renderStudy();
    switchView("todayView");
  }
})();
