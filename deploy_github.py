#!/usr/bin/env python3
"""
Выкладка «Системного Детектива» на GitHub Pages через REST API.

Использование:
    python3 deploy_github.py [--repo svp-detective] [--dir .]

Что делает:
  1. проверяет, кому принадлежит токен (GITHUB_TOKEN из окружения);
  2. создаёт публичный репозиторий, если его ещё нет;
  3. кладёт содержимое папки одним коммитом через Git Data API;
  4. удаляет из репозитория файлы, которых больше нет локально;
  5. включает GitHub Pages и печатает живой адрес.

Токен в логи не попадает: он уходит только в заголовке Authorization.
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"


def request(method, path, token, payload=None, raw=False):
    url = path if path.startswith("http") else API + path
    data = None
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "svp-detective-deploy",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            body = res.read()
            return res.status, (body if raw else (json.loads(body) if body else {}))
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"message": body[:200].decode("utf-8", "replace")}
        return e.code, parsed


def collect_files(root):
    """Список файлов для публикации: относительный путь → байты."""
    skip_dirs = {".git", "node_modules", ".hallmark", ".mavis", ".skills", ".plugin-cache"}
    skip_names = {"svp-room-server.zip"}
    files = {}
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for name in names:
            if name.startswith(".") and name != ".nojekyll":
                continue
            if name in skip_names:
                continue
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as fh:
                files[rel] = fh.read()
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="svp-detective")
    ap.add_argument("--dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--description", default="Системный Детектив: интерактивное пособие по СВП с общей комнатой")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("Нет переменной GITHUB_TOKEN в окружении.")
        sys.exit(1)

    status, user = request("GET", "/user", token)
    if status != 200:
        print("Токен не принят GitHub:", user.get("message"))
        sys.exit(1)
    owner = user["login"]
    print("1/5 токен работает, аккаунт:", owner)

    full = owner + "/" + args.repo
    status, repo = request("GET", "/repos/" + full, token)
    if status == 404:
        status, repo = request("POST", "/user/repos", token, {
            "name": args.repo,
            "description": args.description,
            "private": False,
            "auto_init": False,
            "has_issues": False,
        })
        if status not in (200, 201):
            print("Не удалось создать репозиторий:", repo.get("message"))
            sys.exit(1)
        print("2/5 репозиторий создан:", full, "(публичный)")
    elif status == 200:
        print("2/5 репозиторий уже есть:", full, "| visibility:", repo.get("visibility"))
        if repo.get("visibility") != "public":
            print("Внимание: на бесплатном тарифе Pages работает только для публичных репозиториев.")
    else:
        print("Не удалось прочитать репозиторий:", repo.get("message"))
        sys.exit(1)

    files = collect_files(args.dir)
    if "index.html" not in files:
        print("В папке нет index.html — публиковать нечего.")
        sys.exit(1)
    files.setdefault(".nojekyll", b"")
    print("3/5 файлов к публикации:", len(files))

    # пустой репозиторий: первый файл кладём через contents, дальше работаем с git-деревом
    status, probe = request("GET", "/repos/%s/commits?per_page=1" % full, token)
    if status != 200:
        status, first = request("PUT", "/repos/%s/contents/index.html" % full, token, {
            "message": "Системный Детектив: первый коммит",
            "content": base64.b64encode(files["index.html"]).decode("ascii"),
            "branch": "main",
        })
        if status not in (200, 201):
            print("Не удалось положить первый файл:", first.get("message"))
            sys.exit(1)
        print("3.5 первый коммит создан через contents")

    # ветка и базовое дерево
    status, ref = request("GET", "/repos/%s/git/ref/heads/main" % full, token)
    if status == 404:
        status, ref = request("GET", "/repos/%s/git/ref/heads/master" % full, token)
        branch = "master" if status == 200 else "main"
    else:
        branch = "main"
    base_sha = ref["object"]["sha"] if status == 200 else None

    entries = []
    for rel, data in files.items():
        status, blob = request("POST", "/repos/%s/git/blobs" % full, token, {
            "content": base64.b64encode(data).decode("ascii"),
            "encoding": "base64",
        })
        if status not in (200, 201):
            print("Не удалось загрузить", rel, blob.get("message"))
            sys.exit(1)
        entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})

    # файлы, которые были в репозитории, но исчезли локально
    if base_sha:
        status, tree = request("GET", "/repos/%s/git/trees/%s?recursive=1" % (full, base_sha), token)
        if status == 200:
            local = set(files.keys())
            for node in tree.get("tree", []):
                if node.get("type") != "blob":
                    continue
                if node["path"] not in local:
                    entries.append({"path": node["path"], "mode": "100644", "type": "blob", "sha": None})

    tree_payload = {"base_tree": base_sha} if base_sha else {}
    tree_payload["tree"] = entries
    status, new_tree = request("POST", "/repos/%s/git/trees" % full, token, tree_payload)
    if status not in (200, 201):
        print("Не удалось собрать дерево:", new_tree.get("message"))
        sys.exit(1)

    status, commit = request("POST", "/repos/%s/git/commits" % full, token, {
        "message": "Системный Детектив: общая комната и свежая сборка",
        "tree": new_tree["sha"],
        "parents": [base_sha] if base_sha else [],
    })
    if status not in (200, 201):
        print("Не удалось создать коммит:", commit.get("message"))
        sys.exit(1)

    if base_sha:
        status, updated = request("PATCH", "/repos/%s/git/refs/heads/%s" % (full, branch), token, {
            "sha": commit["sha"], "force": True,
        })
    else:
        status, updated = request("POST", "/repos/%s/git/refs" % full, token, {
            "ref": "refs/heads/" + branch, "sha": commit["sha"],
        })
    if status not in (200, 201):
        print("Не удалось обновить ветку:", updated.get("message"))
        sys.exit(1)
    print("4/5 коммит сделан:", commit["sha"][:10], "ветка:", branch)

    status, pages = request("POST", "/repos/%s/pages" % full, token, {
        "source": {"branch": branch, "path": "/"},
    })
    if status not in (200, 201, 409):
        print("Pages не включились:", pages.get("message"))
        sys.exit(1)
    if status == 409:
        status, pages = request("GET", "/repos/%s/pages" % full, token)

    url = pages.get("html_url") or ("https://%s.github.io/%s/" % (owner, args.repo))
    print("5/5 Pages:", url)

    print("\nСборка идёт, обычно 30–60 секунд. Проверяю…")
    for _ in range(12):
        time.sleep(10)
        status, pages = request("GET", "/repos/%s/pages" % full, token)
        state = (pages.get("build") or {}).get("status") or pages.get("status")
        if state in ("built", "ready"):
            print("Сборка готова:", url)
            break
        print("  статус сборки:", state)
    else:
        print("Сборка ещё идёт, адрес всё равно уже работает:", url)

    print("\n🌐 Сайт: " + url)
    print("📦 Репозиторий: https://github.com/" + full)


if __name__ == "__main__":
    main()
