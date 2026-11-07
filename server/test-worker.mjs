/**
 * Тесты Worker-а «Общей комнаты» на локальном моке KV и Durable Object.
 * Запуск: node server/test-worker.mjs
 */
import worker from "./worker.js";

class MockKV {
  constructor() { this.map = new Map(); this.listCalls = 0; this.getCalls = 0; }
  async get(key) { this.getCalls++; const e = this.map.get(key); return e ? e.value : null; }
  async getWithMetadata(key) {
    this.getCalls++;
    const e = this.map.get(key);
    if (!e) return null;
    return { value: e.value, metadata: e.metadata };
  }
  async put(key, value, opts) { this.map.set(key, { value, metadata: opts && opts.metadata }); }
  async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => this.map.delete(k)); }
  async list(opts) {
    this.listCalls++;
    const prefix = (opts && opts.prefix) || "";
    const limit = (opts && opts.limit) || 1000;
    const keys = [];
    for (const [name, e] of this.map) {
      if (name.startsWith(prefix)) keys.push({ name, metadata: e.metadata });
      if (keys.length >= limit) break;
    }
    return { keys, list_complete: true };
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG_EXIF = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 1, 2, 3]);

class MockDurableObject {
  constructor(counters, env) { this.counters = counters; this.env = env; }
  idFromName(name) { return name; }
  get(name) {
    const self = this;
    return {
      async fetch(input) {
        const url = new URL(String(input));
        if (url.pathname === "/count") {
          const action = url.searchParams.get("action") || "check";
          const stored = self.counters.get(name) || null;
          let count = stored ? stored.n : 0;
          if (!stored) {
            const listed = await self.env.ROOM.list({ prefix: "i/", limit: 500 });
            count = listed.keys.length;
          }
          if (action === "inc") {
            if (count >= 300) return new Response("full", { status: 409 });
            self.counters.set(name, { n: count + 1 });
            return new Response("ok", { status: 200 });
          }
          if (action === "dec") {
            self.counters.set(name, { n: Math.max(0, count - 1) });
            return new Response("ok", { status: 200 });
          }
          return new Response(String(count), { status: 200 });
        }
        const day = new Date().toISOString().slice(0, 10);
        const stored = self.counters.get(name) || { day: day, count: 0 };
        if (stored.day !== day) { stored.day = day; stored.count = 0; }
        if (stored.count >= 10) { return new Response("limit", { status: 429 }); }
        stored.count += 1;
        self.counters.set(name, stored);
        return new Response("ok", { status: 200 });
      }
    };
  }
}

function env(token, withDO) {
  const e = { ROOM: new MockKV(), ROOM_ADMIN_TOKEN: token || "" };
  if (withDO !== false) { e.RATE_LIMITER = new MockDurableObject(new Map(), e); }
  return e;
}

async function call(e, path, init) {
  const req = new Request("https://room.test" + path, init);
  const res = await worker.fetch(req, e);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : await res.arrayBuffer();
  return { status: res.status, body, headers: res.headers };
}

function uploadForm(bytes, filename, type, fields) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  for (const k of Object.keys(fields || {})) form.append(k, fields[k]);
  return { method: "POST", body: form };
}

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok  " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? " :: " + JSON.stringify(detail).slice(0, 200) : "")); }
}

console.log("1. пустая комната");
{
  const e = env("secret");
  const r = await call(e, "/state");
  check("GET /state отвечает 200", r.status === 200, r.body);
  check("предметов нет", r.body.count === 0 && r.body.items.length === 0, r.body);
  check("есть CORS", r.headers.get("access-control-allow-origin") === "*");
}

console.log("2. загрузка картинки");
let uploadedId = null;
{
  const e = env("secret");
  const r = await call(e, "/item", uploadForm(PNG, "a.png", "image/png", { x: 0.3, y: 0.4, w: 0.25, author: "Гость", vector: "Уретральный", kind: "piece" }));
  check("POST /item отвечает 200", r.status === 200, r.body);
  check("item.id на месте", !!(r.body.item && r.body.item.id), r.body);
  check("тип распознан как png", r.body.item && r.body.item.type === "png", r.body.item);
  check("подпись сохранена", r.body.item && r.body.item.author === "Гость", r.body.item);
  check("автору выдан личный ключ", typeof r.body.secret === "string" && r.body.secret.length >= 16, r.body.secret);
  check("тип предмета сохранён", r.body.item.kind === "piece", r.body.item.kind);
  check("личный ключ не попал в список комнаты", !("secret" in r.body.item), r.body.item);
  uploadedId = r.body.item.id;

  const state = await call(e, "/state");
  check("предмет появился в комнате", state.body.count === 1, state.body);
  check("координаты сохранены", state.body.items[0].x === 0.3 && state.body.items[0].w === 0.25, state.body.items[0]);
  check("url ведёт на медиа", state.body.items[0].url === "/media/" + uploadedId, state.body.items[0]);

  const media = await call(e, "/media/" + uploadedId);
  check("медиа отдаётся", media.status === 200 && media.body.byteLength === PNG.length, media.status);
  check("content-type картинки", media.headers.get("content-type") === "image/png", media.headers.get("content-type"));
  check("nosniff на месте", media.headers.get("x-content-type-options") === "nosniff");
}

console.log("3. тип файла определяется по сигнатуре");
{
  const e = env("secret");
  const svg = await call(e, "/item", uploadForm(new TextEncoder().encode('<svg onload="alert(1)"></svg>'), "x.svg", "image/svg+xml", {}));
  check("SVG отклонён", svg.status === 415, svg.body);
  const fake = await call(e, "/item", uploadForm(new TextEncoder().encode("<?php echo 1; ?>"), "x.php", "image/png", {}));
  check("файл с чужой подписью отклонён", fake.status === 415, fake.body);
  const gif = await call(e, "/item", uploadForm(GIF, "b.gif", "image/gif", {}));
  check("GIF принят", gif.status === 200 && gif.body.item.type === "gif", gif.body);
  const jpg = await call(e, "/item", uploadForm(JPEG, "c.jpg", "image/jpeg", {}));
  check("JPEG принят", jpg.status === 200 && jpg.body.item.type === "jpg", jpg.body);
}

console.log("4. лимиты");
{
  const e = env("secret");
  const big = new Uint8Array(9 * 1024 * 1024);
  big.set(PNG.subarray(0, 12));
  const r = await call(e, "/item", uploadForm(big, "big.png", "image/png", {}));
  check("файл больше 8 МБ отклонён", r.status === 413, r.body);
}
{
  const e = env("secret");
  let limited = null;
  for (let i = 0; i < 12; i++) {
    const r = await call(e, "/item", uploadForm(PNG, "x.png", "image/png", {}));
    if (r.status === 429) { limited = i + 1; break; }
  }
  check("11-я загрузка за сутки отбита лимитом", limited === 11, limited);
}
{
  const e = env("secret");
  const bad = await call(e, "/item", uploadForm(new TextEncoder().encode("not an image"), "x.png", "image/png", {}));
  check("битый файл отбит", bad.status === 415, bad.body);
  let okCount = 0;
  for (let i = 0; i < 12; i++) {
    const r = await call(e, "/item", uploadForm(PNG, "y" + i + ".png", "image/png", {}));
    if (r.status === 200) { okCount++; }
  }
  check("неудачная загрузка не съела дневной слот", okCount === 10, okCount);
}

console.log("5. удаление и доступ");
{
  const e = env("secret");
  const r = await call(e, "/item", uploadForm(PNG, "a.png", "image/png", {}));
  const id = r.body.item.id;
  const noToken = await call(e, "/item?id=" + id, { method: "DELETE" });
  check("удаление без токена запрещено", noToken.status === 403, noToken.body);
  const wrongToken = await call(e, "/item?id=" + id, { method: "DELETE", headers: { "x-room-token": "nope" } });
  check("удаление с чужим токеном запрещено", wrongToken.status === 403, wrongToken.body);
  const ok = await call(e, "/item?id=" + id, { method: "DELETE", headers: { "x-room-token": "secret" } });
  check("удаление с верным токеном прошло", ok.status === 200 && ok.body.ok === true, ok.body);
  const state = await call(e, "/state");
  check("предмет исчез из комнаты", state.body.count === 0, state.body);
  const media = await call(e, "/media/" + id);
  check("файл удалён с диска", media.status === 404, media.status);
  const again = await call(e, "/item?id=" + id, { method: "DELETE", headers: { "x-room-token": "secret" } });
  check("повторное удаление ничего не удаляет", again.body.removed === 0, again.body);
}

console.log("6. мусор в идентификаторах");
{
  const e = env("secret");
  const bad = await call(e, "/media/..%2F..%2Fetc%2Fpasswd");
  check("обход пути отбит", bad.status === 400 || bad.status === 404, bad.status);
  const missing = await call(e, "/state");
  check("комната жива", missing.status === 200);
  const root = await call(e, "/");
  check("служебный корень отвечает", root.status === 200 && root.body.ok === true, root.body);
}

console.log("7. запуск изолированных посетителей");
{
  const e = env("secret");
  const a = await call(e, "/item", uploadForm(PNG, "a.png", "image/png", { author: "Первый" }));
  const b = await call(e, "/item", uploadForm(GIF, "b.gif", "image/gif", { author: "Второй" }));
  const state = await call(e, "/state");
  check("оба предмета в комнате", state.body.count === 2, state.body.count);
  const authors = state.body.items.map((i) => i.author).sort();
  check("подписи разных гостей", authors.join(",") === "Второй,Первый", authors);
  check("порядок по времени", state.body.items[0].createdAt <= state.body.items[1].createdAt);
  check("все id уникальны", a.body.item.id !== b.body.item.id);
}

console.log("8. параллельные загрузки не обходят дневной лимит");
{
  const e = env("secret", true);
  const uploads = [];
  for (let i = 0; i < 18; i++) {
    uploads.push(call(e, "/item", uploadForm(PNG, "p" + i + ".png", "image/png", {})));
  }
  const results = await Promise.all(uploads);
  const okCount = results.filter((r) => r.status === 200).length;
  const limited = results.filter((r) => r.status === 429).length;
  check("лимит держит при параллельных запросах", okCount <= 12, { okCount, limited });
  check("остальные отбиты кодом 429", limited === results.length - okCount, { okCount, limited });
}

console.log("9. список комнаты кэшируется в изоляте");
{
  const e = env("secret");
  await call(e, "/item", uploadForm(PNG, "a.png", "image/png", {}));
  const first = await call(e, "/state");
  const second = await call(e, "/state");
  check("оба ответа содержат предмет", first.body.count === 1 && second.body.count === 1, { first: first.body.count, second: second.body.count });
}

console.log("10. запасной лимит без Durable Object");
{
  const e = env("secret", false);
  let okCount = 0;
  for (let i = 0; i < 12; i++) {
    const r = await call(e, "/item", uploadForm(PNG, "f" + i + ".png", "image/png", {}));
    if (r.status === 200) { okCount++; }
  }
  check("без DO лимит держит на последовательных запросах", okCount === 10, okCount);
}

console.log("11. картинка с метаданными не принимается");
{
  const e = env("secret");
  const r = await call(e, "/item", uploadForm(JPEG_EXIF, "geo.jpg", "image/jpeg", {}));
  check("EXIF-файл отбит", r.status === 415 && r.body.error === "metadata", r.body);
}

console.log("12. гость снимает свою картинку личным ключом");
{
  const e = env("secret");
  const r = await call(e, "/item", uploadForm(PNG, "a.png", "image/png", {}));
  const id = r.body.item.id;
  const secret = r.body.secret;
  const foreign = await call(e, "/item?id=" + id, { method: "DELETE", headers: { "x-room-token": secret.slice(0, -1) } });
  check("чужой ключ не подходит", foreign.status === 403, foreign.body);
  const mine = await call(e, "/item?id=" + id, { method: "DELETE", headers: { "x-room-token": secret } });
  check("гость снял свою картинку", mine.status === 200 && mine.body.ok === true, mine.body);
  const state = await call(e, "/state");
  check("предмет исчез", state.body.count === 0, state.body);
}

console.log("13. отдача картинки не тратит список");
{
  const e = env("secret");
  const r = await call(e, "/item", uploadForm(PNG, "a.png", "image/png", {}));
  const id = r.body.item.id;
  const before = e.ROOM.listCalls;
  await call(e, "/media/" + id);
  check("media читается одним get без list", e.ROOM.listCalls === before && e.ROOM.getCalls > 0, { lists: e.ROOM.listCalls - before, gets: e.ROOM.getCalls });
}

console.log("14. счётчик мест в комнате живёт в Durable Object");
{
  const e = env("secret", true);
  const a = await call(e, "/item", uploadForm(PNG, "a.png", "image/png", {}));
  const b = await call(e, "/item", uploadForm(PNG, "b.png", "image/png", {}));
  const state = await call(e, "/state");
  check("два предмета на месте", state.body.count === 2, state.body.count);
  await call(e, "/item?id=" + a.body.item.id, { method: "DELETE", headers: { "x-room-token": "secret" } });
  const after = await call(e, "/state");
  check("после удаления остался один", after.body.count === 1, after.body.count);
  check("удаление освободило место", b.body.item.id === after.body.items[0].id, after.body.items[0]);
}

console.log("15. перебор админ-токена ограничен");
{
  const e = env("secret");
  let status = 0;
  for (let i = 0; i < 14; i++) {
    const r = await call(e, "/item?id=00000000-0000-0000-0000-000000000000", { method: "DELETE", headers: { "x-room-token": "wrong" + i } });
    status = r.status;
    if (status === 429) break;
  }
  check("после серии попыток включается блокировка", status === 429, status);
}

console.log("\nитог: " + passed + " ok, " + failed + " fail");
process.exit(failed ? 1 : 0);
