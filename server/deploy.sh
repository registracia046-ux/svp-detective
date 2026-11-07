#!/usr/bin/env bash
# Публикация общей комнаты в Cloudflare Workers.
# Нужен Node.js 18+ и аккаунт Cloudflare.
set -euo pipefail
cd "$(dirname "$0")"

echo "1/5 проверяю вход в Cloudflare"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Войдите в аккаунт: откроется браузер, нажмите «Allow»."
  npx wrangler login
fi

echo "2/5 создаю пространство KV для картинок"
OUT=$(npx wrangler kv namespace create ROOM 2>&1 || true)
echo "$OUT"
ID=$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1 || true)
if [ -z "$ID" ]; then
  echo "Не удалось получить id пространства. Создайте его вручную и впишите id в wrangler.toml."
  exit 1
fi
sed -i.bak "s|^id = \".*\"|id = \"$ID\"|" wrangler.toml
rm -f wrangler.toml.bak
echo "Пространство KV: $ID"

echo "3/5 генерирую секрет администратора"
TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
echo "Секрет оператора (сохраните его, он не показывается в интерфейсе Cloudflare):"
echo "  $TOKEN"
echo "$TOKEN" | npx wrangler secret put ROOM_ADMIN_TOKEN

echo "4/5 публикую Worker"
npx wrangler deploy

echo "5/5 готово"
cat <<EOF

Worker опубликован. Адрес будет вида https://svp-room.<ваш-поддомен>.workers.dev
Впишите его в index.html: строка var ROOM_API = ""; в самом низу файла.
Секрет оператора: $TOKEN
EOF
