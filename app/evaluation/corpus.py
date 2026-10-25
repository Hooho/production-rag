"""评测语料库：评测检索的文档。

以前评测语料就是仓库 eval/corpus 下的 .md 文件，所有评测共用，想加一份文档只能往目录里放文件，
放进去以后每个评测都会检索到它，旧题的结果跟着变；删掉文件，评测账号里导入过的文档也还在。
现在只有一种方式：在评测页维护语料库（表 eval_corpus）。
- 管理员上传 Markdown / 文本文件，文件存上传目录的 eval_corpus 下，表里记标题、文件名、指纹和字数；
- 初始语料放在 eval/seed/corpus（和初始题目 eval/seed 一样只用来初始化）：第一次用到语料库时复制一份进来，
  和上传的完全一样，之后不再自动登记，删了也不会回来；
- 评测开跑时勾选用哪几份（不勾就是全部）：只导入、只检索勾选的（见 app/tools/search.py 的 limit_titles）；
- 删除语料时，评测账号里导入过的这份文档、上传目录里的文件一起删掉。
"""
from hashlib import sha256
import os
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select

from ..mysql.store import document_heads, documents, eval_corpus, settings as settings_table
from ..runtime_config import bound_engine
from . import dataset

# 登记过初始语料后在 settings 表记一笔：之后把初始语料删掉也不会再登记回来。
SEED_KEY = "eval_corpus_seeded"
SUFFIXES = {".md", ".txt"}
MAX_BYTES = 5 * 1024 * 1024
TITLE_LENGTH = 200


class CorpusError(ValueError):
    pass


def storage_dir():
    return Path(os.getenv("UPLOAD_DIR", "./uploads")) / "eval_corpus"


# 初始语料：eval/seed/corpus 下的 Markdown 文件，文件名（去掉扩展名）作为标题。
def seed_files():
    return sorted((dataset.EVAL_DIR / "seed" / "corpus").glob("*.md"))


def text_fingerprint(text):
    return sha256(text.encode()).hexdigest()


# 把正文写进上传目录、在表里登记一份。上传和初始语料都走这里。
def store_entry(connection, title, filename, content, username):
    entry_id = str(uuid4())
    folder = storage_dir()
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{entry_id}{Path(filename).suffix.lower() or '.md'}"
    # 统一按 UTF-8 写（去掉 BOM），读的时候也按 UTF-8。
    target.write_text(content, encoding="utf-8")
    now = dataset.now_text()
    try:
        connection.execute(eval_corpus.insert().values(id=entry_id, title=title, filename=filename, path=str(target),
            sha256=text_fingerprint(content), char_count=len(content), created_by=username, created=now, updated=now))
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return entry_id


# 第一次用到语料库时，把 eval/seed/corpus 下的初始语料复制进来。
def ensure_seeded(engine):
    with engine.begin() as connection:
        if connection.execute(select(settings_table.c.key).where(settings_table.c.key == SEED_KEY)).first():
            return False
        titles = set(connection.execute(select(eval_corpus.c.title)).scalars().all())
        for path in seed_files():
            title = path.stem[:TITLE_LENGTH]
            if title not in titles:
                store_entry(connection, title, path.name, path.read_text(encoding="utf-8"), "system")
        now = dataset.now_text()
        connection.execute(settings_table.insert().values(key=SEED_KEY, value={"at": now}, updated=now))
    return True


def entry_view(row):
    item = dict(row)
    item["missing"] = not Path(item["path"]).is_file()
    return item


# 语料库里的全部语料（不带正文），按标题排序。
def list_entries(engine):
    ensure_seeded(engine)
    with engine.connect() as connection:
        rows = connection.execute(select(eval_corpus).order_by(eval_corpus.c.title)).mappings().all()
    return [entry_view(row) for row in rows]


def get_entry(engine, entry_id):
    ensure_seeded(engine)
    with engine.connect() as connection:
        row = connection.execute(select(eval_corpus).where(eval_corpus.c.id == entry_id)).mappings().first()
    return entry_view(row) if row else None


def read_content(entry):
    path = Path(entry["path"])
    if not path.is_file():
        raise CorpusError(f"语料《{entry['title']}》的文件不存在：{path.name}")
    return path.read_text(encoding="utf-8")


# 评测要用的语料（带正文）。titles 为 None 时是全部。
def documents_for(titles=None, engine=None):
    engine = engine or bound_engine()
    if engine is None:
        raise CorpusError("评测语料库存在数据库里，没有连接数据库")
    wanted = set(titles) if titles is not None else None
    items = []
    for entry in list_entries(engine):
        if wanted is not None and entry["title"] not in wanted:
            continue
        items.append({"id": entry["id"], "title": entry["title"], "filename": entry["filename"],
            "content": read_content(entry)})
    return items


# 上传一份语料：只收 UTF-8 的 Markdown / 文本，标题用文件名（去掉扩展名），同名或内容完全相同的不收。
def add_entry(engine, filename, data, username):
    ensure_seeded(engine)
    name = Path(filename or "").name
    suffix = Path(name).suffix.lower()
    if suffix not in SUFFIXES:
        raise CorpusError(f"{name or '文件'}：只支持 .md、.txt")
    if len(data) > MAX_BYTES:
        raise CorpusError(f"{name}：单个文件不能超过 5 MB")
    try:
        content = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise CorpusError(f"{name}：不是 UTF-8 编码的文本，请另存为 UTF-8 后再上传") from None
    if not content.strip():
        raise CorpusError(f"{name}：文件是空的")
    title = Path(name).stem.strip()[:TITLE_LENGTH]
    if not title:
        raise CorpusError("文件名不能为空")
    fingerprint = text_fingerprint(content)
    with engine.begin() as connection:
        if connection.execute(select(eval_corpus.c.id).where(eval_corpus.c.title == title)).first():
            raise CorpusError(f"{name}：已经有同名的语料《{title}》，要替换请先删掉旧的")
        same = connection.execute(select(eval_corpus.c.title).where(eval_corpus.c.sha256 == fingerprint)).first()
        if same:
            raise CorpusError(f"{name}：内容和《{same[0]}》完全相同")
        entry_id = store_entry(connection, title, name, content, username)
    return get_entry(engine, entry_id)


# 评测账号里每份语料当前导入的版本：{标题: {"document_id", "status", "sha256"}}。
def imported_versions(engine):
    from .retrieval import EVAL_OWNER
    joined = document_heads.join(documents, documents.c.id == document_heads.c.current_document_id)
    with engine.connect() as connection:
        rows = connection.execute(select(document_heads.c.title, documents.c.id, documents.c.status,
            documents.c.document_metadata).select_from(joined).where(document_heads.c.owner == EVAL_OWNER)).all()
    result = {}
    for title, document_id, status, metadata in rows:
        result[title] = {"document_id": document_id, "status": status, "sha256": (metadata or {}).get("sha256")}
    return result


# 删除一份语料：表里的记录、上传目录里的文件，以及评测账号里导入过的这份文档。
def delete_entry(store, entry_id):
    from .retrieval import EVAL_OWNER
    entry = get_entry(store.engine, entry_id)
    if entry is None:
        return None
    imported = imported_versions(store.engine).get(entry["title"])
    if imported:
        store.delete_document(EVAL_OWNER, imported["document_id"])
    with store.engine.begin() as connection:
        connection.execute(eval_corpus.delete().where(eval_corpus.c.id == entry_id))
    path = Path(entry["path"]).resolve()
    try:
        path.relative_to(storage_dir().resolve())
        path.unlink(missing_ok=True)
    except ValueError:
        pass
    return entry
