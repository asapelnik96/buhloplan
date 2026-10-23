#!/usr/bin/env python3
"""Загрузка афиши и мест в Supabase (нужен сервисный ключ).

  SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=... python3 scripts/upload_docs.py data/docs.json --prune promos,venues

Файл — JSON-массив: {"collection":"promos","id":"most-ladies-tue","data":{...}}.
Чтобы удалить запись: {"collection":"promos","id":"old-promo","delete":true}.
--prune promos,venues — удалить из этих коллекций всё, чего нет в файле (файл = полный список).
"""
import json, os, sys, urllib.request, urllib.parse

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

def get(path):
    r = urllib.request.Request(URL + "/rest/v1/" + path, headers=H)
    with urllib.request.urlopen(r) as resp:
        return json.loads(resp.read())

def req(method, path, body=None, extra=None):
    r = urllib.request.Request(URL + "/rest/v1/" + path, method=method,
                               data=None if body is None else json.dumps(body, ensure_ascii=False).encode(),
                               headers={**H, **(extra or {})})
    with urllib.request.urlopen(r) as resp:
        return resp.status

docs = json.load(open(sys.argv[1], encoding="utf-8"))
ups = [{"collection": d["collection"], "id": d["id"], "data": d["data"]} for d in docs if not d.get("delete")]
dels = [d for d in docs if d.get("delete")]
if "--prune" in sys.argv:
    cols = sys.argv[sys.argv.index("--prune") + 1].split(",")
    keep = {(d["collection"], d["id"]) for d in ups}
    for c in cols:
        for row in get("docs?" + urllib.parse.urlencode({"select": "id", "collection": f"eq.{c}", "limit": "5000"})):
            if (c, row["id"]) not in keep:
                dels.append({"collection": c, "id": row["id"]})
for i in range(0, len(ups), 200):
    req("POST", "docs?on_conflict=collection,id", ups[i:i+200],
        {"Prefer": "resolution=merge-duplicates,return=minimal"})
for d in dels:
    q = urllib.parse.urlencode({"collection": f"eq.{d['collection']}", "id": f"eq.{d['id']}"})
    req("DELETE", "docs?" + q)
print(f"Загружено: {len(ups)}, удалено: {len(dels)}")
