import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { handleAppRequest } from "./app.js";
import { readCatalog } from "./content.js";
import type { AppConfig } from "./config.js";
import { resolveFromRoot } from "./paths.js";
import { JsonStore } from "./storage.js";

const botUrl = "https://t.me/nurtechhifzbot";

export function startHealthServer(config: AppConfig, store: JsonStore): http.Server {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", config.publicUrl);

      if (url.pathname === "/health") {
        const [catalog, state] = await Promise.all([readCatalog(config.contentDir), store.read()]);
        const activeSubscriptions = Object.values(state.subscriptions).filter((item) => item.active).length;

        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            ok: true,
            books: catalog.books.length,
            activeSubscriptions,
            timezone: config.timezone
          })
        );
        return;
      }

      if (await handleAppRequest(request, response, url, config, store)) return;

      if (url.pathname.startsWith("/assets/")) {
        await serveAsset(url.pathname, response);
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderLanding(config.publicUrl));
    } catch (error) {
      console.error("Health server error", error);
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false }));
    }
  });

  server.listen(config.port, () => {
    console.log(`Health server listening on ${config.port}`);
  });

  return server;
}

async function serveAsset(urlPath: string, response: http.ServerResponse): Promise<void> {
  const fileName = path.basename(urlPath);
  const assetPath = resolveFromRoot(path.join("assets", "public", fileName));

  try {
    const file = await fs.readFile(assetPath);
    response.writeHead(200, {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": assetContentType(fileName)
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function assetContentType(fileName: string): string {
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function renderLanding(publicUrl: string): string {
  const bannerUrl = `${publicUrl}/assets/hifz-bot-banner-safe.png`;
  const avatarUrl = `${publicUrl}/assets/hifz-bot-avatar-safe.png`;
  const dailyLessonUrl = `${publicUrl}/assets/hifz-lesson-daily-safe.png`;
  const studyModesUrl = `${publicUrl}/assets/hifz-study-modes-safe.png`;
  const reviewScheduleUrl = `${publicUrl}/assets/hifz-review-schedule-safe.png`;
  const selfCheckUrl = `${publicUrl}/assets/hifz-self-check-safe.png`;
  const progressUrl = `${publicUrl}/assets/hifz-progress-safe.png`;
  const libraryUrl = `${publicUrl}/assets/hifz-library-safe.png`;

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NurTech Hifz</title>
    <meta name="description" content="Telegram-бот для заучивания матнов: ежедневные фрагменты с аудио, повторения, самопроверка и прогресс." />
    <meta property="og:title" content="NurTech Hifz" />
    <meta property="og:description" content="Заучивай матны постепенно: фрагмент, аудио, повторение и прогресс каждый день." />
    <meta property="og:image" content="${bannerUrl}" />
    <style>
      * { box-sizing: border-box; }
      :root {
        color-scheme: dark;
        --bg: #07111f;
        --ink: #f7fbf8;
        --muted: #bbcac4;
        --line: rgba(255,255,255,.18);
        --glass: rgba(255,255,255,.1);
        --glass-strong: rgba(255,255,255,.18);
        --emerald: #51d6a4;
        --gold: #f4cb72;
        --navy: #0c1d30;
      }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 18% 12%, rgba(81,214,164,.18), transparent 32%),
          radial-gradient(circle at 82% 24%, rgba(244,203,114,.12), transparent 26%),
          linear-gradient(135deg, #050a14 0%, #07111f 46%, #0e2434 100%);
        color: var(--ink);
        overflow-x: hidden;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
        background-size: 48px 48px;
        mask-image: linear-gradient(to bottom, rgba(0,0,0,.7), transparent 72%);
      }
      a { color: inherit; text-decoration: none; }
      .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
      .glass {
        border: 1px solid var(--line);
        background: linear-gradient(140deg, rgba(255,255,255,.18), rgba(255,255,255,.07));
        box-shadow: inset 0 1px 0 rgba(255,255,255,.24), 0 24px 80px rgba(0,0,0,.34);
        backdrop-filter: blur(24px) saturate(150%);
        -webkit-backdrop-filter: blur(24px) saturate(150%);
      }
      .nav {
        position: fixed;
        z-index: 10;
        left: 50%;
        top: 16px;
        transform: translateX(-50%);
        width: min(1180px, calc(100% - 32px));
        min-height: 64px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 10px 12px 10px 14px;
        border-radius: 22px;
      }
      .brand { display: inline-flex; align-items: center; gap: 12px; min-width: 0; font-weight: 800; }
      .brand img { width: 42px; height: 42px; border-radius: 14px; box-shadow: 0 10px 32px rgba(0,0,0,.28); }
      .links { display: flex; align-items: center; gap: 20px; color: #d7e5df; font-size: 14px; }
      .nav-cta, .cta, .ghost {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 46px;
        padding: 0 18px;
        border-radius: 999px;
        font-weight: 800;
        white-space: nowrap;
      }
      .nav-cta, .cta { background: linear-gradient(135deg, #8df4c9, #42cf98); color: #04120d; box-shadow: 0 16px 44px rgba(66,207,152,.26); }
      .ghost { border: 1px solid rgba(255,255,255,.2); color: #eef8f4; background: rgba(255,255,255,.07); }
      .hero {
        min-height: 100svh;
        display: grid;
        align-items: center;
        padding: 118px 0 72px;
        position: relative;
      }
      .hero-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 520px); gap: 42px; align-items: center; }
      .hero-grid > * { min-width: 0; }
      .eyebrow { display: inline-flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 999px; color: #d9fff0; font-size: 14px; }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--emerald); box-shadow: 0 0 22px var(--emerald); }
      h1 { margin: 20px 0 18px; max-width: 720px; font-size: clamp(40px, 5.8vw, 74px); line-height: 1.02; letter-spacing: 0; }
      .lead { margin: 0; max-width: 620px; color: #d8e7e0; font-size: clamp(17px, 1.65vw, 20px); line-height: 1.55; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 34px 0 0; }
      .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 38px; max-width: 640px; }
      .stat { min-height: 108px; padding: 18px; border-radius: 24px; }
      .stat strong { display: block; font-size: 28px; line-height: 1; }
      .stat span { display: block; margin-top: 10px; color: var(--muted); font-size: 14px; line-height: 1.35; }
      .visual { position: relative; min-height: 610px; }
      .liquid-frame {
        position: absolute;
        inset: 0 0 50px 0;
        overflow: hidden;
        border-radius: 42px;
      }
      .liquid-frame::before {
        content: "";
        position: absolute;
        inset: -20px;
        background: linear-gradient(110deg, rgba(7,17,31,.88), rgba(7,17,31,.2) 42%, rgba(7,17,31,.92)), url("${bannerUrl}") center / cover;
        transform: scale(1.03);
      }
      .lesson {
        position: absolute;
        left: 28px;
        right: 28px;
        bottom: 0;
        padding: 22px;
        border-radius: 32px;
      }
      .lesson-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .lesson-title { display: flex; align-items: center; gap: 12px; font-weight: 800; }
      .lesson-title img { width: 52px; height: 52px; border-radius: 16px; }
      .pill { padding: 8px 11px; border-radius: 999px; color: #072017; background: rgba(141,244,201,.9); font-size: 13px; font-weight: 800; }
      .page-preview { margin-top: 20px; padding: 18px; border-radius: 24px; background: rgba(4,12,22,.42); border: 1px solid rgba(255,255,255,.12); }
      .arabic-lines { display: grid; gap: 10px; direction: rtl; }
      .line { height: 9px; border-radius: 999px; background: linear-gradient(90deg, rgba(255,255,255,.24), rgba(244,203,114,.9), rgba(255,255,255,.2)); }
      .line:nth-child(2) { width: 86%; justify-self: end; }
      .line:nth-child(3) { width: 74%; justify-self: end; }
      .audio { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
      .play { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 999px; background: var(--emerald); color: #06120e; font-weight: 900; }
      .wave { flex: 1; height: 42px; display: flex; align-items: center; gap: 5px; }
      .bar { width: 5px; border-radius: 999px; background: linear-gradient(#f4cb72, #51d6a4); opacity: .95; }
      .bar:nth-child(1) { height: 14px; } .bar:nth-child(2) { height: 24px; } .bar:nth-child(3) { height: 34px; }
      .bar:nth-child(4) { height: 18px; } .bar:nth-child(5) { height: 38px; } .bar:nth-child(6) { height: 26px; }
      .bar:nth-child(7) { height: 16px; } .bar:nth-child(8) { height: 30px; } .bar:nth-child(9) { height: 20px; }
      .checks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 16px; }
      .check { min-height: 44px; border-radius: 16px; display: grid; place-items: center; color: #eafff6; border: 1px solid rgba(255,255,255,.13); background: rgba(255,255,255,.07); font-size: 14px; font-weight: 800; }
      .section { padding: 42px 0; }
      .section h2 { margin: 0 0 16px; font-size: clamp(28px, 3.8vw, 44px); line-height: 1.1; letter-spacing: 0; }
      .section-copy { color: var(--muted); margin: 0 0 24px; font-size: 17px; line-height: 1.6; max-width: 690px; }
      .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
      .card { min-height: 218px; padding: 18px; border-radius: 30px; overflow: hidden; }
      .card-body { padding: 6px; }
      .card-visual {
        width: 100%;
        aspect-ratio: 3 / 2;
        overflow: hidden;
        border-radius: 22px;
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(4,12,22,.4);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.16);
      }
      .card-visual img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .card b { display: block; margin: 14px 0 9px; font-size: 19px; line-height: 1.25; }
      .card p { margin: 0; color: #c8d8d1; font-size: 15px; line-height: 1.55; }
      .icon { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 18px; background: rgba(81,214,164,.16); color: var(--gold); font-size: 24px; }
      .catalog-grid { display: grid; grid-template-columns: minmax(0, .95fr) minmax(0, 1.05fr); gap: 18px; align-items: stretch; }
      .catalog-image { min-height: 100%; border-radius: 30px; overflow: hidden; }
      .catalog-image img { display: block; width: 100%; height: 100%; min-height: 350px; object-fit: cover; }
      .mutun { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
      .tag { padding: 10px 13px; border-radius: 999px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14); color: #eaf5f0; font-size: 15px; }
      .cta-band { margin: 48px 0 72px; padding: 34px; border-radius: 36px; display: grid; grid-template-columns: 1fr auto; gap: 20px; align-items: center; }
      .cta-band h2 { margin: 0 0 10px; font-size: clamp(28px, 3.4vw, 40px); line-height: 1.1; }
      .cta-band p { margin: 0; color: var(--muted); font-size: 17px; line-height: 1.55; }
      @media (max-width: 940px) {
        .links { display: none; }
        .hero-grid { grid-template-columns: 1fr; }
        .visual { min-height: 540px; }
        .cards { grid-template-columns: 1fr; }
        .catalog-grid { grid-template-columns: 1fr; }
        .cta-band { grid-template-columns: 1fr; }
      }
      @media (max-width: 640px) {
        body { width: 100%; max-width: 100vw; }
        .shell { width: calc(100vw - 24px); max-width: calc(100vw - 24px); margin-left: 12px; margin-right: 12px; }
        .nav { width: calc(100vw - 24px); max-width: calc(100vw - 24px); top: 10px; border-radius: 18px; }
        .brand span { max-width: 128px; overflow: hidden; text-overflow: ellipsis; }
        .nav-cta { min-height: 40px; padding: 0 13px; font-size: 0; }
        .nav-cta::after { content: "Открыть"; font-size: 14px; }
        .hero { padding-top: 96px; overflow: hidden; }
        .hero-grid, .cards, .stats, .mutun, .cta-band { width: 100%; max-width: 100%; }
        h1 { max-width: 100%; font-size: clamp(34px, 10.5vw, 44px); line-height: 1.05; overflow-wrap: break-word; }
        .lead, .section-copy, .cta-band p { width: 100%; max-width: 100%; font-size: 16px; overflow-wrap: break-word; }
        .card p { width: 100%; max-width: 100%; font-size: 15px; overflow-wrap: break-word; }
        .actions { display: grid; grid-template-columns: 1fr; }
        .cta, .ghost { width: 100%; }
        .stats { grid-template-columns: 1fr; }
        .visual { min-height: 460px; }
        .liquid-frame { left: 0; right: 0; }
        .lesson { left: 12px; right: 12px; padding: 16px; border-radius: 26px; }
        .liquid-frame { border-radius: 32px; }
        .lesson-top { align-items: flex-start; }
        .lesson-title { min-width: 0; }
        .page-preview { padding: 14px; }
        .checks { grid-template-columns: 1fr; }
        .section { padding: 32px 0; }
        .card { padding: 14px; border-radius: 26px; }
        .card-visual { border-radius: 18px; }
        .catalog-image img { min-height: 240px; }
        .cta-band { padding: 24px; border-radius: 28px; margin-bottom: 42px; }
      }
    </style>
  </head>
  <body>
    <header class="nav glass">
      <a class="brand" href="#">
        <img src="${avatarUrl}" alt="" />
        <span>NurTech Hifz</span>
      </a>
      <nav class="links" aria-label="Разделы">
        <a href="#method">Метод</a>
        <a href="#features">Возможности</a>
        <a href="#mutun">Матны</a>
      </nav>
      <a class="nav-cta" href="${botUrl}">Открыть бота</a>
    </header>

    <main>
      <section class="hero shell">
        <div class="hero-grid">
          <div>
            <div class="eyebrow glass"><span class="dot"></span> Telegram-бот для ежедневного хифза матнов</div>
            <h1>Учить матны спокойно. Каждый день.</h1>
            <p class="lead">NurTech Hifz разбивает матн на учебные фрагменты, присылает текст и аудио, возвращает повторения и показывает прогресс. Без перегруза: открыл Telegram, сделал задание, отметил результат.</p>
            <div class="actions">
              <a class="cta" href="${botUrl}">Начать в Telegram</a>
              <a class="ghost" href="#method">Как это работает</a>
            </div>
            <div class="stats">
              <div class="stat glass"><strong>12</strong><span>матнов уже в каталоге</span></div>
              <div class="stat glass"><strong>1-3</strong><span>фрагмента в день на выбор</span></div>
              <div class="stat glass"><strong>4</strong><span>волны повторения после выученного</span></div>
            </div>
          </div>

          <div class="visual" aria-hidden="true">
            <div class="liquid-frame glass"></div>
            <div class="lesson glass">
              <div class="lesson-top">
                <div class="lesson-title">
                  <img src="${avatarUrl}" alt="" />
                  <span>Сегодняшнее задание</span>
                </div>
                <span class="pill">08:00</span>
              </div>
              <div class="page-preview">
                <div class="arabic-lines">
                  <span class="line"></span>
                  <span class="line"></span>
                  <span class="line"></span>
                  <span class="line"></span>
                </div>
                <div class="audio">
                  <span class="play">▶</span>
                  <div class="wave">
                    <span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span>
                  </div>
                </div>
                <div class="checks">
                  <span class="check">Выучил</span>
                  <span class="check">Сложно</span>
                  <span class="check">Повторить завтра</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="method" class="section shell">
        <h2>Метод без суеты</h2>
        <p class="section-copy">Бот ведет не просто по порядку. Он помогает закреплять: новое задание, отметка результата, повторение завтра, через 3 дня, через неделю и через 2 недели.</p>
        <div class="cards">
          <article class="card glass">
            <div class="card-visual"><img src="${dailyLessonUrl}" alt="Ежедневный фрагмент матна с аудио в Telegram" loading="lazy" /></div>
            <div class="card-body"><span class="icon">1</span><b>Получаешь фрагмент</b><p>Картинка матна и аудио приходят прямо в Telegram в выбранное время.</p></div>
          </article>
          <article class="card glass">
            <div class="card-visual"><img src="${selfCheckUrl}" alt="Самопроверка заученного фрагмента" loading="lazy" /></div>
            <div class="card-body"><span class="icon">2</span><b>Отмечаешь результат</b><p>Нажимаешь «Выучил», «Сложно» или «Повторить завтра».</p></div>
          </article>
          <article class="card glass">
            <div class="card-visual"><img src="${reviewScheduleUrl}" alt="График повторений для матнов" loading="lazy" /></div>
            <div class="card-body"><span class="icon">3</span><b>Повторяешь по графику</b><p>Старые фрагменты возвращаются в нужные дни, чтобы знание не распалось.</p></div>
          </article>
        </div>
      </section>

      <section id="features" class="section shell">
        <h2>Для реального заучивания</h2>
        <p class="section-copy">Темп, режим, время, самопроверка и пауза настраиваются внутри бота. Можно учить несколько книг и видеть прогресс по каждой.</p>
        <div class="cards">
          <article class="card glass">
            <div class="card-visual"><img src="${studyModesUrl}" alt="Режимы занятий в NurTech Hifz" loading="lazy" /></div>
            <div class="card-body"><span class="icon">◌</span><b>Режимы занятий</b><p>Текст и аудио, только текст, только аудио или только повторение.</p></div>
          </article>
          <article class="card glass">
            <div class="card-visual"><img src="${selfCheckUrl}" alt="Режим самопроверки в NurTech Hifz" loading="lazy" /></div>
            <div class="card-body"><span class="icon">✓</span><b>Самопроверка</b><p>Сначала вспоминаешь по памяти, потом открываешь текст и сверяешься.</p></div>
          </article>
          <article class="card glass">
            <div class="card-visual"><img src="${progressUrl}" alt="Прогресс заучивания матнов" loading="lazy" /></div>
            <div class="card-body"><span class="icon">↗</span><b>Прогресс</b><p>Видно, сколько фрагментов пройдено, что выучено и что пора повторить.</p></div>
          </article>
        </div>
      </section>

      <section id="mutun" class="section shell">
        <h2>Матны в каталоге</h2>
        <p class="section-copy">Начни с базовых книг и двигайся постепенно. Каталог можно расширять новыми матнами и более точной аудио-разметкой.</p>
        <div class="catalog-grid">
          <div class="catalog-image glass"><img src="${libraryUrl}" alt="Каталог матнов для заучивания" loading="lazy" /></div>
          <div class="glass card">
            <div class="card-body">
              <span class="icon">12</span>
              <b>Базовые книги уже внутри</b>
              <p>Пользователь выбирает матн, темп и получает понятный маршрут без ручной нарезки и поиска аудио.</p>
              <div class="mutun">
                <span class="tag">Три основы</span>
                <span class="tag">Четыре правила</span>
                <span class="tag">Кашф аш-шубухат</span>
                <span class="tag">Навакид аль-Ислам</span>
                <span class="tag">Шесть основ</span>
                <span class="tag">Китаб ат-таухид</span>
                <span class="tag">40 хадисов ан-Навави</span>
                <span class="tag">Тухфат аль-атфаль</span>
                <span class="tag">Аль-Байкуния</span>
                <span class="tag">Аль-Аджуррумия</span>
                <span class="tag">Аль-Васития</span>
                <span class="tag">Масаиль аль-джахилийя</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="shell">
        <div class="cta-band glass">
          <div>
            <h2>Начни с одного фрагмента.</h2>
            <p>Выбери книгу, поставь темп и получи первое задание сразу через /today.</p>
          </div>
          <a class="cta" href="${botUrl}">Открыть @nurtechhifzbot</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}
