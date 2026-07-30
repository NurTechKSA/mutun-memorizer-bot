import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const catalog = JSON.parse(await fs.readFile(path.join(root, "content", "catalog.json"), "utf8"));
const outDir = path.join(root, "assets", "public");

const palettes = [
  ["#14171d", "#2f3440", "#d7ba72"],
  ["#111518", "#263432", "#c9b47a"],
  ["#151317", "#322b35", "#d3b06f"],
  ["#11151c", "#253044", "#d9c182"],
  ["#151614", "#303329", "#cbb36c"],
  ["#101316", "#28333a", "#d6bd82"]
];

await fs.mkdir(outDir, { recursive: true });

for (const [index, book] of catalog.books.entries()) {
  const [bg, panel, accent] = palettes[index % palettes.length];
  const titleLines = wrapTitle(book.titleRu, 18).slice(0, 3);
  const titleY = titleLines.length === 1 ? 178 : titleLines.length === 2 ? 154 : 132;
  const lines = titleLines
    .map((line, lineIndex) => `<text x="60" y="${titleY + lineIndex * 44}" class="title">${escapeXml(line)}</text>`)
    .join("\n");
  const pages = `${book.chunks.length} фрагм.`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960" viewBox="0 0 720 960" role="img" aria-label="${escapeXml(book.titleRu)}">
  <title>${escapeXml(book.titleRu)}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg}"/>
      <stop offset="1" stop-color="${panel}"/>
    </linearGradient>
    <radialGradient id="glow" cx="30%" cy="12%" r="68%">
      <stop offset="0" stop-color="${accent}" stop-opacity=".24"/>
      <stop offset=".56" stop-color="${accent}" stop-opacity=".06"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <style>
      .kicker { font: 600 24px -apple-system, BlinkMacSystemFont, "SF Pro Text", Arial, sans-serif; fill: rgba(255,255,255,.58); letter-spacing: .8px; }
      .title { font: 750 43px -apple-system, BlinkMacSystemFont, "SF Pro Display", Arial, sans-serif; fill: #fff; letter-spacing: -.8px; }
      .meta { font: 650 25px -apple-system, BlinkMacSystemFont, "SF Pro Text", Arial, sans-serif; fill: ${accent}; }
      .small { font: 600 22px -apple-system, BlinkMacSystemFont, "SF Pro Text", Arial, sans-serif; fill: rgba(255,255,255,.5); }
    </style>
  </defs>
  <rect width="720" height="960" rx="46" fill="url(#bg)"/>
  <rect width="720" height="960" rx="46" fill="url(#glow)"/>
  <path d="M60 86h600M60 874h600" stroke="rgba(255,255,255,.14)" stroke-width="2"/>
  <path d="M88 734c78-76 170-114 276-114s198 38 276 114M88 780c78-76 170-114 276-114s198 38 276 114" fill="none" stroke="${accent}" stroke-opacity=".28" stroke-width="3"/>
  <path d="M600 120c-48 0-88 40-88 88 48 0 88-40 88-88Zm-112 0c48 0 88 40 88 88-48 0-88-40-88-88Z" fill="none" stroke="${accent}" stroke-opacity=".36" stroke-width="4"/>
  <g opacity=".22" stroke="${accent}" stroke-width="2" fill="none">
    <path d="M96 600h528"/>
    <path d="M120 624h480"/>
    <path d="M144 648h432"/>
  </g>
  <text x="60" y="126" class="kicker">NURTECH HIFZ</text>
  ${lines}
  <text x="60" y="812" class="meta">${escapeXml(pages)}</text>
  <text x="60" y="844" class="small">матн для чтения и заучивания</text>
</svg>
`;

  await fs.writeFile(path.join(outDir, `book-cover-${book.id}.svg`), svg);
}

function wrapTitle(title, limit) {
  const words = String(title).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > limit && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [title];
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  })[char]);
}
