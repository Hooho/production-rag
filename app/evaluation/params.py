"""评测运行参数：发起评测时可以单独指定的模型、提示词版本和运行参数，只对这一次评测生效。

以前想换个模型或调一个阈值跑评测，只能先改设置页，评测期间线上问答也跟着变，跑完还得记得改回去。
现在发起评测时带上 params，每一项不写就跟随系统设置，写了就只在评测的后台线程里生效：
- 运行参数：runtime_config.override()，value() / snapshot() 先看覆盖的值；
- 提示词版本：prompts.override()，current() 先看评测指定的版本；
- 大模型：Models.fork() 复制一份换模型，评测只用副本，app.state.models 不动；
- 评审模型（生成评测给答案打分的模型）：同样复制一份，judge() 在评测线程里换成它。
覆盖都用 ContextVar 存，只在当前线程有值，线上请求所在的线程读不到。

params 的结构：
    {"llm": {"provider": "minimax", "model": "MiniMax-M3"},   # 不写 = 用系统当前模型
     "judge": {"provider": "deepseek", "model": "deepseek-chat"},  # 只有生成评测用
     "settings": {"agent_rerank_min_score": 0.2},              # 只写改了的项
     "prompts": {"agent": 3}}                                 # 提示词 id → 版本号，0 是内置版本
评测记录里存 params（overrides，用户改了什么）和 effective（实际生效的全部配置，不含密钥），
两次评测比较时直接看 effective 的差别。
"""

from contextlib import contextmanager
from contextvars import ContextVar

from .. import prompts, runtime_config

GROUPS = runtime_config.EVAL_GROUPS
_judge = ContextVar("eval_judge_models", default=None)


# 发起评测页「参数配置」要显示的内容：每组有哪些参数、当前系统值，可选的模型和提示词版本。
def options(store, models):
    view = runtime_config.view()
    settings = [item for item in view["items"] if item.get("eval")]
    profiles = store.load_llm_profiles() if store is not None else {}
    llm = {
        "enabled": models.mode == "openai",
        "current": {"provider": models.llm_provider, "model": models.llm_model},
        "profiles": [
            {
                "provider": provider,
                "model": value.get("model"),
                "base_url": value.get("base_url"),
                "is_active": provider == models.llm_provider,
            }
            for provider, value in sorted(profiles.items())
        ],
    }
    if models.llm_provider not in profiles and models.llm_model:
        llm["profiles"].insert(
            0,
            {
                "provider": models.llm_provider,
                "model": models.llm_model,
                "base_url": models.llm_base_url,
                "is_active": True,
            },
        )
    items = []
    for prompt_id, group in prompts.EVAL_PROMPTS.items():
        version, _ = prompts.current(prompt_id)
        items.append(
            {
                "id": prompt_id,
                "label": prompts.BY_ID[prompt_id]["label"],
                "eval": group,
                "active_version": version,
                "active_label": prompts.version_label(version),
                "versions": prompts.versions(store.engine, prompt_id)
                if store is not None
                else [],
            }
        )
    return {
        "groups": [{"key": key, "label": label} for key, label in GROUPS.items()],
        "settings": settings,
        "llm": llm,
        "prompts": items,
    }


# 选中的模型配置：provider 必须是设置页保存过的厂商；model 不写就用那个厂商保存的模型名。
def _profile(store, models, choice, label):
    if not choice:
        return None
    if not isinstance(choice, dict) or not choice.get("provider"):
        raise ValueError(f"{label}要选一个已保存的模型配置")
    profiles = store.load_llm_profiles()
    provider = choice["provider"]
    if provider in profiles:
        profile = profiles[provider]
    elif provider == models.llm_provider:
        profile = {
            "provider": provider,
            "base_url": models.llm_base_url,
            "model": models.llm_model,
            "api_key": models.llm_api_key,
        }
    else:
        raise ValueError(f"{label}的厂商「{provider}」还没有在设置页保存过")
    model = choice.get("model") or profile.get("model")
    if not isinstance(model, str) or not model.strip() or len(model) > 128:
        raise ValueError(f"{label}的模型名不正确")
    return {
        "provider": provider,
        "base_url": profile["base_url"],
        "model": model.strip(),
        "api_key": profile.get("api_key") or "",
    }


# 检查并整理发起评测时传来的 params，返回 (整理后的 params, 内部要用的模型配置和提示词内容)。不合法时抛 ValueError。
def prepare(store, models, raw):
    raw = raw or {}
    unknown = [key for key in raw if key not in ("llm", "judge", "settings", "prompts")]
    if unknown:
        raise ValueError("未知参数：" + "、".join(unknown))
    settings = runtime_config.check_overrides(raw.get("settings") or {})
    llm = _profile(store, models, raw.get("llm"), "大模型")
    judge = _profile(store, models, raw.get("judge"), "评审模型")
    if (llm or judge) and models.mode != "openai":
        raise ValueError("演示模式没有大模型，不能指定模型：请设置 MODEL_MODE=openai")
    picked = prompts.resolve_versions(store.engine, raw.get("prompts") or {})
    cleaned = {}
    if llm:
        cleaned["llm"] = {"provider": llm["provider"], "model": llm["model"]}
    if judge:
        cleaned["judge"] = {"provider": judge["provider"], "model": judge["model"]}
    if settings:
        cleaned["settings"] = settings
    if picked:
        cleaned["prompts"] = {
            prompt_id: item["version"] for prompt_id, item in picked.items()
        }
    return cleaned, {
        "llm": llm,
        "judge": judge,
        "settings": settings,
        "prompts": picked,
    }


# 在 with 块里按 params 跑评测：参数、提示词版本的覆盖生效，返回 (评测用的模型, 评审模型)。
# 没指定模型时返回原来的 models，行为和以前完全一样。
@contextmanager
def applied(models, prepared):
    prepared = prepared or {}
    run_models = models.fork(prepared["llm"]) if prepared.get("llm") else models
    judge_models = models.fork(prepared["judge"]) if prepared.get("judge") else None
    token = _judge.set(judge_models)
    try:
        with (
            runtime_config.override(prepared.get("settings") or {}),
            prompts.override(prepared.get("prompts") or {}),
        ):
            yield run_models, judge_models or run_models
    finally:
        _judge.reset(token)


# 评审打分用哪个模型：评测指定了评审模型就用它，否则用传进来的（和回答同一个模型，以前的行为）。
def judge(models):
    return _judge.get() or models


# 这次评测实际生效的全部配置，存进评测记录；要在 applied() 里面调用才能读到覆盖后的值。不存密钥。
def effective(run_models, judge_models):
    values = runtime_config.snapshot()
    return {
        "llm": {
            "provider": run_models.llm_provider,
            "model": run_models.llm_model,
            "base_url": run_models.llm_base_url,
        },
        "judge": {
            "provider": judge_models.llm_provider,
            "model": judge_models.llm_model,
        },
        "settings": {
            spec["key"]: values[spec["key"]]
            for spec in runtime_config.SPECS
            if spec.get("eval")
        },
        "prompts": {
            prompt_id: prompts.tag(prompt_id) for prompt_id in prompts.EVAL_PROMPTS
        },
    }
