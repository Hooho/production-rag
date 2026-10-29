"""通过 HTTP API 导入北海评测十二题；语料须已上传并完成导入。"""

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


MATERIALS = Path(__file__).resolve().parents[1] / "eval/benchmarks/beihai"


def normalized(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def load_materials():
    spec = json.loads((MATERIALS / "questions.json").read_text(encoding="utf-8"))
    text = (MATERIALS / "corpus/北海慢游指南.md").read_bytes().decode("utf-8-sig")
    if hashlib.sha256(text.encode()).hexdigest() != spec["corpus_sha256"]:
        raise ValueError("本地指南与 questions.json 版本不同，请使用同一提交的材料")
    parts = re.split(r"^## (B\d{3})｜[^\n]+\n", text, flags=re.M)
    sections = {parts[i]: normalized(parts[i + 1]) for i in range(1, len(parts), 2)}
    return spec, sections


def match_section(title, section_id, section, catalog):
    """每个实际分片分别计分，避免小分片被错误地当成可互换证据。"""
    matches = []
    for row in catalog:
        if row["title"] != title:
            continue
        body = normalized(row["quote"])
        start = section.find(body) if body else -1
        if start < 0:
            continue
        if section.count(body) != 1:
            raise ValueError(f"{section_id} 的分片正文重复，无法唯一定位")
        if hashlib.sha256(body.encode()).hexdigest() != row["fingerprint"]:
            raise ValueError(f"{section_id} 的分片指纹不一致，请重新导入语料")
        matches.append((start, start + len(body), row))
    covered = 0
    for start, end, _ in sorted(matches, key=lambda match: match[:2]):
        if start > covered:
            break
        covered = max(covered, end)
    if covered != len(section):
        raise ValueError(f"{section_id} 未找到完整分片，请确认指南版本且已完成导入")
    targets = [
        row for _, _, row in sorted(matches, key=lambda match: match[2]["position"])
    ]
    if len({row["position"] for row in targets}) != len(targets):
        raise ValueError(f"{section_id} 分片位置重复，未执行导入")
    return targets


def build_items(spec, sections, catalog):
    result = []
    for item in spec["items"]:
        groups = []
        for scoring in item["scoring_items"]:
            section_id = scoring["section"]
            targets = match_section(
                spec["title"], section_id, sections[section_id], catalog
            )
            for index, target in enumerate(targets, 1):
                label = scoring["label"]
                if len(targets) > 1:
                    label = f"{label}（{index}/{len(targets)}）"
                groups.append({"label": label, "targets": [target]})
        if not 1 <= len(groups) <= 10:
            raise ValueError(
                f"{item['id']} 需要 {len(groups)} 个计分项，超过 API 上限；请用 400/40 重新导入指南"
            )
        result.append(
            {
                "question": item["question"],
                "type": item["type"],
                "reference_answer": item["reference_answer"],
                "evidence_groups": groups,
            }
        )
    return result


def signature(item):
    return {
        "question": item["question"],
        "type": item.get("type"),
        "reference_answer": item.get("reference_answer"),
        "evidence_groups": [
            {
                "label": group["label"],
                "targets": sorted(
                    (row["title"], row["position"], row["fingerprint"])
                    for row in group["targets"]
                ),
            }
            for group in item.get("evidence_groups", [])
        ],
    }


def import_questions(api, spec, sections, suite_name, dry_run=False):
    entries = [
        row
        for row in api("GET", "/eval/corpus")["items"]
        if row["title"] == spec["title"]
    ]
    if len(entries) != 1:
        raise ValueError(f"请先在评测语料库上传《{spec['title']}》")
    entry = entries[0]
    if entry.get("missing") or entry["status"] != "imported":
        raise ValueError(f"语料状态为 {entry['status']}，请先点击“导入”并等待完成")
    if entry["sha256"] != spec["corpus_sha256"]:
        raise ValueError("服务器上的指南与本地材料版本不同，未创建专项或题目")
    items = build_items(spec, sections, api("GET", "/eval/target-chunks")["items"])
    matches = [
        row for row in api("GET", "/eval/suites")["items"] if row["name"] == suite_name
    ]
    if len(matches) > 1:
        raise ValueError("存在多个同名专项，未执行导入")
    suite = (
        api("GET", f"/eval/suites/{quote(matches[0]['id'], safe='')}")
        if matches
        else None
    )
    if suite and (suite["method"] != "retrieval" or suite["search_mode"] != "hybrid"):
        raise ValueError("同名专项不是混合检索专项，请使用 --suite-name 指定其他名称")
    pending = []
    for item in items:
        existing = [
            row
            for row in (suite or {}).get("items", [])
            if row["question"] == item["question"]
        ]
        if len(existing) > 1 or (
            existing and signature(existing[0]) != signature(item)
        ):
            raise ValueError(
                f"同题内容或目标分片冲突，未执行导入：{item['question']}；可用 --suite-name 新建专项"
            )
        if not existing:
            pending.append(item)
    print(
        f"检查通过：{len(items)} 道题，新增 {len(pending)} 道，跳过 {len(items) - len(pending)} 道相同题"
    )
    for item in pending:
        print(
            f"  {item['type']} · {len(item['evidence_groups'])} 个计分项 · {item['question']}"
        )
    if dry_run:
        print("预检查完成，未创建专项或题目。")
        return
    if suite is None:
        suite = api(
            "POST",
            "/eval/suites",
            {
                "name": suite_name,
                "description": spec["description"],
                "method": "retrieval",
                "search_mode": "hybrid",
            },
        )
    suite_id = quote(suite["id"], safe="")
    for item in pending:
        api("POST", f"/eval/suites/{suite_id}/items", item)
        print(f"已导入：{item['type']} · {item['question']}")
    # 用服务端保存的数据验证结果，而不是仅统计成功发送的请求。
    saved = api("GET", f"/eval/suites/{suite_id}")
    for item in items:
        rows = [row for row in saved["items"] if row["question"] == item["question"]]
        if len(rows) != 1 or signature(rows[0]) != signature(item):
            raise ValueError("写入后的核对不一致；已写入内容保留，请检查专项")
    print(f"完成：专项「{suite_name}」，已核对十二道题；专项 ID：{saved['id']}")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_api(base_url, token=""):
    parsed = urlsplit(base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("--base-url 需要 HTTP(S) API 地址，不包含账号、查询参数或片段")
    # 不跟随重定向，避免把 Authorization 发到其他地址。
    opener = build_opener(NoRedirect())

    def api(method, path, body=None):
        data = (
            json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        )
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(
            base_url.rstrip("/") + path, data=data, headers=headers, method=method
        )
        try:
            with opener.open(request, timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            detail = ""
            if path != "/auth/login":
                try:
                    detail = str(json.load(error).get("detail", ""))[:400]
                except (ValueError, AttributeError):
                    pass
            raise ValueError(
                f"{method} {path} 返回 HTTP {error.code} {detail}".strip()
            ) from None
        except URLError:
            raise ValueError(f"无法连接 {base_url}，请确认 API 地址和网络") from None

    return api


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url", default="http://127.0.0.1:8000", help="API 地址，可带反向代理前缀"
    )
    parser.add_argument(
        "--username", default="admin", help="管理员用户名；交互输入密码"
    )
    parser.add_argument(
        "--suite-name", default="北海旅游三类检索", help="创建或复用的专项名称"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="只鉴权和预检查，不创建专项或题目"
    )
    args = parser.parse_args()
    if not args.suite_name.strip() or len(args.suite_name.strip()) > 64:
        parser.error("专项名称需要 1 至 64 个字符")
    try:
        spec, sections = load_materials()
        token = os.environ.get("BEIHAI_API_TOKEN", "").strip()
        if not token:
            password = getpass.getpass(f"管理员 {args.username} 的密码：")
            token = make_api(args.base_url)(
                "POST",
                "/auth/login",
                {
                    "username": args.username,
                    "password": password,
                },
            )["access_token"]
        import_questions(
            make_api(args.base_url, token),
            spec,
            sections,
            args.suite_name.strip(),
            args.dry_run,
        )
    except (ValueError, OSError) as error:
        print(
            f"导入停止：{error}\n已成功写入的题目不会回滚；修正后重复运行会跳过相同题目。",
            file=sys.stderr,
        )
        return 1
    except (KeyboardInterrupt, EOFError):
        print("已取消。已写入题目保留，可重复运行继续。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
