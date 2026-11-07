/**
 * Локальный запуск Worker-а «Общей комнаты» без Cloudflare.
 * Тот же код, что и в worker.js, но хранилище в памяти и обычный HTTP-сервер.
 * Запуск: node server/local-server.mjs [порт]
 */
import http from "node:http";
import worker from "./worker.js";

const PORT = Number(process.argv[2] || 8787);

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { const e = this.map.get(key); return e ? e.value : null; }
  async getWithMetadata(key) {
    const e = this.map.get(key);
    if (!e) return null;
    return { value: e.value, metadata: e.metadata };
  }
  async put(key, value, opts) { this.map.set(key, { value, metadata: opts && opts.metadata }); }
  async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => this.map.delete(k)); }
  async list(opts) {
    const prefix = (opts && opts.prefix) || "";
    const limit = (opts && opts.limit) || 1000;
    const keys = [];
    for (const [name, entry] of this.map) {
      if (name.startsWith(prefix)) keys.push({ name, metadata: entry.metadata });
      if (keys.length >= limit) break;
    }
    return { keys, list_complete: true };
  }
}

const env = { ROOM: new MemoryKV(), ROOM_ADMIN_TOKEN: process.env.ROOM_ADMIN_TOKEN || "local-admin" };

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) headers[key] = value;
  const request = new Request("http://127.0.0.1:" + PORT + req.url, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("комната слушает http://127.0.0.1:" + PORT);
});
