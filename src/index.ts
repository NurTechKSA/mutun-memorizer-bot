import { createBot } from "./bot.js";
import { getConfig } from "./config.js";
import { startScheduler } from "./scheduler.js";
import { startHealthServer } from "./server.js";
import { JsonStore } from "./storage.js";

const config = getConfig();
const store = new JsonStore(config.dataDir);
const bot = await createBot(config, store);
const server = startHealthServer(config, store);

startScheduler(bot, config, store);

await bot.telegram.deleteWebhook({ drop_pending_updates: false });
await bot.telegram.setMyCommands([
  { command: "start", description: "Главное меню" },
  { command: "app", description: "Личный кабинет" },
  { command: "books", description: "Добавить книгу" },
  { command: "today", description: "Задание на сегодня" },
  { command: "next", description: "Следующая страница" },
  { command: "schedule", description: "Расписание заданий и повторений" },
  { command: "progress", description: "Посмотреть прогресс" },
  { command: "time", description: "Время задания" },
  { command: "mode", description: "Режим занятий" },
  { command: "check", description: "Проверить себя" },
  { command: "pause", description: "Пауза или продолжение" }
]);
await bot.telegram.callApi("setChatMenuButton", {
  menu_button: {
    type: "web_app",
    text: "Кабинет",
    web_app: { url: `${config.publicUrl}/app` }
  }
});
await bot.launch();
console.log("Mutun memorizer bot started.");

process.once("SIGINT", () => {
  server.close();
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  server.close();
  bot.stop("SIGTERM");
});
