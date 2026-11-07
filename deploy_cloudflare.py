#!/usr/bin/env python3
"""
Деплой «Общей комнаты» в Cloudflare через подключение Mavis (коннектор Cloudflare).

Нужен переподключённый Cloudflare с правами:
  workers-kv-storage.write   — создать пространство KV
  workers-scripts.write      — загрузить Worker и его секрет

Скрипт сам:
  1. создаёт пространство KV;
  2. загружает worker.js (модуль) с привязками KV и Durable Object;
  3. ставит секрет ROOM_ADMIN_TOKEN;
  4. узнаёт адрес workers.dev и печатает, что вписать в страницу.

Запуск:  python3 deploy_cloudflare.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, 'server', 'worker.js')
ADMIN_TOKEN = os.environ.get('ROOM_ADMIN_TOKEN') or os.environ.get('CF_ADMIN_TOKEN')
SCRIPT_NAME = 'svp-room'


def connector(args_file):
    """Дергает коннектор Cloudflare через mcode-tools."""
    proc = subprocess.run(
        ['mcode-tools', 'connector', 'call', 'connector__cloudflare__execute', '--args-file', args_file],
        capture_output=True, text=True, timeout=600)
    out = proc.stdout.strip()
    if proc.returncode != 0:
        print('Ошибка коннектора:', (proc.stderr or out)[:600])
        sys.exit(1)
    try:
        data = json.loads(out)
    except Exception:
        data = json.loads(out[out.find('{'):]) if '{' in out else {}
    if isinstance(data, list) and data and isinstance(data[0], dict) and 'text' in data[0]:
        data = json.loads(data[0]['text'])
    return data


def call(code, label):
    path = '/tmp/cf-deploy-call.json'
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump({'code': code}, fh, ensure_ascii=False)
    print('  ...', label)
    return connector(path)


def main():
    token = ADMIN_TOKEN
    if not token:
        token_file = '/workspace/.secrets/room-admin.txt'
        if os.path.exists(token_file):
            with open(token_file, encoding='utf-8') as fh:
                token = fh.read().strip()
    if not token:
        print('Нужен секрет оператора: положим его в /workspace/.secrets/room-admin.txt '
              'или в переменную окружения ROOM_ADMIN_TOKEN.')
        sys.exit(1)

    with open(WORKER, encoding='utf-8') as fh:
        worker_code = fh.read()

    # 1. пространство KV
    print('1/4 создаю пространство KV')
    res = call("async () => { const r = await cloudflare.request({ method: 'POST', path: "
               "`/accounts/${accountId}/storage/kv/namespaces`, body: { title: 'svp-room' } }); "
               "return r.result; }", 'KV')
    namespace_id = (res or {}).get('id') if isinstance(res, dict) else None
    if not namespace_id:
        print('Не удалось создать пространство KV:', str(res)[:300])
        sys.exit(1)
    print('   id:', namespace_id)

    # 2. Worker с привязками
    print('2/4 загружаю Worker')
    meta = {
        'main_module': 'worker.js',
        'compatibility_date': '2024-11-01',
        'bindings': [
            {'type': 'kv_namespace', 'name': 'ROOM', 'namespace_id': namespace_id},
            {'type': 'durable_object', 'name': 'RATE_LIMITER', 'class_name': 'RateLimiter'},
        ],
        'migrations': [{'tag': 'v1', 'new_sqlite_classes': ['RateLimiter']}],
    }
    payload = {
        'metadata': meta,
        'code': worker_code,
        'secret': token,
        'name': SCRIPT_NAME,
    }
    with open('/tmp/cf-worker-payload.json', 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False)

    code = """async () => {
  const payload = %s;
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(payload.metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([payload.code], { type: 'application/javascript+module' }), 'worker.js');
  const r = await cloudflare.request({ method: 'PUT', path: `/accounts/${accountId}/workers/scripts/${payload.name}`, body: form });
  return { success: r.success, errors: r.errors, result: r.result };
}""" % json.dumps(payload, ensure_ascii=False)
    res = call(code, 'Worker')
    if isinstance(res, dict) and res.get('success') is False:
        print('Worker не загрузился:', json.dumps(res.get('errors'), ensure_ascii=False)[:400])
        sys.exit(1)
    print('   Worker загружен')

    # 3. секрет оператора
    print('3/4 ставлю секрет оператора')
    code = """async () => {
  const r = await cloudflare.request({ method: 'PUT', path: `/accounts/${accountId}/workers/scripts/${payload.name}/secrets`,
    body: { name: 'ROOM_ADMIN_TOKEN', text: payload.secret, type: 'secret_text' } });
  return { success: r.success, errors: r.errors };
}""" % json.dumps(payload, ensure_ascii=False)
    res = call(code, 'секрет')
    print('   секрет:', 'ок' if not isinstance(res, dict) or res.get('success') else str(res)[:200])

    # 4. адрес
    print('4/4 узнаю адрес workers.dev')
    res = call("async () => { const r = await cloudflare.request({ method: 'GET', path: "
               "`/accounts/${accountId}/workers/subdomain` }); return r.result; }", 'адрес')
    subdomain = (res or {}).get('subdomain') if isinstance(res, dict) else None
    url = 'https://%s.%s.workers.dev' % (SCRIPT_NAME, subdomain) if subdomain else None
    print()
    if url:
        print('🌐 Адрес сервера комнаты: ' + url)
        print('   Впишите его в index.html: var ROOM_API = "' + url + '";')
    else:
        print('Поддомен workers.dev недоступен:', str(res)[:200])
    print('🔑 Секрет оператора сохранён в /workspace/.secrets/room-admin.txt')


if __name__ == '__main__':
    main()
