import fs from "node:fs/promises";
import path from "node:path";
import { resolveFromRoot } from "../src/paths.js";
import type { ActivityEvent, BotState, ReviewItem, Subscription } from "../src/types.js";

const dataDir = resolveFromRoot(process.env.DATA_DIR ?? "./data");
const statePath = path.join(dataDir, "state.json");
const markerPath = path.join(dataDir, "migrations", "2026-07-15-trimmed-page-indexes.done");

const removedIndexesByBook: Record<string, number[]> = {
  "al-usul-ath-thalatha": [0],
  "nawaqid-al-islam": [0],
  "al-arbaun-an-nawawiyyah": [0, 58, 70],
  "kashf-ash-shubuhat": [80, 81, 82, 83, 84, 85, 86, 87]
};

await migrate();

async function migrate(): Promise<void> {
  if (await exists(markerPath)) {
    console.log("trimmed page index migration already applied");
    return;
  }

  const raw = await fs.readFile(statePath, "utf8");
  const state = JSON.parse(raw) as BotState;
  const backupPath = `${statePath}.before-trimmed-pages-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  let changedSubscriptions = 0;
  let changedEvents = 0;

  for (const subscription of Object.values(state.subscriptions ?? {})) {
    if (migrateSubscription(subscription)) changedSubscriptions += 1;
  }

  state.activityEvents = (state.activityEvents ?? []).flatMap((event) => {
    const migrated = migrateActivityEvent(event);
    if (!migrated) {
      changedEvents += 1;
      return [];
    }
    if (migrated !== event) changedEvents += 1;
    return [migrated];
  });

  await fs.copyFile(statePath, backupPath);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await fs.writeFile(
    markerPath,
    [
      `appliedAt=${new Date().toISOString()}`,
      `backup=${backupPath}`,
      `changedSubscriptions=${changedSubscriptions}`,
      `changedEvents=${changedEvents}`
    ].join("\n")
  );

  console.log(
    JSON.stringify(
      {
        changedSubscriptions,
        changedEvents,
        backupPath,
        markerPath
      },
      null,
      2
    )
  );
}

function migrateSubscription(subscription: Subscription): boolean {
  const removed = removedIndexesByBook[subscription.bookId];
  if (!removed?.length) return false;

  const before = JSON.stringify(subscription);
  subscription.nextChunkIndex = shiftNextIndex(subscription.nextChunkIndex, removed);
  subscription.reviewQueue = subscription.reviewQueue.flatMap((item) => migrateReviewItem(item, removed));
  subscription.completedChunkIndexes = migrateIndexes(subscription.completedChunkIndexes, removed);
  subscription.hardChunkIndexes = migrateIndexes(subscription.hardChunkIndexes, removed);
  subscription.lastLessonChunkIndexes = migrateIndexes(subscription.lastLessonChunkIndexes, removed);

  if (JSON.stringify(subscription) !== before) {
    subscription.updatedAt = new Date().toISOString();
    return true;
  }

  return false;
}

function migrateActivityEvent(event: ActivityEvent): ActivityEvent | undefined {
  if (!event.bookId) return event;
  const removed = removedIndexesByBook[event.bookId];
  if (!removed?.length) return event;

  const chunkIndexes = migrateIndexes(event.chunkIndexes, removed);
  if (chunkIndexes.length === event.chunkIndexes.length && chunkIndexes.every((value, index) => value === event.chunkIndexes[index])) {
    return event;
  }

  if ((event.type === "lesson_sent" || event.type === "feedback") && chunkIndexes.length === 0) {
    return undefined;
  }

  return { ...event, chunkIndexes };
}

function migrateReviewItem(item: ReviewItem, removed: number[]): ReviewItem[] {
  const chunkIndex = mapIndex(item.chunkIndex, removed);
  return chunkIndex === undefined ? [] : [{ ...item, chunkIndex }];
}

function migrateIndexes(indexes: number[], removed: number[]): number[] {
  return uniqueNumbers(indexes.flatMap((index) => {
    const mapped = mapIndex(index, removed);
    return mapped === undefined ? [] : [mapped];
  }));
}

function mapIndex(index: number, removed: number[]): number | undefined {
  if (removed.includes(index)) return undefined;
  return index - removed.filter((removedIndex) => removedIndex < index).length;
}

function shiftNextIndex(index: number, removed: number[]): number {
  return Math.max(0, index - removed.filter((removedIndex) => removedIndex < index).length);
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
