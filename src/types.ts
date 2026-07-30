export type Pace = "slow" | "normal" | "fast";
export type StudyMode = "read_listen" | "read" | "listen" | "review";
export type LessonFeedback = "learned" | "hard" | "repeat";
export type ActivityEventType = "lesson_sent" | "feedback" | "reminder_sent" | "goal_updated";

export type ReviewItem = {
  chunkIndex: number;
  dueDate: string;
};

export type BookSource = {
  id: string;
  titleRu: string;
  titleAr: string;
  author: string;
  sourcePage: string;
  rightsNote: string;
  pdf: {
    url: string;
    filename: string;
    pageRange?: {
      from: number;
      to: number;
    };
    studyRange?: {
      from: number;
      to: number;
    };
  };
  audio: {
    url: string;
    filename: string;
    scope?: "book";
  };
};

export type SourcesFile = {
  books: BookSource[];
};

export type CatalogChunk = {
  index: number;
  title: string;
  imagePath: string;
  audioPath?: string;
  audioStatus?: "verified" | "estimated" | "missing";
  textPath?: string;
  sourcePageNumber?: number;
};

export type CatalogBook = {
  id: string;
  titleRu: string;
  titleAr: string;
  author: string;
  sourcePage: string;
  rightsNote: string;
  fullPdfPath?: string;
  audioPath?: string;
  audioScope?: "book" | "page";
  audioStatus?: "verified" | "estimated" | "missing";
  chunks: CatalogChunk[];
};

export type CatalogFile = {
  generatedAt: string;
  books: CatalogBook[];
};

export type Subscription = {
  chatId: number;
  bookId: string;
  pace: Pace;
  mode: StudyMode;
  dailyHour: number;
  nextChunkIndex: number;
  active: boolean;
  pausedUntil?: string;
  reviewQueue: ReviewItem[];
  completedChunkIndexes: number[];
  hardChunkIndexes: number[];
  lastLessonChunkIndexes: number[];
  lastLessonAt?: string;
  lastActivityDate?: string;
  streakDays: number;
  lastScheduledDeliveryDate?: string;
  createdAt: string;
  updatedAt: string;
};

export type ActivityEvent = {
  id: string;
  chatId: number;
  bookId?: string;
  type: ActivityEventType;
  date: string;
  chunkIndexes: number[];
  feedback?: LessonFeedback;
  createdAt: string;
};

export type UserSettings = {
  chatId: number;
  weeklyGoalPages: number;
  reminderHour: number;
  updatedAt: string;
};

export type BotState = {
  subscriptions: Record<string, Subscription>;
  activeBooks: Record<string, string>;
  activityEvents: ActivityEvent[];
  userSettings: Record<string, UserSettings>;
};
