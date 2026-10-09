"""静态演示快照的脱敏：导出前把文档、问答里出现的登录凭证、密钥一类的值换成 ***。

快照会公开部署，知识库里的文档原文、分片、上下文说明都会原样展示；文档里如果有抓包日志、
配置文件之类的内容，里面的 Cookie、Token、签名就会跟着公开。这里按两类规则处理：
1. 键名像凭证的键值对（"cookie": "…"、x-xxx-token: …、sign=…），把值换掉；
2. 不看键名，看起来就是凭证的值：JWT、sk- / hf_ / ghp_ 开头的密钥，以及很长的、
   字母数字混在一起的串（分片可能从凭证中间切开，前面没有键名）。
编号、哈希这类页面要用来关联数据的字段（键名在 KEEP_KEYS 里）不处理。

导出脚本会自动调用这里（需要容器里有这个文件，改过之后要重新构建 api 镜像）；也可以单独运行，
处理一份已经导出的快照，传 - 表示从标准输入读：
    python3 scripts/demo_scrub.py snapshot.new.json > snapshot.clean.json
    docker-compose exec -T api python - < scripts/export_static_demo.py | python3 scripts/demo_scrub.py - > snapshot.new.json
"""

from __future__ import annotations

import json
import re
import sys

MASK = "***"

# 键名里出现这些词就当成凭证。
SECRET_NAME = r"[\w.-]*(?:cookie|token|sign|salt|secret|passw(?:or)?d|auth|api[_-]?key|apikey|session|ssid|ticket|credential)[\w.-]*"
# "name": "value"（JSON、抓包日志里的请求头）
QUOTED_PAIR = re.compile(rf'("{SECRET_NAME}"\s*:\s*")([^"]*)(")', re.I)
# name: value / name=value（请求头、查询参数、.env），值到行尾或分隔符为止
PLAIN_PAIR = re.compile(rf'(?<![\w-])({SECRET_NAME}\s*[:=]\s*)(?!\s*["{{\[])([^\s,;&"\'}}\]]+)', re.I)
KNOWN_SECRETS = re.compile(
    r"\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}"     # JWT / base64 JSON
    r"|\bsk-[A-Za-z0-9_-]{16,}|\bhf_[A-Za-z0-9]{20,}"
    r"|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bAKIA[0-9A-Z]{16}"
)
# 很长、没有空格、字母和数字混在一起的串：多半是 Token、签名或编码过的凭证。
LONG_OPAQUE = re.compile(r"(?<![A-Za-z0-9+/=%|_-])(?=[A-Za-z0-9+/=%|_-]*[0-9])(?=[A-Za-z0-9+/=%|_-]*[A-Za-z])[A-Za-z0-9+/=%|_-]{32,}")

# 页面用来关联数据的编号、哈希，不能改。
KEEP_KEYS = {"id", "document_id", "chunk_id", "chunk_key", "doc_key", "session_id", "request_id", "run_id", "issue_id",
    "review_id", "set_id", "suite_id", "batch_id", "pair_id", "sha256", "content_sha256", "hash", "reused_from", "trace_id"}


def scrub_text(text: str) -> str:
    text = QUOTED_PAIR.sub(lambda m: m.group(1) + MASK + m.group(3), text)
    text = PLAIN_PAIR.sub(lambda m: m.group(1) + MASK, text)
    text = KNOWN_SECRETS.sub(MASK, text)
    return LONG_OPAQUE.sub(lambda m: m.group(0) if looks_readable(m.group(0)) else MASK, text)


# 长串里有用分隔符隔开的完整单词（接口路径、模型名、UUID 这类），不是凭证。
def looks_readable(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f-]{36}", value) or re.search(r"(?:^|[/._-])[A-Za-z]{4,}(?=$|[/._-])", value))


def scrub(value, key=None):
    if isinstance(value, dict):
        return {k: scrub(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, key) for v in value]
    if isinstance(value, str) and key not in KEEP_KEYS and not str(key).endswith("_id"):
        return scrub_text(value)
    return value


if __name__ == "__main__":
    data = json.load(sys.stdin if sys.argv[1] == "-" else open(sys.argv[1], encoding="utf-8"))
    print(json.dumps(scrub(data), ensure_ascii=False, separators=(",", ":"), default=str))
