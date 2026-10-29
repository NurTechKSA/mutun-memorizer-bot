import "dotenv/config";
import { resolveFromRoot } from "./paths.js";

export type AppConfig = {
  botToken: string;
  timezone: string;
  deliveryCron: string;
  dataDir: string;
  contentDir: string;
  port: number;
  publicUrl: string;
  initDataMaxAgeSeconds: number;
};

export function getConfig(): AppConfig {
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error("BOT_TOKEN is required. Copy .env.example to .env and set a BotFather token.");
  }

  return {
    botToken,
    timezone: process.env.APP_TIMEZONE ?? "Asia/Bishkek",
    deliveryCron: process.env.DELIVERY_CRON ?? "0 * * * *",
    dataDir: resolveFromRoot(process.env.DATA_DIR ?? "./data"),
    contentDir: resolveFromRoot(process.env.CONTENT_DIR ?? "./content"),
    port: Number(process.env.PORT ?? 3000),
    publicUrl: process.env.PUBLIC_URL ?? "https://hifz.nurtech.dev",
    // Сколько секунд действует initData кабинета; старше — 401 init_data_expired.
    initDataMaxAgeSeconds: Number(process.env.INIT_DATA_MAX_AGE_SECONDS ?? 86400)
  };
}
