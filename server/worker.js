/**
 * Общая комната «Системного Детектива» — Worker (Cloudflare Workers + KV + Durable Object).
 *
 * Что делает:
 *   GET    /state          список предметов в комнате (метаданные из ключей KV, без чтения картинок)
 *   POST   /item           загрузка предмета (multipart: file, x, y, w, author, vector)
 *   DELETE /item?id=...    удаление предмета: админ-токеном или личным ключом автора
 *   GET    /media/{id}     отдача картинки (одно чтение KV, без списка)
 *   GET    /admin/items    полный список для модерации (админ-токен)
 *   GET    /               служебная информация
 *
 * Хранилище: KV namespace. Ключи:
 *   m/{id}                 байты картинки, тип лежит в метаданных ключа
 *   i/{id}/{base64url}     индекс: метаданные прямо в имени, поэтому комната читается одним list()
 *   rate/{дата}/{ip}/...   маркеры загрузок за день (expirationTtl 2 суток)
 *
 * Ограничения: только растровые форматы (png/jpeg/gif/webp/avif), до 8 МБ,
 * тип определяется по сигнатуре файла, а не по заголовку клиента, до 10 загрузок
 * в сутки с одного адреса, до 300 предметов в комнате, SVG не принимается,
 * файлы с EXIF-метаданными отклоняются.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PER_DAY = 10;
const MAX_ITEMS = 300;
const RATE_TTL = 172800;
const ITEM_TTL = 2592000;
const STATE_TTL_MS = 10000;
const ADMIN_FAIL_LIMIT = 12;
const ADMIN_FAIL_WINDOW = 900;
const IMG_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif"
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-room-token",
    "access-control-max-age": "86400"
  };
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, corsHeaders())
  });
}

function b64url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text) {
  let s = text.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Определяет формат по сигнатуре, а не по заявленному клиентом MIME. */
function sniffType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand.indexOf("avif") !== -1 || brand.indexOf("avis") !== -1) return "avif";
  }
  return null;
}

/**
 * Поиск маркеров EXIF/XMP в байтах: GPS-координаты из телефона не должны
 * попадать в публичную комнату. Форма через интерфейс чистит метаданные
 * сама, мимо формы такие файлы не принимаются.
 */
function findMarker(bytes, marker) {
  for (let i = 0; i + marker.length <= bytes.length; i++) {
    let hit = true;
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) { hit = false; break; }
    }
    if (hit) return i;
  }
  return -1;
}

function hasMetadata(bytes, type) {
  if (type === "jpg") {
    return findMarker(bytes, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) !== -1;
  }
  if (type === "png") {
    return findMarker(bytes, [0x65, 0x58, 0x49, 0x66]) !== -1;
  }
  if (type === "webp") {
    return findMarker(bytes, [0x45, 0x58, 0x49, 0x46, 0x20]) !== -1;
  }
  return false;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Сравнение строк за постоянное время: время ответа не зависит от длины совпадения. */
function safeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    diff |= (left.charCodeAt(i % (left.length || 1)) || 0) ^ (right.charCodeAt(i % (right.length || 1)) || 0);
  }
  return diff === 0 && left.length > 0;
}

function indexKey(meta) {
  const compact = JSON.stringify({
    t: meta.type,
    b: meta.bytes,
    x: meta.x,
    y: meta.y,
    w: meta.w,
    a: meta.author,
    v: meta.vector,
    s: meta.secret,
    c: meta.createdAt
  });
  return "i/" + meta.id + "/" + b64url(compact);
}

function readIndexKey(name) {
  const parts = name.split("/");
  if (parts.length < 3) return null;
  try {
    const meta = JSON.parse(unb64url(parts.slice(2).join("/")));
    if (!meta || !meta.t) return null;
    return {
      id: parts[1],
      type: meta.t,
      bytes: meta.b,
      x: meta.x,
      y: meta.y,
      w: meta.w,
      author: meta.a || "",
      vector: meta.v || "",
      secret: meta.s || "",
      createdAt: meta.c,
      url: "/media/" + parts[1]
    };
  } catch (e) {
    return null;
  }
}

/** Публичный вид предмета: личный ключ автора наружу не уходит. */
function publicItem(item) {
  return {
    id: item.id,
    type: item.type,
    bytes: item.bytes,
    x: item.x,
    y: item.y,
    w: item.w,
    author: item.author,
    vector: item.vector,
    createdAt: item.createdAt,
    url: item.url
  };
}

let stateCache = { at: 0, items: null };

/**
 * Дневной лимит загрузок: основной путь через Durable Object, счётчик там
 * атомарен, поэтому пачка параллельных запросов лимит не обходит.
 * Если привязки нет (локальный запуск), включается запасной счётчик на маркерах
 * в KV: он держит лимит на последовательных запросах, параллельный заход
 * может дать небольшой перебор.
 */
async function allowUpload(env, ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.idFromName === "function") {
    try {
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("ip-" + ip));
      const answer = await stub.fetch("https://rate/" + encodeURIComponent(ip));
      if (answer.status === 429) { return false; }
      if (answer.ok) { return true; }
    } catch (error) {
      console.error("Durable Object недоступен, лимит считается по маркерам:", error && error.message);
    }
  }
  const prefix = "rate/" + day + "/" + ip + "/";
  const marks = await env.ROOM.list({ prefix: prefix, limit: MAX_PER_DAY + 1 });
  if (marks.keys.length >= MAX_PER_DAY) { return false; }
  await env.ROOM.put(prefix + crypto.randomUUID(), "1", { expirationTtl: RATE_TTL });
  return true;
}

/**
 * Место в комнате: счётчик предметов тоже живёт в Durable Object, поэтому
 * лимит 300 предметов не обходится параллельными загрузками.
 */
async function reserveSlot(env) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.idFromName === "function") {
    try {
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("room-items"));
      const answer = await stub.fetch("https://count?action=inc");
      if (answer.status === 409) { return false; }
      if (answer.ok) { return true; }
    } catch (error) {
      console.error("Durable Object недоступен, лимит комнаты считается по списку:", error && error.message);
    }
  }
  const current = await listItems(env, true);
  return current.length < MAX_ITEMS;
}

async function releaseSlot(env) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.idFromName === "function") {
    try {
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("room-items"));
      await stub.fetch("https://count?action=dec");
    } catch (error) {
      console.error("Не удалось вернуть место в комнате:", error && error.message);
    }
  }
}

/** Неудачные попытки входа оператора ограничиваем по адресу. */
async function noteAdminFailure(env, ip) {
  const prefix = "afail/" + Math.floor(Date.now() / 1000 / ADMIN_FAIL_WINDOW) + "/" + ip + "/";
  await env.ROOM.put(prefix + crypto.randomUUID(), "1", { expirationTtl: RATE_TTL });
  const marks = await env.ROOM.list({ prefix: prefix, limit: ADMIN_FAIL_LIMIT + 1 });
  return marks.keys.length >= ADMIN_FAIL_LIMIT;
}

async function listItems(env, fresh) {
  if (!fresh && stateCache.items && Date.now() - stateCache.at < STATE_TTL_MS) {
    return stateCache.items;
  }
  const listed = await env.ROOM.list({ prefix: "i/", limit: 500 });
  const items = [];
  for (const key of listed.keys) {
    const item = readIndexKey(key.name);
    if (item) items.push(item);
  }
  items.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
  stateCache = { at: Date.now(), items: items };
  return items;
}

async function handleUpload(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "anon";

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonResponse({ ok: false, error: "bad-form" }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return jsonResponse({ ok: false, error: "no-file" }, 400);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return jsonResponse({ ok: false, error: "empty" }, 400);
  if (bytes.length > MAX_BYTES) return jsonResponse({ ok: false, error: "too-big", max: MAX_BYTES }, 413);

  const type = sniffType(bytes);
  if (!type) return jsonResponse({ ok: false, error: "type" }, 415);
  if (hasMetadata(bytes, type)) {
    return jsonResponse({ ok: false, error: "metadata", hint: "файл содержит служебные метаданные, загрузите через форму на сайте" }, 415);
  }

  // Лимит списывается только за настоящую загрузку: битый файл слот не съедает.
  if (!(await allowUpload(env, ip))) {
    return jsonResponse({ ok: false, error: "rate", limit: MAX_PER_DAY }, 429);
  }
  if (!(await reserveSlot(env))) {
    return jsonResponse({ ok: false, error: "full", limit: MAX_ITEMS }, 409);
  }

  const meta = {
    id: crypto.randomUUID(),
    type: type,
    bytes: bytes.length,
    x: clampNumber(form.get("x"), 0.02, 0.95, 0.2),
    y: clampNumber(form.get("y"), 0.02, 0.95, 0.2),
    w: clampNumber(form.get("w"), 0.06, 0.7, 0.22),
    author: cleanText(form.get("author"), 28),
    vector: cleanText(form.get("vector"), 28),
    secret: crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    createdAt: Date.now()
  };

  try {
    await env.ROOM.put("m/" + meta.id, bytes, {
      metadata: { t: meta.type },
      expirationTtl: ITEM_TTL
    });
    await env.ROOM.put(indexKey(meta), "1", { expirationTtl: ITEM_TTL });
  } catch (error) {
    await releaseSlot(env);
    return jsonResponse({ ok: false, error: "server" }, 500);
  }
  stateCache = { at: 0, items: null };

  return jsonResponse({ ok: true, item: publicItem(meta), secret: meta.secret }, 200);
}

async function handleDelete(request, env, url) {
  const token = request.headers.get("x-room-token") || "";
  const expected = env.ROOM_ADMIN_TOKEN || "";
  const id = url.searchParams.get("id") || "";
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return jsonResponse({ ok: false, error: "bad-id" }, 400);

  const listed = await env.ROOM.list({ prefix: "i/" + id + "/", limit: 10 });
  const keys = listed.keys.map(function (k) { return k.name; });
  const item = keys.length ? readIndexKey(keys[0]) : null;

  const isAdmin = expected && safeEqual(token, expected);
  const isAuthor = item && item.secret && safeEqual(token, item.secret);
  if (!isAdmin && !isAuthor) {
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    const blocked = await noteAdminFailure(env, ip);
    return jsonResponse({ ok: false, error: "forbidden" }, blocked ? 429 : 403);
  }

  const mediaKey = "m/" + id;
  const exists = await env.ROOM.get(mediaKey);
  if (exists !== null && exists !== undefined) { keys.push(mediaKey); }
  let removed = 0;
  if (keys.length) {
    await env.ROOM.delete(keys);
    removed = keys.length;
  }
  stateCache = { at: 0, items: null };
  await releaseSlot(env);
  return jsonResponse({ ok: true, removed: removed });
}

async function handleMedia(env, id) {
  const missing = new Response("not found", { status: 404, headers: corsHeaders() });
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return new Response("bad id", { status: 400, headers: corsHeaders() });
  const found = await env.ROOM.getWithMetadata("m/" + id);
  if (!found || !found.value) return missing;
  const type = IMG_TYPES[(found.metadata && found.metadata.t) || ""] || "application/octet-stream";
  return new Response(found.value, {
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*"
    }
  });
}

/**
 * Durable Object: дневной счётчик загрузок по адресу и счётчик предметов комнаты.
 * Обе операции атомарны: пачка параллельных запросов не проскакивает лимиты.
 */
export class RateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/count") {
      const action = url.searchParams.get("action") || "check";
      const stored = (await this.state.storage.get("items")) || null;
      let count = stored ? stored.n : 0;
      if (!stored || Date.now() - stored.at > 3600000) {
        const listed = await this.env.ROOM.list({ prefix: "i/", limit: 500 });
        count = listed.keys.length;
      }
      if (action === "inc") {
        if (count >= MAX_ITEMS) {
          await this.state.storage.put("items", { n: count, at: Date.now() });
          return new Response("full", { status: 409 });
        }
        await this.state.storage.put("items", { n: count + 1, at: Date.now() });
        return new Response("ok", { status: 200 });
      }
      if (action === "dec") {
        await this.state.storage.put("items", { n: Math.max(0, count - 1), at: Date.now() });
        return new Response("ok", { status: 200 });
      }
      return new Response(String(count), { status: 200 });
    }

    const day = new Date().toISOString().slice(0, 10);
    const stored = (await this.state.storage.get("counter")) || { day: day, count: 0 };
    if (stored.day !== day) {
      stored.day = day;
      stored.count = 0;
    }
    if (stored.count >= MAX_PER_DAY) {
      return new Response("limit", { status: 429 });
    }
    stored.count += 1;
    await this.state.storage.put("counter", stored);
    return new Response("ok", { status: 200 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      if (url.pathname === "/state" && request.method === "GET") {
        const items = await listItems(env);
        const visible = items.map(publicItem);
        return jsonResponse({ ok: true, count: visible.length, items: visible });
      }
      if (url.pathname === "/item" && request.method === "POST") {
        return await handleUpload(request, env);
      }
      if (url.pathname === "/item" && request.method === "DELETE") {
        return await handleDelete(request, env, url);
      }
      if (url.pathname.indexOf("/media/") === 0 && request.method === "GET") {
        return await handleMedia(env, url.pathname.slice(7));
      }
      if (url.pathname === "/admin/items" && request.method === "GET") {
        const token = request.headers.get("x-room-token") || "";
        if (!env.ROOM_ADMIN_TOKEN || !safeEqual(token, env.ROOM_ADMIN_TOKEN)) {
          return jsonResponse({ ok: false, error: "forbidden" }, 403);
        }
        const listed = await env.ROOM.list({ prefix: "i/", limit: 1000 });
        const all = [];
        for (const key of listed.keys) {
          const item = readIndexKey(key.name);
          if (item) { all.push(publicItem(item)); }
        }
        all.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        return jsonResponse({ ok: true, count: all.length, items: all });
      }
      if (url.pathname === "/" && request.method === "GET") {
        return jsonResponse({ ok: true, service: "svp-room", version: 2 });
      }
      return jsonResponse({ ok: false, error: "not-found" }, 404);
    } catch (error) {
      console.error("Ошибка обработки запроса:", error && error.message);
      return jsonResponse({ ok: false, error: "server" }, 500);
    }
  }
};
