// Срок действия initData в API кабинета. Запуск: npm test
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyInitData } from "../src/app.js";

const TOKEN = "900000000:UNIT_TEST_ONLY";
const NOW = 1_800_000_000;
function sign(fields: Record<string, string>): string {
  const p = new URLSearchParams({ user: JSON.stringify({ id: 7, first_name: "Тест" }), auth_date: String(NOW), ...fields });
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  p.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return p.toString();
}

test("свежий initData проходит", () => {
  const r = verifyInitData(sign({}), TOKEN, 86400, NOW + 60);
  assert.equal(r.user?.chatId, 7);
});

test("просроченный, будущий и без auth_date отклоняются с кодом init_data_expired", () => {
  assert.equal(verifyInitData(sign({}), TOKEN, 86400, NOW + 86401).error, "init_data_expired");
  assert.equal(verifyInitData(sign({}), TOKEN, 86400, NOW - 3600).error, "init_data_expired");
  assert.equal(verifyInitData(sign({ auth_date: "" }), TOKEN, 86400, NOW).error, "init_data_expired");
  assert.equal(verifyInitData(sign({}), TOKEN, 100000, NOW + 86401).user?.chatId, 7);
});

test("подделанная подпись отклоняется", () => {
  assert.equal(verifyInitData(sign({}).replace("auth_date=", "auth_date=1"), TOKEN, 86400, NOW).error, "invalid");
  assert.equal(verifyInitData("", TOKEN, 86400, NOW).error, "invalid");
});
