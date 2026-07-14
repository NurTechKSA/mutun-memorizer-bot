import fs from "node:fs/promises";
import path from "node:path";
import type { ActivityEvent, BotState, LessonFeedback, Pace, StudyMode, Subscription, UserSettings } from "./types.js";

const defaultDailyHour = 8;
const defaultWeeklyGoalPages = 5;
const defaultReminderHour = 20;

export class JsonStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "state.json");
  }

  async read(): Promise<BotState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { subscriptions: {}, activeBooks: {}, activityEvents: [], userSettings: {} };
      }

      throw error;
    }
  }

  async write(state: BotState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.tmp`;
    await fs.writeFile(tmpFile, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
    await fs.rename(tmpFile, this.filePath);
  }

  async getUserSettings(chatId: number): Promise<UserSettings> {
    const state = await this.read();
    const key = String(chatId);
    const settings = state.userSettings[key] ?? defaultUserSettings(chatId);
    if (!state.userSettings[key]) {
      state.userSettings[key] = settings;
      await this.write(state);
    }
    return settings;
  }

  async setWeeklyGoal(chatId: number, weeklyGoalPages: number): Promise<UserSettings> {
    const state = await this.read();
    const now = new Date().toISOString();
    const key = String(chatId);
    const settings: UserSettings = {
      ...(state.userSettings[key] ?? defaultUserSettings(chatId)),
      chatId,
      weeklyGoalPages: clampInteger(weeklyGoalPages, 1, 60),
      updatedAt: now
    };
    state.userSettings[key] = settings;
    state.activityEvents.push(createActivityEvent(chatId, "goal_updated", [], undefined, undefined, localDateKey(new Date()), now));
    await this.write(state);
    return settings;
  }

  async listActivityEvents(chatId: number): Promise<ActivityEvent[]> {
    const state = await this.read();
    return state.activityEvents
      .filter((event) => event.chatId === chatId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async recordReminderSent(chatId: number, date = localDateKey(new Date())): Promise<void> {
    const state = await this.read();
    state.activityEvents.push(createActivityEvent(chatId, "reminder_sent", [], undefined, undefined, date));
    await this.write(state);
  }

  async upsertSubscription(chatId: number, bookId: string, pace: Pace): Promise<Subscription> {
    const state = await this.read();
    const now = new Date().toISOString();
    const key = subscriptionKey(chatId, bookId);
    const existing = state.subscriptions[key];
    const subscription: Subscription = {
      ...defaultSubscription(chatId, bookId, now),
      ...existing,
      chatId,
      bookId,
      pace,
      active: true,
      pausedUntil: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    state.subscriptions[key] = subscription;
    state.activeBooks[String(chatId)] = bookId;
    await this.write(state);
    return subscription;
  }

  async getActiveSubscription(chatId: number): Promise<Subscription | undefined> {
    const state = await this.read();
    const bookId = state.activeBooks[String(chatId)];
    if (bookId) return state.subscriptions[subscriptionKey(chatId, bookId)];

    return Object.values(state.subscriptions).find((subscription) => subscription.chatId === chatId);
  }

  async getSubscription(chatId: number, bookId: string): Promise<Subscription | undefined> {
    const state = await this.read();
    return state.subscriptions[subscriptionKey(chatId, bookId)];
  }

  async listSubscriptions(chatId?: number): Promise<Subscription[]> {
    const state = await this.read();
    return Object.values(state.subscriptions)
      .filter((subscription) => chatId === undefined || subscription.chatId === chatId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async setActiveBook(chatId: number, bookId: string): Promise<Subscription | undefined> {
    const state = await this.read();
    const subscription = state.subscriptions[subscriptionKey(chatId, bookId)];
    if (!subscription) return undefined;

    state.activeBooks[String(chatId)] = bookId;
    await this.write(state);
    return subscription;
  }

  async setPace(chatId: number, pace: Pace): Promise<Subscription | undefined> {
    return this.updateActive(chatId, (subscription) => {
      subscription.pace = pace;
      subscription.active = true;
      subscription.pausedUntil = undefined;
    });
  }

  async setBookPace(chatId: number, bookId: string, pace: Pace): Promise<Subscription | undefined> {
    return this.updateSubscription(chatId, bookId, (subscription) => {
      subscription.pace = pace;
      subscription.active = true;
      subscription.pausedUntil = undefined;
    });
  }

  async setMode(chatId: number, mode: StudyMode): Promise<Subscription | undefined> {
    return this.updateActive(chatId, (subscription) => {
      subscription.mode = mode;
      subscription.active = true;
    });
  }

  async setBookMode(chatId: number, bookId: string, mode: StudyMode): Promise<Subscription | undefined> {
    return this.updateSubscription(chatId, bookId, (subscription) => {
      subscription.mode = mode;
      subscription.active = true;
    });
  }

  async setDailyHour(chatId: number, dailyHour: number): Promise<Subscription | undefined> {
    return this.updateActive(chatId, (subscription) => {
      subscription.dailyHour = dailyHour;
      subscription.active = true;
      subscription.pausedUntil = undefined;
    });
  }

  async setBookDailyHour(chatId: number, bookId: string, dailyHour: number): Promise<Subscription | undefined> {
    return this.updateSubscription(chatId, bookId, (subscription) => {
      subscription.dailyHour = dailyHour;
      subscription.active = true;
      subscription.pausedUntil = undefined;
    });
  }

  async pause(chatId: number, days?: number): Promise<Subscription | undefined> {
    return this.updateActive(chatId, (subscription) => {
      subscription.active = days !== undefined;
      subscription.pausedUntil = days === undefined ? undefined : addDaysIso(new Date(), days);
    });
  }

  async pauseBook(chatId: number, bookId: string, days?: number): Promise<Subscription | undefined> {
    return this.updateSubscription(chatId, bookId, (subscription) => {
      subscription.active = days !== undefined;
      subscription.pausedUntil = days === undefined ? undefined : addDaysIso(new Date(), days);
    });
  }

  async resume(chatId: number): Promise<Subscription | undefined> {
    return this.updateActive(chatId, (subscription) => {
      subscription.active = true;
      subscription.pausedUntil = undefined;
    });
  }

  async resumeBook(chatId: number, bookId: string): Promise<Subscription | undefined> {
    return this.updateSubscription(chatId, bookId, (subscription) => {
      subscription.active = true;
      subscription.pausedUntil = undefined;
    });
  }

  async removeBook(chatId: number, bookId: string): Promise<boolean> {
    const state = await this.read();
    const key = subscriptionKey(chatId, bookId);
    if (!state.subscriptions[key]) return false;

    delete state.subscriptions[key];
    state.activityEvents = state.activityEvents.filter((event) => event.chatId !== chatId || event.bookId !== bookId);
    if (state.activeBooks[String(chatId)] === bookId) {
      const nextActive = Object.values(state.subscriptions).find((subscription) => subscription.chatId === chatId && subscription.active);
      if (nextActive) state.activeBooks[String(chatId)] = nextActive.bookId;
      else delete state.activeBooks[String(chatId)];
    }
    await this.write(state);
    return true;
  }

  async resetBook(chatId: number, bookId: string): Promise<Subscription | undefined> {
    const state = await this.read();
    const key = subscriptionKey(chatId, bookId);
    const existing = state.subscriptions[key];
    if (!existing) return undefined;

    const now = new Date().toISOString();
    state.subscriptions[key] = {
      ...defaultSubscription(chatId, bookId, existing.createdAt),
      pace: existing.pace,
      mode: existing.mode,
      dailyHour: existing.dailyHour,
      active: existing.active,
      createdAt: existing.createdAt,
      updatedAt: now
    };
    state.activityEvents = state.activityEvents.filter((event) => event.chatId !== chatId || event.bookId !== bookId);
    await this.write(state);
    return state.subscriptions[key];
  }

  async undoLastFeedback(chatId: number, bookId: string): Promise<Subscription | undefined> {
    const state = await this.read();
    const subscription = state.subscriptions[subscriptionKey(chatId, bookId)];
    if (!subscription) return undefined;

    const eventIndex = findLastIndex(
      state.activityEvents,
      (event) => event.chatId === chatId && event.bookId === bookId && event.type === "feedback"
    );
    if (eventIndex === -1) return subscription;

    const event = state.activityEvents[eventIndex];
    const chunks = event.chunkIndexes;
    subscription.completedChunkIndexes = subscription.completedChunkIndexes.filter((index) => !chunks.includes(index));
    subscription.hardChunkIndexes = subscription.hardChunkIndexes.filter((index) => !chunks.includes(index));
    subscription.reviewQueue = subscription.reviewQueue.filter((item) => !chunks.includes(item.chunkIndex));
    state.activityEvents.splice(eventIndex, 1);
    recalculateActivity(subscription, state.activityEvents);
    subscription.updatedAt = new Date().toISOString();
    await this.write(state);
    return subscription;
  }

  async undoLastLesson(chatId: number, bookId: string): Promise<Subscription | undefined> {
    const state = await this.read();
    const subscription = state.subscriptions[subscriptionKey(chatId, bookId)];
    if (!subscription) return undefined;

    const eventIndex = findLastIndex(
      state.activityEvents,
      (event) => event.chatId === chatId && event.bookId === bookId && event.type === "lesson_sent"
    );
    if (eventIndex === -1) return subscription;

    const event = state.activityEvents[eventIndex];
    const chunks = event.chunkIndexes;
    state.activityEvents = state.activityEvents.filter((item, index) => {
      if (index === eventIndex) return false;
      if (item.chatId !== chatId || item.bookId !== bookId) return true;
      if (item.type !== "feedback") return true;
      return !item.chunkIndexes.some((chunkIndex) => chunks.includes(chunkIndex));
    });

    subscription.completedChunkIndexes = subscription.completedChunkIndexes.filter((index) => !chunks.includes(index));
    subscription.hardChunkIndexes = subscription.hardChunkIndexes.filter((index) => !chunks.includes(index));
    subscription.reviewQueue = subscription.reviewQueue.filter((item) => !chunks.includes(item.chunkIndex));
    recalculateLessonProgress(subscription, state.activityEvents);
    recalculateActivity(subscription, state.activityEvents);
    subscription.updatedAt = new Date().toISOString();
    await this.write(state);
    return subscription;
  }

  async removeReview(chatId: number, bookId: string, chunkIndex: number): Promise<Subscription | undefined> {
    const state = await this.read();
    const subscription = state.subscriptions[subscriptionKey(chatId, bookId)];
    if (!subscription) return undefined;

    subscription.reviewQueue = subscription.reviewQueue.filter((item) => item.chunkIndex !== chunkIndex);
    subscription.hardChunkIndexes = subscription.hardChunkIndexes.filter((index) => index !== chunkIndex);
    subscription.updatedAt = new Date().toISOString();
    await this.write(state);
    return subscription;
  }

  async recordLessonSent(
    chatId: number,
    bookId: string,
    nextChunkIndex: number,
    lessonChunkIndexes: number[],
    scheduledDeliveryDate?: string
  ): Promise<void> {
    const state = await this.read();
    const subscription = state.subscriptions[subscriptionKey(chatId, bookId)];
    if (!subscription) return;

    subscription.nextChunkIndex = nextChunkIndex;
    subscription.lastLessonChunkIndexes = uniqueNumbers(lessonChunkIndexes);
    subscription.lastLessonAt = new Date().toISOString();
    subscription.reviewQueue = subscription.reviewQueue.filter(
      (item) => !subscription.lastLessonChunkIndexes.includes(item.chunkIndex) || !isDueDate(item.dueDate)
    );
    if (scheduledDeliveryDate) subscription.lastScheduledDeliveryDate = scheduledDeliveryDate;
    subscription.updatedAt = new Date().toISOString();
    state.activityEvents.push(
      createActivityEvent(chatId, "lesson_sent", subscription.lastLessonChunkIndexes, bookId, undefined, scheduledDeliveryDate)
    );
    await this.write(state);
  }

  async recordFeedback(chatId: number, bookId: string, feedback: LessonFeedback): Promise<Subscription | undefined> {
    const state = await this.read();
    const subscription = state.subscriptions[subscriptionKey(chatId, bookId)];
    if (!subscription || subscription.lastLessonChunkIndexes.length === 0) return subscription;

    const today = localDateKey(new Date());
    const now = new Date().toISOString();
    const previousActivityDate = subscription.lastActivityDate;
    subscription.lastActivityDate = today;
    subscription.streakDays = nextStreak(subscription.streakDays, previousActivityDate, today);

    if (feedback === "learned") {
      subscription.completedChunkIndexes = uniqueNumbers([
        ...subscription.completedChunkIndexes,
        ...subscription.lastLessonChunkIndexes
      ]);
      scheduleReviews(subscription, [1, 3, 7, 14]);
    }

    if (feedback === "hard") {
      subscription.hardChunkIndexes = uniqueNumbers([...subscription.hardChunkIndexes, ...subscription.lastLessonChunkIndexes]);
      scheduleReviews(subscription, [1, 3]);
    }

    if (feedback === "repeat") {
      scheduleReviews(subscription, [1]);
    }

    subscription.updatedAt = now;
    state.activityEvents.push(createActivityEvent(chatId, "feedback", subscription.lastLessonChunkIndexes, bookId, feedback, today, now));
    await this.write(state);
    return subscription;
  }

  private async updateActive(
    chatId: number,
    update: (subscription: Subscription) => void
  ): Promise<Subscription | undefined> {
    const state = await this.read();
    const bookId = state.activeBooks[String(chatId)];
    if (!bookId) return undefined;

    const subscription = state.subscriptions[subscriptionKey(chatId, bookId)];
    if (!subscription) return undefined;

    update(subscription);
    subscription.updatedAt = new Date().toISOString();
    await this.write(state);
    return subscription;
  }

  private async updateSubscription(
    chatId: number,
    bookId: string,
    update: (subscription: Subscription) => void
  ): Promise<Subscription | undefined> {
    const state = await this.read();
    const subscription = state.subscriptions[subscriptionKey(chatId, bookId)];
    if (!subscription) return undefined;

    update(subscription);
    state.activeBooks[String(chatId)] = bookId;
    subscription.updatedAt = new Date().toISOString();
    await this.write(state);
    return subscription;
  }
}

export function subscriptionKey(chatId: number, bookId: string): string {
  return `${chatId}:${bookId}`;
}

function normalizeState(
  input: Partial<BotState> & {
    subscriptions?: Record<string, Partial<Subscription>>;
    activityEvents?: Partial<ActivityEvent>[];
    userSettings?: Record<string, Partial<UserSettings>>;
  }
): BotState {
  const subscriptions: Record<string, Subscription> = {};
  const activeBooks: Record<string, string> = { ...(input.activeBooks ?? {}) };
  const userSettings: Record<string, UserSettings> = {};

  for (const [rawKey, rawSubscription] of Object.entries(input.subscriptions ?? {})) {
    if (!rawSubscription.chatId || !rawSubscription.bookId) continue;

    const subscription = normalizeSubscription(rawSubscription);
    const key = rawKey.includes(":") ? rawKey : subscriptionKey(subscription.chatId, subscription.bookId);
    subscriptions[key] = subscription;
    activeBooks[String(subscription.chatId)] ??= subscription.bookId;
  }

  for (const [rawKey, rawSettings] of Object.entries(input.userSettings ?? {})) {
    const chatId = rawSettings.chatId ?? Number(rawKey);
    if (!Number.isFinite(chatId)) continue;
    userSettings[String(chatId)] = normalizeUserSettings(chatId, rawSettings);
  }

  const activityEvents = (input.activityEvents ?? [])
    .map(normalizeActivityEvent)
    .filter((event): event is ActivityEvent => event !== undefined)
    .slice(-5000);

  enforceActiveBookLimit(subscriptions, activeBooks);
  return { subscriptions, activeBooks, activityEvents, userSettings };
}

function enforceActiveBookLimit(subscriptions: Record<string, Subscription>, activeBooks: Record<string, string>): void {
  const byChat = new Map<number, Subscription[]>();

  for (const subscription of Object.values(subscriptions)) {
    if (!subscription.active) continue;
    byChat.set(subscription.chatId, [...(byChat.get(subscription.chatId) ?? []), subscription]);
  }

  for (const [chatId, active] of byChat.entries()) {
    if (active.length <= 2) continue;

    const preferredBookId = activeBooks[String(chatId)];
    const sorted = [...active].sort((a, b) => {
      if (a.bookId === preferredBookId) return -1;
      if (b.bookId === preferredBookId) return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    const keep = new Set(sorted.slice(0, 2).map((subscription) => subscription.bookId));

    for (const subscription of active) {
      if (keep.has(subscription.bookId)) continue;
      subscription.active = false;
      subscription.pausedUntil = undefined;
      subscription.updatedAt = new Date().toISOString();
    }

    if (!preferredBookId || !keep.has(preferredBookId)) {
      activeBooks[String(chatId)] = sorted[0].bookId;
    }
  }
}

function normalizeSubscription(input: Partial<Subscription>): Subscription {
  const now = new Date().toISOString();
  return {
    ...defaultSubscription(input.chatId!, input.bookId!, input.createdAt ?? now),
    ...input,
    chatId: input.chatId!,
    bookId: input.bookId!,
    pace: input.pace ?? "slow",
    mode: input.mode ?? "read_listen",
    dailyHour: input.dailyHour ?? defaultDailyHour,
    nextChunkIndex: input.nextChunkIndex ?? 0,
    active: input.active ?? true,
    reviewQueue: input.reviewQueue ?? [],
    completedChunkIndexes: input.completedChunkIndexes ?? [],
    hardChunkIndexes: input.hardChunkIndexes ?? [],
    lastLessonChunkIndexes: input.lastLessonChunkIndexes ?? [],
    streakDays: input.streakDays ?? 0,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

function defaultSubscription(chatId: number, bookId: string, now: string): Subscription {
  return {
    chatId,
    bookId,
    pace: "slow",
    mode: "read_listen",
    dailyHour: defaultDailyHour,
    nextChunkIndex: 0,
    active: true,
    reviewQueue: [],
    completedChunkIndexes: [],
    hardChunkIndexes: [],
    lastLessonChunkIndexes: [],
    streakDays: 0,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeUserSettings(chatId: number, input: Partial<UserSettings>): UserSettings {
  return {
    ...defaultUserSettings(chatId),
    ...input,
    chatId,
    weeklyGoalPages: clampInteger(input.weeklyGoalPages ?? defaultWeeklyGoalPages, 1, 60),
    reminderHour: clampInteger(input.reminderHour ?? defaultReminderHour, 0, 23),
    updatedAt: input.updatedAt ?? new Date().toISOString()
  };
}

function defaultUserSettings(chatId: number): UserSettings {
  return {
    chatId,
    weeklyGoalPages: defaultWeeklyGoalPages,
    reminderHour: defaultReminderHour,
    updatedAt: new Date().toISOString()
  };
}

function normalizeActivityEvent(input: Partial<ActivityEvent>): ActivityEvent | undefined {
  if (!input.chatId || !input.type || !input.date || !input.createdAt) return undefined;
  if (!["lesson_sent", "feedback", "reminder_sent", "goal_updated"].includes(input.type)) return undefined;
  return {
    id: input.id ?? createActivityId(),
    chatId: input.chatId,
    bookId: input.bookId,
    type: input.type,
    date: input.date,
    chunkIndexes: uniqueNumbers(input.chunkIndexes ?? []),
    feedback: input.feedback,
    createdAt: input.createdAt
  };
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function createActivityEvent(
  chatId: number,
  type: ActivityEvent["type"],
  chunkIndexes: number[],
  bookId?: string,
  feedback?: LessonFeedback,
  date = localDateKey(new Date()),
  createdAt = new Date().toISOString()
): ActivityEvent {
  return {
    id: createActivityId(),
    chatId,
    bookId,
    type,
    date,
    chunkIndexes: uniqueNumbers(chunkIndexes),
    feedback,
    createdAt
  };
}

function createActivityId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function recalculateActivity(subscription: Subscription, events: ActivityEvent[]): void {
  const feedbackDates = uniqueStrings(
    events
      .filter((event) => event.chatId === subscription.chatId && event.bookId === subscription.bookId && event.type === "feedback")
      .map((event) => event.date)
  ).sort();

  subscription.lastActivityDate = feedbackDates[feedbackDates.length - 1];
  subscription.streakDays = calculateStreak(feedbackDates);
}

function recalculateLessonProgress(subscription: Subscription, events: ActivityEvent[]): void {
  const opened = uniqueNumbers(
    events
      .filter((event) => event.chatId === subscription.chatId && event.bookId === subscription.bookId && event.type === "lesson_sent")
      .flatMap((event) => event.chunkIndexes)
  );
  const completed = uniqueNumbers(subscription.completedChunkIndexes);
  const lastOpened = opened[opened.length - 1];
  const lastCompleted = completed[completed.length - 1];
  const nextChunkIndex = Math.max(lastOpened ?? -1, lastCompleted ?? -1) + 1;
  subscription.nextChunkIndex = Math.max(0, nextChunkIndex);

  const lastLessonEvent = [...events]
    .reverse()
    .find((event) => event.chatId === subscription.chatId && event.bookId === subscription.bookId && event.type === "lesson_sent");
  subscription.lastLessonChunkIndexes = lastLessonEvent ? uniqueNumbers(lastLessonEvent.chunkIndexes) : [];
  subscription.lastLessonAt = lastLessonEvent?.createdAt;
}

function calculateStreak(sortedDates: string[]): number {
  if (!sortedDates.length) return 0;

  let streak = 1;
  for (let index = sortedDates.length - 1; index > 0; index -= 1) {
    const current = new Date(`${sortedDates[index]}T12:00:00Z`);
    const previous = new Date(`${sortedDates[index - 1]}T12:00:00Z`);
    current.setUTCDate(current.getUTCDate() - 1);
    if (current.toISOString().slice(0, 10) !== previous.toISOString().slice(0, 10)) break;
    streak += 1;
  }
  return streak;
}

function scheduleReviews(subscription: Subscription, dayOffsets: number[]): void {
  const queued = [...subscription.reviewQueue];
  for (const chunkIndex of subscription.lastLessonChunkIndexes) {
    for (const offset of dayOffsets) {
      const dueDate = localDateKey(addDays(new Date(), offset));
      if (!queued.some((item) => item.chunkIndex === chunkIndex && item.dueDate === dueDate)) {
        queued.push({ chunkIndex, dueDate });
      }
    }
  }

  subscription.reviewQueue = queued.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.chunkIndex - b.chunkIndex);
}

function nextStreak(current: number, previousDate: string | undefined, today: string): number {
  if (!previousDate) return 1;
  if (previousDate === today) return Math.max(current, 1);
  if (previousDate === localDateKey(addDays(new Date(), -1))) return current + 1;
  return 1;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addDaysIso(date: Date, days: number): string {
  return addDays(date, days).toISOString();
}

function localDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isDueDate(dateKey: string): boolean {
  return dateKey <= localDateKey(new Date());
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
