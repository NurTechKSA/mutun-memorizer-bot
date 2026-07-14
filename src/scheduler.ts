import cron from "node-cron";
import type { Telegraf } from "telegraf";
import type { AppConfig } from "./config.js";
import { sendDuePortions, sendStudyReminders } from "./delivery.js";
import { JsonStore } from "./storage.js";

export function startScheduler(bot: Telegraf, config: AppConfig, store: JsonStore): void {
  cron.schedule(
    config.deliveryCron,
    async () => {
      await sendDuePortions(bot, config, store);
      await sendStudyReminders(bot, config, store);
    },
    {
      name: "daily-mutun-delivery",
      timezone: config.timezone,
      noOverlap: true
    }
  );

  console.log(`Delivery scheduler: ${config.deliveryCron} (${config.timezone})`);
}
