import json, os, sys, urllib.request, urllib.parse

sys.path.insert(0, "/app")
from app.auth import create_access_token

token = create_access_token("admin", os.environ["JWT_SECRET"])
result = {}


def get(path):
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8000" + path, headers={"Authorization": "Bearer " + token}
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            value = json.load(r)
        result[path] = value
        return value
    except Exception as e:
        print(path + ": " + str(e), file=sys.stderr)
        return {}


from concurrent.futures import ThreadPoolExecutor

with ThreadPoolExecutor(max_workers=6) as pool:
    list(
        pool.map(
            get,
            [
                "/documents",
                "/graph/schemas",
                "/graph/overview",
                "/graph/tasks",
                "/graph/vectors",
                "/graph/experiments",
                "/graph/experiments/options",
                "/eval/config-templates",
            ],
        )
    )
docs = result["/documents"].get("documents", [])
paths = []
for d in docs:
    base = "/documents/" + d["document_id"] + "/graph"
    paths.extend(
        base + s
        for s in [
            "?view=network",
            "?view=entities",
            "?view=relations",
            "?view=merges",
            "/review",
            "/check",
        ]
    )
with ThreadPoolExecutor(max_workers=6) as pool:
    list(pool.map(get, paths))
paths = set()
for p, v in list(result.items()):
    if "?view=entities" not in p:
        continue
    doc = p.split("/")[2]
    entities = v.get("entities", {}).get("items", [])
    nodes = v.get("network", {}).get("nodes", [])
    for e in entities + nodes:
        eid = e["id"]
        paths.add("/graph/entities/" + eid)
        paths.add("/graph/entities/" + eid + "?document_id=" + doc)
for e in result.get("/graph/overview", {}).get("network", {}).get("nodes", []):
    eid = e["id"]
    paths.add("/graph/entities/" + eid)
    paths.add("/graph/overview?center=" + eid)
with ThreadPoolExecutor(max_workers=6) as pool:
    list(pool.map(get, paths))
paths = set()
for p, v in list(result.items()):
    network = v.get("network", {})
    doc = p.split("/")[2] if p.startswith("/documents/") else None
    for edge in network.get("edges", []):
        params = {"source_id": edge["source"], "target_id": edge["target"]}
        if doc:
            params["document_id"] = doc
        paths.add("/graph/relations?" + urllib.parse.urlencode(params))
        for category in edge.get("categories", []):
            paths.add(
                "/graph/relations?"
                + urllib.parse.urlencode({**params, "category": category})
            )
    if p.startswith("/graph/entities/"):
        for name in v.get("names", []):
            for cid in name.get("chunk_ids", []):
                paths.add("/chunks/" + urllib.parse.quote(cid, safe=""))
with ThreadPoolExecutor(max_workers=6) as pool:
    list(pool.map(get, paths))
print(json.dumps(result, ensure_ascii=False))
