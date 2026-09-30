import json
import os
import re
import unicodedata
from pathlib import Path

from langchain_core.prompts import ChatPromptTemplate


# 评测数据、语料和结果都放在仓库的 eval 目录，随代码一起版本管理，任何人拉下代码都能复现同一组分数。
EVAL_DIR = Path(os.getenv("EVAL_DIR", "eval"))
# 题目类型固定为五种，前端按这个顺序分组展示。
QUESTION_TYPES = ["事实", "同义改写", "关键词", "多轮追问", "无法回答"]
# 同义改写保存为两个独立题目，但用同一个题对编号把它们关联起来。
REWRITE_ROLES = {"original", "paraphrase"}
# 评测集拆成开发集和留出集：平时调参只看 dev，holdout 只在确定参数后做最终验证，
# 否则反复对着同一批题调阈值，分数会越来越好看，但只是"背熟了这几道题"（过拟合）。
SPLITS = ["dev", "holdout"]


# 比较前统一去掉空白并做 NFKC 规范化（全角字母数字和标点转半角）。
# 语料经过 OCR、分块和换行处理，空格和全角半角经常与标注时复制的原文不一致，不统一就会误判为未命中。
def normalize(text):
    folded = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", "", folded)


# 读取 JSONL 评测集，每行一道题；空行跳过，便于人工编辑。
def load_dataset(path=None):
    path = Path(path) if path else EVAL_DIR / "dataset.jsonl"
    items = []
    with path.open(encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue
            items.append(json.loads(line))
    return items


# 按 split 选择题目；all 表示全部题目。
def select_split(items, split):
    selected = []
    for item in items:
        # 未审核题目只保留在题目管理页，不能混入实际评测，避免 AI 草稿污染指标。
        if item.get("reviewed") is not True:
            continue
        if split != "all" and item.get("split", "dev") != split:
            continue
        selected.append(item)
    return selected


# 原子覆盖评测集文件，审核状态变化不能只改内存，否则服务重启后题目会重新变成待审核。
def save_dataset(items, path=None):
    target = Path(path) if path else EVAL_DIR / "dataset.jsonl"
    temporary = target.with_suffix(target.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        for item in items:
            file.write(json.dumps(item, ensure_ascii=False) + "\n")
    temporary.replace(target)


# 将指定题目标记为已审核，返回更新后的题目；题干、证据和答案保持原样。
def mark_reviewed(items, item_id):
    selected = []
    for item in items:
        updated = dict(item)
        if updated.get("id") == item_id:
            updated["reviewed"] = True
        selected.append(updated)
    for item in selected:
        if item.get("id") == item_id:
            save_dataset(selected)
            return item
    return None


# 语料目录下的每个 Markdown 文件是一份文档，文件名（去掉扩展名）作为文档标题。
def corpus_files():
    return sorted((EVAL_DIR / "corpus").glob("*.md"))


# 拼接评测语料原文，手动录入和 AI 生成共用这份内容做证据校验。
def corpus_text():
    parts = []
    for path in corpus_files():
        parts.append(path.read_text(encoding="utf-8"))
    return "\n\n".join(parts)


# 为新题目生成不与现有题目冲突的编号；可回答题和无法回答题沿用现有 q/u 前缀，便于人工识别。
def next_item_id(items, answerable):
    prefix = "q" if answerable else "u"
    used = {str(item.get("id", "")) for item in items}
    largest = 0
    for item_id in used:
        match = re.fullmatch(rf"{prefix}(\d+)", item_id)
        if match:
            largest = max(largest, int(match.group(1)))
    number = largest + 1
    candidate = f"{prefix}{number:02d}"
    while candidate in used:
        number += 1
        candidate = f"{prefix}{number:02d}"
    return candidate


# 题对需要稳定且可读的关联编号；原题和改写题各自仍使用独立的 q/u 题目编号。
def next_pair_id(items):
    used = {str(item.get("pair_id", "")) for item in items}
    largest = 0
    for pair_id in used:
        match = re.fullmatch(r"pair_(\d+)", pair_id)
        if match:
            largest = max(largest, int(match.group(1)))
    number = largest + 1
    candidate = f"pair_{number:03d}"
    while candidate in used:
        number += 1
        candidate = f"pair_{number:03d}"
    return candidate


# 追加 JSONL 题目；单独封装写入动作，避免 API 路由把序列化细节和校验流程混在一起。
def append_items(items, path=None):
    target = Path(path) if path else EVAL_DIR / "dataset.jsonl"
    with target.open("a", encoding="utf-8") as file:
        for item in items:
            file.write(json.dumps(item, ensure_ascii=False) + "\n")


# 统一模型返回的证据格式；模型有时会把单条证据返回为字符串，或用 text/quote 包一层。
def normalize_generated_evidence(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if not isinstance(value, list):
        raise ValueError("模型返回了无效证据")
    evidence = []
    for item in value:
        if isinstance(item, str):
            evidence.append(item)
            continue
        if isinstance(item, dict):
            text = item.get("text") or item.get("quote") or item.get("content")
            if isinstance(text, str):
                evidence.append(text)
                continue
        raise ValueError("模型返回了无效证据")
    return evidence


# 调用真实大模型按语料起草题目，并在落盘前要求每条证据都能回到语料原文。
def generate_items(models, existing, count, split, question_type=None):
    prompt = ChatPromptTemplate.from_messages([("system", (
        "你是 RAG 评测集编辑。只输出 JSON，不要输出 Markdown。"
        # ChatPromptTemplate 会把大括号解释成变量，这里转义 JSON 示例，避免生成请求被模板解析拦截。
        "JSON 必须是 {{\"items\":[...]}}，每个 item 必须包含 type、answerable、question、evidence、reference_answer。"
        "type 只能是：事实、同义改写、关键词、多轮追问、无法回答。"
        "evidence 必须是字符串数组；可回答题的每个 evidence 必须是语料中的逐字原文；无法回答题 evidence 必须为空数组。"
        "如果题型是同义改写，question 是原问题，并额外返回 paraphrase_question 作为另一种问法；两者共享 evidence 和 reference_answer。"
        "如果 type 是多轮追问，还必须返回 history 字符串数组。"
        "不要编造语料中不存在的事实；问题应覆盖语料中的不同信息点。"
    )), ("human", "请基于下面语料生成 {count} 道题。题型要求：{question_type}。\n语料：\n{corpus}")])
    corpus = corpus_text()
    content = models.chat_completion(prompt.format_messages(
        count=count, question_type=question_type or "混合题型", corpus=corpus,
    ), 2400)
    parsed = models.parse_json(content)
    raw_items = parsed.get("items") if isinstance(parsed, dict) else None
    if not isinstance(raw_items, list) or len(raw_items) < count:
        raise ValueError("模型返回的题目数量不足")
    generated = []
    for raw in raw_items[:count]:
        if not isinstance(raw, dict):
            raise ValueError("模型返回了无效题目")
        item_type = question_type or raw.get("type")
        answerable = raw.get("answerable")
        question = raw.get("question")
        evidence = normalize_generated_evidence(raw.get("evidence"))
        reference_answer = raw.get("reference_answer")
        history = raw.get("history") or []
        if item_type not in QUESTION_TYPES or not isinstance(answerable, bool):
            raise ValueError("模型返回了未知题型或无效可回答标记")
        if not isinstance(question, str) or not question.strip():
            raise ValueError("模型返回了空问题")
        if not isinstance(history, list) or not all(isinstance(text, str) and text.strip() for text in history):
            raise ValueError("模型返回了无效追问历史")
        if item_type == "多轮追问" and not history:
            raise ValueError("多轮追问题缺少追问历史")
        paraphrase_question = raw.get("paraphrase_question")
        if item_type == "同义改写" and (not isinstance(paraphrase_question, str) or not paraphrase_question.strip()):
            raise ValueError("同义改写题缺少改写问题")
        if not isinstance(reference_answer, str) or not reference_answer.strip():
            raise ValueError("模型返回了空标准答案")
        questions = [(question, None)]
        pair_id = None
        if item_type == "同义改写":
            pair_id = next_pair_id(existing + generated)
            questions = [(question, "original"), (paraphrase_question, "paraphrase")]
        for generated_question, pair_role in questions:
            item = {
                "id": next_item_id(existing + generated, answerable),
                "question": generated_question.strip(), "type": item_type, "answerable": answerable,
                "evidence": [text.strip() for text in evidence if text.strip()],
                "reference_answer": reference_answer.strip(), "split": split,
                "history": [text.strip() for text in history if text.strip()],
                "origin": "ai", "reviewed": False,
            }
            if pair_id:
                item["pair_id"] = pair_id
                item["pair_role"] = pair_role
            generated.append(item)
    problems = validate_dataset(existing + generated, corpus)
    if problems:
        raise ValueError("AI 生成题目未通过校验：" + "；".join(problems[:3]))
    return generated


# 检查评测集本身是否可用，返回问题列表；为空表示通过。
# 证据必须能在语料原文里逐字找到，否则这道题永远判为未命中，分数低的原因就不在检索，而在标注。
def validate_dataset(items, corpus_text):
    problems = []
    seen = set()
    corpus = normalize(corpus_text)
    for item in items:
        item_id = item.get("id", "?")
        if item_id in seen:
            problems.append(f"{item_id}：题目编号重复")
        seen.add(item_id)
        if item.get("type") not in QUESTION_TYPES:
            problems.append(f"{item_id}：未知题型 {item.get('type')}")
        if item.get("split", "dev") not in SPLITS:
            problems.append(f"{item_id}：未知 split {item.get('split')}")
        evidence = item.get("evidence") or []
        # 无法回答题不需要证据，只看系统是否拒答；能回答的题没有证据就无法判断检索是否命中。
        if item.get("answerable") and not evidence:
            problems.append(f"{item_id}：可回答的题必须至少有一条证据原文")
        if not item.get("answerable") and evidence:
            problems.append(f"{item_id}：无法回答的题不应该有证据")
        for text in evidence:
            if normalize(text) not in corpus:
                problems.append(f"{item_id}：证据不在语料中：{text}")
    # 同义改写如果只保存一边或混用了共享答案，会让后续成对指标失去比较意义，因此在写入时拦截不完整题对。
    pairs = {}
    for item in items:
        pair_id = item.get("pair_id")
        if not pair_id:
            continue
        pairs.setdefault(pair_id, []).append(item)
    for pair_id, members in pairs.items():
        if len(members) != 2:
            problems.append(f"{pair_id}：同义改写题对必须包含原问题和改写问题各一条")
            continue
        roles = {member.get("pair_role") for member in members}
        if roles != REWRITE_ROLES:
            problems.append(f"{pair_id}：同义改写题对必须同时包含 original 和 paraphrase")
        if any(member.get("type") != "同义改写" for member in members):
            problems.append(f"{pair_id}：题对中的题型必须都是同义改写")
        if any(member.get("answerable") != members[0].get("answerable") for member in members):
            problems.append(f"{pair_id}：题对中的可回答标记必须一致")
        if any(member.get("evidence", []) != members[0].get("evidence", []) for member in members):
            problems.append(f"{pair_id}：题对中的标准证据必须一致")
        if any(member.get("split") != members[0].get("split") for member in members):
            problems.append(f"{pair_id}：题对中的题目范围必须一致")
    return problems
