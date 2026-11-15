import { useEffect, useMemo, useState } from "react";
import { Tag } from "./Tag";
import type { Tone } from "./tags";
import {
  getRuntimeSettings,
  saveRuntimeSettings,
  type RuntimeSettingItem,
  type RuntimeSettingValue,
  type RuntimeSettingsView,
} from "./api";
import { applyTheme } from "./theme";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import "./SystemSettings.css";

// 「系统管理」页的「RAG 配置」（检索、回答流程、对话记忆、安全检查、知识巡检、模型服务）和「设置」页的「系统配置」（通用）共用这个组件，按 page 只显示对应的组。
// 每一项写明作用、默认值为什么是这个值、改了会怎样、什么时候生效；后端定义在 app/runtime_config.py。
type ShowToast = (kind: "success" | "error", message: string) => void;
// now：之后的问答即时生效；new_docs：只影响之后上传的文档；judgement：会改变评测分数或巡检结论，改前改后不能直接比较。
type Impact = "now" | "new_docs" | "judgement";
type Meta = {
  label: string;
  unit?: string;
  step?: number;
  percent?: boolean;
  what: string;
  why?: string;
  effect?: string;
  when?: string;
  impact: Impact;
};

const GROUP_INTROS: Record<string, string> = {
  retrieval:
    "决定找哪些资料、交给模型多少。全部即时生效，不动已有文档和向量，但都会改变评测分数。",
  chunking:
    "上传文档时怎么切成分片。改了只影响之后上传的文档，已导入的分片不变；要让已有文档按新值切，在知识库里重新上传。评测语料下次评测时会自动按新值重新导入。",
  answer: "决定问答流程里多做哪几步。",
  memory:
    "同一个会话里对话变长后，把早期的问答压缩成摘要。保存后回答模块在下一次提问前自动重建，不用重启。",
  security:
    "问题进入问答之前的三层检查，每层可以单独开关：第一层规则匹配 → 第二层和「安全样本」里的攻击样本比语义相似度 → 第三层交给注入检测模型判断。前一层拦下就不再往后查。即时生效。",
  inspection:
    "只影响知识巡检怎么归类和报问题，不影响问答本身。下一次巡检或点「重新检索」时生效，已有的问题和诊断结论不会回头重算。",
  general: "和检索、回答效果无关的系统设置。",
  service: "调用向量模型、重排模型的等待时间，一般只在出问题时才调。",
};

const META: Record<string, Meta> = {
  rerank_min_score: {
    label: "相关度阈值",
    step: 0.05,
    impact: "judgement",
    what: "重排后得分低于它的资料不交给模型；全部低于时看兜底分数线。交给模型的资料都带着相关性分数，由模型自己判断是否切题。",
    why: "开发集阈值扫描：0.85 时可回答题的召回仍是 1.0，无法回答题的漏放率从 0.625 降到 0.25。",
    effect:
      "调高更容易拒答、编造更少；调低更敢答，可能拿不相关的资料凑答案。巡检里「差一点就找到」的分数线跟着变。",
    when: "之后的问答；已有的问答记录和诊断结论不变，下次巡检按新值判断。",
  },
  rerank_fallback_min_score: {
    label: "兜底分数线",
    step: 0.05,
    impact: "judgement",
    what: "全部资料都低于相关度阈值时，得分最高的一条只要高于它，就单独交给模型，并标明相关性较低；不高于就当作没找到。",
    why: "避免阈值把有用的资料全部挡掉：模型拿到这一条后自己判断是否切题，而不是直接被告知没找到。",
    effect:
      "调低更少出现“没找到”，但模型更常看到不相关的资料；调高相反。不能高于相关度阈值。",
    when: "之后的问答。知识巡检不把兜底返回的资料算作“现在能答”。",
  },
  rerank_excellent_score: {
    label: "优秀阈值",
    step: 0.05,
    impact: "judgement",
    what: "重排得分不低于它的资料全部交给模型，不受「交给模型的段数」限制，最多就是候选池里的全部；得分在相关度阈值和它之间的，照常按段数截断。设成 1 表示不启用。",
    why: "列举类问题常有十来条资料都高度相关，按段数截断会丢掉其中几条：评测里通用电气重排分 0.97，排第 9 名，过了阈值仍被段数截掉。",
    effect:
      "调低（比如 0.9），列举、汇总类问题能拿到更多高度相关的资料，但交给充分性判断和回答模型的内容更长、更费 token；单点问题过线的资料本来就少，基本不受影响。不能低于相关度阈值。建议先在评测里单独指定这个值对比，再改这里。",
    when: "之后的问答。",
  },
  rerank_candidates: {
    label: "候选池大小",
    unit: "条",
    step: 1,
    impact: "judgement",
    what: "向量和关键词融合后，按 RRF 名次取前多少条交给重排模型打分。只被图检索找到的分片不占这里的名额，另有上限。",
    why: "候选池应大于最终返回数，让重排有机会纠正初始排名。",
    effect:
      "调大不容易漏资料，但重排耗时大致按条数增加；调小更快，排名靠后的资料可能轮不到打分。",
    when: "之后的问答。",
  },
  source_selection_mode: {
    label: "原文选取方式",
    impact: "judgement",
    what: "按条数：过了阈值的资料取前几段（交给模型的段数），父子扩展不受总量控制。按 token 预算：按总量取，先放图谱关系，所有原文按统一重排分数竞争剩余预算，最后用剩余容量补父子扩展；图谱关系只在这种方式下放进上下文。",
    why: "默认按条数，和以前的行为一致。",
    effect:
      "按 token 预算时「交给模型的段数」和优秀阈值不起作用；按条数时 token 预算不起作用。",
    when: "之后的检索。",
  },
  source_graph_budget_ratio: {
    label: "图检索保底比例",
    step: 0.05,
    impact: "judgement",
    what: "仅在 token 预算模式且重排成功时生效。0.25 表示总预算的 25%；先放图检索留下的图谱关系（关系重排成功时），剩下的保底只有图检索找到、且通过相关度过滤的分片。",
    why: "减少图找到的独有证据在最终选取中被挤掉。",
    effect:
      "用不完自动归还公共预算；向量或关键词也找到的分片不占保底，按重排分数参加公共竞争。0 表示关闭。",
    when: "之后的检索。",
  },
  source_token_budget: {
    label: "原文 token 预算（估算）",
    unit: "token",
    step: 500,
    impact: "judgement",
    what: "交给回答模型的原文和图谱关系的总量上限。中文按字、其他文字按约四字符一个 token 估算；先放图谱关系，再按统一重排分数选择原文，最后父子扩展。",
    why: "没有回答模型专用 tokenizer，估算值不代表实际模型用量。",
    effect: "不包含系统提示词、对话历史和回答空间，请根据模型上下文预留余量。",
    when: "按 token 预算选取时。",
  },
  return_limit: {
    label: "交给模型的段数",
    unit: "段",
    step: 1,
    impact: "judgement",
    what: "达到阈值的资料最多交给回答模型几段，不能超过候选池大小（按 RRF 名次进重排的那一份）。",
    why: "6 是常见取值（一般 3–8）。离线评测里 1 到 12 段的召回都是 1.0，37 题里只有 10 题达标资料超过 6 段，实际主要靠阈值截断。",
    effect:
      "调大，跨多段的问题更容易答全，但输入更长、更慢、更贵；开着父子分块时每段最长 2400 字。调小相反。",
    when: "之后的问答。",
  },
  parent_context: {
    label: "父子分块",
    impact: "now",
    what: "命中一个分片后，把同一小节的相邻分片一起交给模型。",
    why: "800 字的小分片检索更准，但一个观点常跨两三个分片，只给命中的那块，模型看不到前因后果。",
    effect:
      "关掉后只给命中的 800 字，更短更快，但容易答不全。只影响交给模型的内容，不影响检索和得分，不用重新导入（相邻分片导入时就存好了）。",
  },
  parent_max_chars: {
    label: "父块长度上限",
    unit: "字",
    step: 100,
    impact: "now",
    what: "扩展后的一段最长多少字。",
    why: "约等于三个 800 字分片。",
    effect: "调大上下文更完整，输入更长；调小更接近关掉父子分块。",
  },
  parent_radius: {
    label: "向前后各看几片",
    unit: "片",
    step: 1,
    impact: "now",
    what: "从命中的分片往前、往后最多拼几片，只在同一小节内。",
    why: "实际长度先受上一项限制，3 片配合 2400 字刚好。",
    effect: "单独调大作用不大，要和长度上限一起调。",
  },
  rerank_enabled: {
    label: "重排",
    impact: "judgement",
    what: "用交叉编码器给候选打 0 到 1 的相关度，是相关度阈值和巡检拒答分类的基础。需要 embedding 服务在运行。",
    why: "重排是整条检索里最准的一步，默认打开。",
    effect:
      "关掉后只按融合名次取前几段，更快，但不再按相关度拒答；相关度阈值不起作用，巡检诊断变成「无法判断」。",
    when: "之后的问答。",
  },
  rrf_k: {
    label: "RRF 平滑常数",
    step: 1,
    impact: "judgement",
    what: "向量和关键词两张排名表合并时，每条按 1 ÷（常数 + 名次）计分。",
    why: "60 是论文和 Milvus、Elasticsearch 的默认值。",
    effect:
      "越小越看重排第一的结果，越大两边越平均。开着重排时只影响谁进候选池，一般不用调。",
    when: "之后的问答。",
  },
  graph_retrieval: {
    label: "图检索",
    impact: "judgement",
    what: "打开后每次检索多一路图检索：从问题里提出关键词，去已建图谱的名字、关系里找相似的，取它们的出处分片，和向量、关键词两路一起融合排序。固定流程和 Agent 都用。只用当前用户能看到的文档、每份文档生效的图谱版本。",
    why: "默认关：要先给文档建图；打开后每次提问多一次提关键词的模型调用（Agent 自己给了关键词时不调用）。",
    effect:
      "列举类（「段永平投资了哪些公司」）、别名类、跨文档的问题更容易找全；事实类问题帮助不大。会不会带来噪声，用评测对比打开前后。关闭时问答和以前完全一样。新建图谱会自动算向量；以前建的图谱要在「知识图谱 › 建图任务」里点「补算向量」。",
    when: "之后的问答。",
  },
  graph_name_min_score: {
    label: "图检索 · 名字相似度阈值",
    step: 0.05,
    impact: "judgement",
    what: "具体关键词（如「段永平」）和图谱里的名字（名字 + 类型 + 描述）的向量相似度，达到这个值才算找到这个名字。字面命中的名字不看这个阈值。",
    why: "参考 LightRAG 的量级先定 0.5，还没有评测依据。",
    effect: "调高找到的实体更少更准，调低更容易把不相干的名字也算进来。",
    when: "之后的问答。",
  },
  graph_name_top_k: {
    label: "图检索 · 每个关键词找几个名字",
    step: 1,
    impact: "judgement",
    what: "每个具体关键词在名字向量里取最相似的前几个，再按上面的阈值筛。",
    why: "同一个实体常有好几个名字（段永平、阿段、段总），取 10 个能覆盖。",
    effect: "调大能把更多别名、没合并的同名实体找回来，也更容易混进不相干的。",
    when: "之后的问答。",
  },
  graph_entity_top_k: {
    label: "图检索 · 每个关键词最多几个实体",
    step: 1,
    impact: "judgement",
    what: "每个具体关键词找到的名字按实体合并后，最多留几个实体：名字和关键词相同或被关键词包含（字面命中）的排最前，其余按相似度。",
    why: "名字向量带着描述，描述里都提到同一个人时（一本讲段永平的书），不相干的实体也会很像；参考 RAGFlow 只留前 6 个。",
    effect:
      "调大能找回更多别名、没合并的实体，也会带进更多不相干的实体和它们的关系。",
    when: "之后的问答。",
  },
  graph_entity_min_score: {
    label: "图检索 · 实体关系相似度阈值",
    step: 0.05,
    impact: "judgement",
    what: "实体一跳关系的向量检索分数线；低于分数线的关系仍可通过关键词检索进入候选。",
    why: "实体这条路原来只看条数不看相似度：关系少的实体（常见于名字向量误匹配进来的）关系全部留下，热门实体的低分关系反被条数上限砍掉，两个方向正好相反。默认 0.5，和关系相似度阈值一致。",
    effect:
      "调高留下的关系更少更准，调低更全但噪声更多。热门实体（段永平这类）的关系相似度普遍在 0.6 以上，这个阈值主要用来排掉误匹配实体带进来的关系，对热门实体基本没有影响。",
    when: "之后的问答。",
  },
  graph_entity_relation_limit: {
    label: "图检索 · 每实体每路关系候选数",
    step: 1,
    impact: "judgement",
    what: "在每个实体的一跳关系内，向量和关键词检索各取多少条，再融合排名。",
    why: "仅控制粗筛规模，最终关系由统一重排决定。",
    effect: "调大能增加召回，查询开销也增加。",
    when: "之后的问答。",
  },
  graph_relation_min_score: {
    label: "图检索 · 关系相似度阈值",
    step: 0.05,
    impact: "judgement",
    what: "完整问题和关系（起点 → 终点 + 描述）的向量相似度，达到这个值进入向量候选；关键词匹配可以补充召回。",
    why: "参考 LightRAG 的量级先定 0.5，还没有评测依据。",
    effect: "调高留下的关系更少更准，调低更全但噪声更多。",
    when: "之后的问答。",
  },
  graph_relation_top_k: {
    label: "图检索 · 全局每路关系候选数",
    step: 1,
    impact: "judgement",
    what: "完整问题在可见关系库中，向量和关键词检索各取多少条。",
    why: "不依赖实体匹配，补充一跳路径遗漏的关系。",
    effect: "调大扩大候选范围。",
    when: "之后的问答。",
  },
  graph_entity_relation_quota: {
    label: "图检索 · 每实体保底候选数",
    step: 1,
    impact: "judgement",
    what: "每个实体排名靠前的关系优先进入重排候选池；重复关系只占一席。总预算不足时按轮次分配。",
    why: "控制关系检索和重排的候选范围。",
    effect: "修改后应用于后续检索。",
    when: "之后的问答。",
  },
  graph_global_relation_quota: {
    label: "图检索 · 全局保底候选数",
    step: 1,
    impact: "judgement",
    what: "全局关系路径优先进入关系重排的候选数，0 表示不保底。",
    why: "控制关系检索和重排的候选范围。",
    effect: "修改后应用于后续检索。",
    when: "之后的问答。",
  },
  graph_relation_rerank_candidates: {
    label: "图检索 · 关系重排候选数",
    step: 1,
    impact: "judgement",
    what: "各路径保底合并后，按融合排名补齐到这个总上限。",
    why: "控制关系检索和重排的候选范围。",
    effect: "修改后应用于后续检索。",
    when: "之后的问答。",
  },
  graph_relation_grouping: {
    label: "图检索 · 关系分组分轮选取（实验）",
    impact: "judgement",
    what: "默认开启。开启后，达标关系按起点实体、关系类型、终点实体分组，每组先选一条，再选第二条；每轮按重排分数排序。",
    why: "减少同一实体组合连续占满关系名额，提高不同组合的覆盖；不合并或删除关系。",
    effect: "关闭时按重排分数选择；重排失败时回退融合排名，不应用分组。",
    when: "之后的问答和使用该配置的评测。",
  },
  graph_relation_return_limit: {
    label: "图检索 · 重排后关系保留数",
    step: 1,
    impact: "judgement",
    what: "关系最多保留多少条。关闭分组时按重排分数选择，开启时分组分轮选择；留下的关系用来找原文，token 模式下还按选择顺序优先使用总预算。",
    why: "控制关系检索和重排的候选范围。",
    effect: "修改后应用于后续检索。",
    when: "之后的问答。",
  },
  graph_relation_rerank_min_score: {
    label: "图检索 · 关系重排分数线",
    step: 0.05,
    impact: "judgement",
    what: "仅用于关系重排分数，不能与向量分数比较；失败回退时不应用。低于分数线的关系既不用来找原文，也不放进回答上下文。",
    why: "控制关系检索和重排的候选范围。",
    effect: "修改后应用于后续检索。",
    when: "之后的问答。",
  },
  graph_chunk_rerank_candidates: {
    label: "图检索 · 只有图找到的分片进重排上限",
    step: 1,
    impact: "judgement",
    what: "只被图检索找到的分片不和其他分片比 RRF 名次，按图检索的名次取前多少个交给重排；不占「候选池大小」的名额。",
    why: "图只有一张排名表，向量、关键词每个检索词各一张，只被图找到的分片 RRF 分数天生低，比名次几乎进不了候选池。",
    effect:
      "调大更多只被图找到的分片交给重排判断，重排多花一点时间；0 表示这些分片不进重排。",
    when: "之后的问答。",
  },
  chunk_size: {
    label: "分片大小",
    unit: "字",
    step: 50,
    impact: "new_docs",
    what: "每个分片最多多少字，标题路径（如「第三章 / 退款规则」）也算在内。按标题、段落、句子的边界切，一句话本身超长时才会从中间断开。",
    why: "项目初始化时定的经验值，还没有评测依据。要注意：当前的向量模型 bge-small-zh 最多读 512 个 token，中文大约一字一个 token，切满 800 字的分片（标题路径也算在这 800 字里）肯定超过 512，后面约三分之一没参与向量计算（关键词检索和重排仍然看全文）；只有小节末尾、短小节切出来不到 500 字左右的分片不受影响。评测语料按 800 字切，113 个分片里约 95 个超过 512。在知识库里打开分片详情，「Token 数」一栏会提示有没有被截断。",
    effect:
      "调小（比如 400–500），分片基本不再被截断，向量更聚焦，但一个观点更容易被切成几片，要靠父子分块在回答时拼回来，分片数也会变多。调大，每片内容更完整，但超出 512 token 的部分对向量检索不起作用。",
  },
  chunk_overlap: {
    label: "分片重叠",
    unit: "字",
    step: 10,
    impact: "new_docs",
    what: "切下一个分片时，把上一个分片末尾这么多字再带上一遍。设为 0 就是不重叠。最多是分片大小的三分之一。",
    why: "一个观点正好跨在两个分片的交界处时，两边各只有半句，向量和关键词都不容易搜到；带上约一两句话的重叠，至少有一片是完整的。120 约为分片大小的 15%，常见取值是 10%–20%。",
    effect:
      "调成 0，分片更少、没有重复内容，但交界处的内容更难被检索到。开着父子分块时，回答阶段会把相邻分片拼回来，所以重叠主要帮的是「找到」这一步，不影响「答全」。调大，重复内容变多，向量和存储跟着增加，同一段话也更容易在检索结果里出现两次。",
  },
  sufficiency_check: {
    label: "检索充分性判断",
    impact: "judgement",
    what: "检索后让大模型判断资料够不够：不够就换个说法补充检索一次，仍不够就拒答；只够回答一部分时，告诉回答模型缺什么。",
    why: "防止模型拿半相关的资料硬凑答案。",
    effect:
      "关掉后每次知识问答少一到两次大模型调用，更快更省，但只靠相关度阈值把关，编造和答不全会变多；巡检里「资料不足」「只能回答一部分」这两类信号会消失。",
    when: "之后的问答。",
  },
  intent_local: {
    label: "本地意图识别",
    impact: "now",
    what: "规则认不出的问题，先交给本地小模型分类（知识问答、订单、数据查询…），置信度低才交给大模型。需要 intent 服务在运行。",
    why: "小模型在本机跑，快且不要钱，大部分问题在这一步就分好了。intent 服务没在运行时，每个问题会先等最多 2 秒超时，再交给大模型，这时应该关掉。",
    effect:
      "关掉后规则认不出的问题都交给大模型，每次多一次调用；分流结果可能变化，巡检「分错了路」的判断也按新的分流走。",
  },
  agent_tool_budget: {
    label: "Agent 工具调用次数",
    unit: "次",
    step: 1,
    impact: "judgement",
    what: "Agent 模式下，一次问答最多调用几次工具（检索、读前后文、查订单、查数据）。用完后不再提供工具，让模型根据已有资料直接回答。",
    why: "一般的复合问题 2–4 次就够，6 次留了换问法重试的余地，又不会太慢。",
    effect:
      "调大，模型有更多机会补查，复杂问题答得更全，但最慢的情况更慢、更费钱；调小更快，但第一次没搜到就没有余地换问法。",
    when: "之后的 Agent 模式问答。",
  },
  agent_timeout: {
    label: "Agent 整体超时",
    unit: "秒",
    step: 10,
    impact: "judgement",
    what: "Agent 模式一次问答最多跑多久。每一轮开始前检查，超过后不再调用工具，直接进入最后一轮让模型回答。",
    why: "推理模型每轮要思考，几轮下来容易超过一分钟；90 秒给 3–4 轮留了余地。",
    effect: "调小，回答更快结束，但复杂问题可能资料没找齐就被要求作答。",
    when: "之后的 Agent 模式问答。",
  },
  agent_rerank_min_score: {
    label: "Agent 相关度阈值",
    step: 0.05,
    impact: "judgement",
    what: "Agent 模式每次检索时，重排得分低于它的资料不返回给模型；全部低于时同样按兜底分数线返回一条。固定流程用上面的「相关度阈值」，两边分开设。",
    why: "默认和固定流程一样是 0.85，行为和以前相同。Agent 会自己读资料、判断是否切题，不够还会换说法再查，阈值可以比固定流程低一些，让它看到更多候选。",
    effect:
      "调低，汇总、列举类问题能拿到更多资料，但每次检索给模型的内容更多、更费 token，无法回答的问题也更容易拿到不相关的资料；调高相反。建议先在评测里单独指定这个值对比，再改这里。",
    when: "之后的 Agent 模式问答。",
  },
  agent_excellent_score: {
    label: "Agent 优秀阈值",
    step: 0.05,
    impact: "judgement",
    what: "Agent 每次检索时，重排得分不低于它的资料全部返回给模型，不受「Agent 每次最多返回几条」和模型自己要的条数（top_k）限制；比要的多时工具会告诉模型为什么。固定流程用上面的「优秀阈值」，两边分开设。设成 1 表示不启用。",
    why: "评测里 Agent 只要了 10 条，过线的有 12 条，没给的腾讯重排分 0.99；工具提示了没给全，但它预算不够，没有再查。",
    effect:
      "调低（比如 0.9），高度相关的资料不会因为要得少被藏起来，但每次检索的内容更长、每轮都要重发，更费 token。不能低于 Agent 相关度阈值。建议先在评测里单独指定这个值对比，再改这里。",
    when: "之后的 Agent 模式问答。",
  },
  agent_return_limit: {
    label: "Agent 每次最多返回几条",
    unit: "条",
    step: 1,
    impact: "judgement",
    what: "Agent 每次检索时，过了相关度阈值的资料最多交给模型几条。每次要几条由模型自己定（检索工具的 top_k），这里只是上限；没给全时工具会告诉模型还有几条没返回。固定流程用上面的「交给模型的段数」，两边分开设。不能超过候选池大小。",
    why: "默认和固定流程一样是 6，行为和以前相同。Agent 常常要 8–10 条，阈值调低后过线的资料也会变多。",
    effect:
      "调大，汇总、列举类问题一次能看到更多资料，但每次检索的内容更长、更费 token（开着父块扩展时每条最长 2400 字）；调小相反。建议先在评测里单独指定这个值对比，再改这里。",
    when: "之后的 Agent 模式问答。",
  },
  agent_parent_context: {
    label: "Agent 父子分块",
    impact: "judgement",
    what: "Agent 检索命中一个分片后，要不要把同一小节的相邻分片一起给模型。固定流程用上面的「父子分块」，两边分开设。",
    why: "默认打开，和固定流程一样。评测里有一部分证据就在命中分片的前后一两片，是靠父块扩展拿到的；Agent 很少主动读前后文。",
    effect:
      "关掉后每条只给命中的那一片，每次检索更短，可以多给几条；但证据在相邻分片里时，要靠模型自己读前后文，它不读就拿不到。",
    when: "之后的 Agent 模式问答。",
  },
  contextual_retrieval: {
    label: "Contextual Retrieval",
    impact: "new_docs",
    what: "上传文档时，让大模型给每个分片写一两句「这段在讲什么」，拼在分片前面参与向量和关键词检索。",
    why: "分片里常只写「该产品」「上述规定」，补上说明后更容易被搜到。",
    effect:
      "关掉后上传更快、不花钱，但这类分片更难检索到；打开时每个新分片多一次大模型调用。",
    when: "只影响之后上传的文档。已有文档要在知识库里点「补全分片上下文」或重新上传；评测语料下次评测时自动重新导入。",
  },
  memory_trigger_tokens: {
    label: "超过多少 Token 开始压缩",
    unit: "Token",
    step: 100,
    impact: "now",
    what: "对话历史（摘要 + 保留的原文）超过这个长度，就把较早的部分压成摘要。Token 是估算的：中文每个字算 1 个，英文大约 4 个字母算 1 个。",
    why: "知识问答一轮常有一两千字。6000 大约是三四轮，压缩后还剩一两轮原文，再过两三轮才会再压，不会每轮都压缩；模型上下文有几万 Token，检索资料也放得下。还没有评测依据，等多轮对话评测跑完再定。",
    effect:
      "调大，多轮追问记得更清楚，但每次输入更长、更贵；调小压缩更频繁，细节容易丢，每次压缩也要多调一次大模型。已经生成的摘要保留。",
  },
  memory_keep_tokens: {
    label: "压缩后保留多少 Token 原文",
    unit: "Token",
    step: 100,
    impact: "now",
    what: "压缩时从最新的问答往前保留原文，加起来不超过这个长度，更早的进摘要。按整轮问答保留，不会只留下回答而丢了问题；上一轮回答特别长时至少保留上一轮。最多是压缩阈值的一半。",
    why: "追问大多针对最近几轮，要用到原话里的数字和说法。按长度而不是条数保留，压缩后一定回到阈值以内；默认是阈值的一半，压一次能撑两三轮。回答很长时，至少保留的上一轮可能就超过这个长度。",
    effect:
      "调大，近几轮细节保留更多，但离阈值更近、压缩更频繁；调小，压缩次数少，追问更容易理解错。",
  },
  long_memory_enabled: {
    label: "长期记忆",
    impact: "now",
    what: "每轮回答后在后台记下关于用户本人、跨会话也用得上的信息（回答偏好、身份和职责、长期关注的主题），新会话里问题改写和生成回答时作为用户画像发给模型。",
    why: "用户不用每次重复「回答简短点」「我负责华东区」。只记用户本人的信息，不记知识库里的事实，也不记手机号、证件号这类敏感信息。",
    effect:
      "关掉后所有用户都不再记录和使用长期记忆，已有的记忆保留，重新打开后继续用；打开时每轮回答多一次后台的模型调用。用户也可以在「记忆 › 长期记忆」里只关自己的。",
  },
  long_memory_max_items: {
    label: "每个用户最多记几条",
    unit: "条",
    step: 5,
    impact: "now",
    what: "每个用户的长期记忆条数上限，满了以后不再新增，已有的仍可以被修改或删除。",
    why: "偏好和身份一般十几条就够了；条数越多，每次发给模型的用户画像越长。",
    effect:
      "调大能记更多细节，但每次提问的输入更长；调小时超出的部分不发给模型（按最近更新的保留），不会删除。",
  },
  injection_rules_enabled: {
    label: "第一层：规则匹配",
    impact: "now",
    what: "用写死的正则检查问题里的常见注入写法：要求忽略原有指令、索取系统提示词、越狱或改变身份、伪造对话角色标记。命中就直接拦截。",
    why: "最便宜也最确定的一层，几乎不耗时，常见写法在这里就拦下，后两层不用再跑。",
    effect:
      "关掉后问题不再按规则检查，只靠后两层；检索来源里的注入句子照样会被清理。一般不建议关，只在排查误拦时临时关闭。",
  },
  injection_vector_enabled: {
    label: "第二层：和攻击样本比对",
    impact: "now",
    what: "问题没有命中注入规则时，再和安全样本库里的攻击说法比语义相似度，换了说法的攻击也能认出来。",
    why: "规则只认固定写法，「把上面那些要求都当没看见」这类换了说法的攻击会漏掉。新攻击加一条样本就能防，不用改代码。",
    effect: "关掉后只用规则检查。打开时每个问题多一次向量计算，约几十毫秒。",
  },
  injection_vector_threshold: {
    label: "相似度阈值",
    step: 0.01,
    impact: "now",
    what: "问题和最相似样本的相似度达到它，就算疑似攻击。",
    why: "经验值：同一个意思换个说法通常在 0.85 以上，话题相近的正常问题一般在 0.6–0.8。不同向量模型的分数范围不一样，换模型后要在「安全样本」页做一次误拦检查。",
    effect:
      "调高误拦少，但改写得多一点的攻击会漏掉；调低能认出更多变体，正常问题也更容易被当成攻击。",
  },
  injection_vector_action: {
    label: "超过阈值时",
    impact: "now",
    what: "只记录：照常回答，在处理过程和运行概览里记下来；拦截：和规则命中一样直接拒绝。",
    why: "阈值合不合适要看真实问题。先只记录一段时间，看会误拦哪些正常问题，再改成拦截。",
    effect: "改成拦截后，超过阈值的问题不再检索和回答。",
  },
  injection_model_enabled: {
    label: "第三层：注入检测模型判断",
    impact: "now",
    what: "规则和攻击样本都没拦下的问题，交给 guard 服务里的注入检测模型（默认 Llama Prompt Guard 2）判断攻击概率。",
    why: "规则和样本库只认得已知的写法，模型能识别没见过的新说法。它是一个很小的分类模型，CPU 上一次几十到一百毫秒，不花钱。",
    effect:
      "关掉后只用规则和攻击样本。没部署 guard 服务、模型还没下载好或调用出错时，这一层自动跳过，不影响问答。",
  },
  injection_model_threshold: {
    label: "攻击概率阈值",
    step: 0.01,
    impact: "now",
    what: "模型给出的攻击概率达到它，就按下面的设置处理。",
    why: "偏严：只拦模型很有把握的，宁可漏掉少数也不误拦正常问题。中文问题的分数分布要用真实数据看，可以先在「系统管理 › 安全样本」的试一试里测几句。",
    effect:
      "调低能拦住更多攻击，正常问题也更容易被拦；调高误拦少，但模型不太确定的攻击会放过去。",
  },
  injection_model_action: {
    label: "模型判断为攻击时",
    impact: "now",
    what: "拦截：和规则命中一样直接拒绝；只记录：照常回答，在处理过程和运行概览里记下来。",
    why: "模型判断为攻击的问题都会进「安全样本」的待确认，确认后加入样本库，下次同类问题在第二层就能拦下。",
    effect: "改成只记录后，模型判断为攻击的问题也会正常检索和回答。",
  },
  gap_similarity: {
    label: "缺口合并的相似度",
    step: 0.05,
    impact: "judgement",
    what: "新的答不上来的问题，和已有知识缺口的语义相似度达到它才归到一起。",
    why: "经验值：同一个问题的不同说法通常在 0.8 以上，只是话题相近的一般在 0.6–0.7。",
    effect:
      "调高拆得更细，同一个问题的几种说法可能变成几条；调低，不同的问题会被并在一起。已经合并的不会拆开。",
    when: "下一次巡检新收进来的问答。",
  },
  content_min_negative: {
    label: "可疑内容：至少几条差评",
    unit: "条",
    step: 1,
    impact: "judgement",
    what: "一段资料被引用后收到至少这么多条差评，才列为可疑内容。",
    why: "只有 1 条可能是误点或个人偏好，所以起步是 2；宁可漏报，也不让清单被噪声淹没。",
    effect: "调低发现得早、误报多；调高只剩反复被差评的，可能漏掉。",
    when: "下一次巡检。",
  },
  content_min_rate: {
    label: "可疑内容：差评比例",
    step: 0.05,
    percent: true,
    impact: "judgement",
    what: "差评数占这段资料被引用次数的比例，和上一项要同时满足。",
    why: "用比例是为了不冤枉热门资料：被引用 100 次、差评 2 次是正常的。",
    effect: "调低发现得早、误报多；调高可能漏掉。",
    when: "下一次巡检。",
  },
  near_miss_ratio: {
    label: "「差一点就找到」的比例",
    step: 0.05,
    impact: "judgement",
    what: "提问人能看到的资料里最高分达到「相关度阈值 × 它」，就算检索缺口而不是内容缺口。",
    why: "取阈值的一半，默认下是 0.425 分：比无关内容高得多，又明显没达标。",
    effect:
      "调低，更多问题判为检索缺口（建议调检索）；调高，更多判为内容缺口（建议补文档）。",
    when: "下一次巡检或「重新检索」。",
  },
  out_of_scope_score: {
    label: "「疑似超出范围」的分数线",
    step: 0.01,
    impact: "judgement",
    what: "全库最相关的资料低于它，就判为闲聊、常识或与业务无关的问题。",
    why: "重排模型对完全无关的内容一般给 0.01 以下，0.05 留了一点余量。",
    effect:
      "调高，更多问题判为超出范围、建议「无需处理」，可能把真正的内容缺口忽略掉。",
    when: "下一次巡检或「重新检索」。",
  },
  system_recheck_limit: {
    label: "系统问题每次自动验证几条",
    unit: "条",
    step: 1,
    impact: "now",
    what: "巡检时取出现次数最多的几个待处理、已处理的系统问题，用原问题以原提问人的身份重新问一遍：恢复了就自动关闭，已处理但仍出错就重新打开。0 表示不自动验证，只能在问题详情里手动点。",
    why: "每条都要完整走一遍问答，会调用大模型；系统问题通常不多，5 条够覆盖主要的几类。",
    effect:
      "调大，验证更全，巡检更慢、花费更多；调小或设为 0 更省，修好的问题要手动验证才会关闭。",
  },
  business_tz: {
    label: "业务时区",
    impact: "now",
    what: "数据查询里的「今天」「本周」，以及定时巡检的「每天几点」，都按它算。已有记录按 UTC 存，改了不受影响。",
  },
  ui_theme: {
    label: "界面配色",
    impact: "now",
    what: "整个系统的主色调：按钮、链接、选中状态、文字、边框和背景的色调一起换。表示状态的颜色（通过是绿、失败是红、警告是橙）和图表里的数据颜色不变。所有用户一起切换，其他人刷新页面后生效。",
  },
  embedding_timeout: {
    label: "向量请求超时",
    unit: "秒",
    step: 10,
    impact: "now",
    what: "调用向量模型最多等多久。",
  },
  rerank_timeout: {
    label: "重排请求超时",
    unit: "秒",
    step: 5,
    impact: "now",
    what: "调用重排模型最多等多久。",
  },
  chunk_context_max_tokens: {
    label: "分片说明的输出上限",
    unit: "Token",
    step: 128,
    impact: "new_docs",
    what: "给每个分片写说明时，大模型最多输出多少。",
    why: "说明本身只有一两句，给 1024 是为了给推理模型的思考过程留额度；原来额度太小，半截思考过程被当成说明写进了分片。",
    effect:
      "调小，推理模型可能没写完就被截断，生成失败；调大，每个分片可能更贵。",
    when: "之后上传或补全的分片。",
  },
};

const IMPACT_TAGS: Record<Impact, { label: string; tone: Tone }> = {
  now: { label: "即时生效", tone: "success" },
  new_docs: { label: "只影响新文档", tone: "warning" },
  judgement: { label: "影响评测与巡检判断", tone: "accent" },
};
const THEME_LABELS: Record<string, string> = {
  blue: "蓝调",
  green: "绿调（青绿）",
  count: "按条数",
  tokens: "按 token 预算",
  log: "只记录",
  block: "拦截",
};
// 选项的显示文字：设置页下拉框和「为什么不生效」的原因共用。
function choiceLabel(value: unknown) {
  const text = String(value);
  return (
    THEME_LABELS[text] ??
    (TIMEZONE_LABELS[text] ? `${TIMEZONE_LABELS[text]}（${text}）` : text)
  );
}

const TIMEZONE_LABELS: Record<string, string> = {
  "Asia/Shanghai": "北京时间",
  "Asia/Hong_Kong": "香港",
  "Asia/Taipei": "台北",
  "Asia/Tokyo": "东京",
  "Asia/Singapore": "新加坡",
  "Europe/London": "伦敦",
  "Europe/Berlin": "柏林",
  "America/New_York": "纽约",
  "America/Los_Angeles": "洛杉矶",
  UTC: "UTC",
};

function formatValue(
  item: RuntimeSettingItem,
  value: RuntimeSettingValue | null | undefined,
) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "开" : "关";
  const meta = META[item.key];
  if (typeof value === "number" && meta?.percent)
    return `${Math.round(value * 100)}%`;
  if (item.key === "ui_theme" || item.key === "injection_vector_action")
    return THEME_LABELS[String(value)] ?? String(value);
  if (item.key === "business_tz")
    return `${TIMEZONE_LABELS[String(value)] ?? value}（${value}）`;
  return `${value}${meta?.unit ? ` ${meta.unit}` : ""}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 参数的中文名（评测记录里提示「参数改过」时用）。
export function settingLabel(key: string) {
  return META[key]?.label ?? key;
}

export default function SystemSettings({
  page,
  onToast,
}: {
  page: "rag" | "system";
  onToast: ShowToast;
}) {
  const [data, setData] = useState<RuntimeSettingsView | null>(null);
  // 每组各自的未保存修改：{参数: 新值}，null 表示恢复默认。
  const [drafts, setDrafts] = useState<
    Record<string, Record<string, RuntimeSettingValue | null>>
  >({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    getRuntimeSettings()
      .then(setData)
      .catch((reason: Error) => onToast("error", reason.message));
  }, []);

  const byKey = useMemo(
    () =>
      Object.fromEntries((data?.items ?? []).map((item) => [item.key, item])),
    [data],
  );

  function current(key: string) {
    for (const draft of Object.values(drafts)) {
      if (key in draft) return draft[key] === null ? null : draft[key];
    }
    return byKey[key]?.value;
  }

  // 这一项现在为什么不生效：按生效条件（后端 REQUIRES）和当前取值（含没保存的修改）逐条判断，改了依赖的项立刻更新。
  function inactiveReasons(item: RuntimeSettingItem) {
    return (item.requires ?? [])
      .filter((rule) => {
        const actual = current(rule.key);
        return (actual ?? byKey[rule.key]?.default) !== rule.equals;
      })
      .map((rule) => {
        const label = META[rule.key]?.label ?? rule.key;
        if (typeof rule.equals === "boolean")
          return rule.equals
            ? `「${label}」关闭，这一项不生效`
            : `「${label}」打开，这一项不生效`;
        const actual = current(rule.key) ?? byKey[rule.key]?.default;
        return `「${label}」是「${choiceLabel(actual)}」，这一项不生效；只在「${choiceLabel(rule.equals)}」时生效`;
      });
  }

  // 一行设置；卡片里和组里共用。
  function row(
    group: string,
    item: RuntimeSettingItem,
    draft: Record<string, unknown>,
  ) {
    return (
      <SettingRow
        key={item.key}
        item={item}
        value={current(item.key)}
        dirty={item.key in draft}
        reasons={inactiveReasons(item)}
        onChange={(value) => change(group, item.key, value)}
      />
    );
  }

  // 组里的设置按顺序显示；属于卡片的几项合成一张卡片，放在其中第一项原来的位置。
  function rows(
    group: string,
    list: RuntimeSettingItem[],
    draft: Record<string, unknown>,
  ) {
    const shown = new Set<string>();
    return list.flatMap((item) => {
      if (!item.card) return [row(group, item, draft)];
      if (shown.has(item.card)) return [];
      shown.add(item.card);
      const card = data?.cards?.[item.card];
      const members = (card?.keys ?? [item.key])
        .map((key) => list.find((entry) => entry.key === key))
        .filter((entry): entry is RuntimeSettingItem => Boolean(entry));
      return [
        <div className="sys-card" key={`card-${item.card}`}>
          <h3>{card?.title ?? item.card}</h3>
          {members.map((entry) => row(group, entry, draft))}
        </div>,
      ];
    });
  }

  function change(
    group: string,
    key: string,
    value: RuntimeSettingValue | null,
  ) {
    setDrafts((all) => {
      const draft = { ...(all[group] ?? {}) };
      const item = byKey[key];
      if (
        value !== null &&
        item &&
        value === item.value &&
        item.source === "settings"
      )
        delete draft[key];
      else if (value !== null && item && value === item.value)
        delete draft[key];
      else draft[key] = value;
      return { ...all, [group]: draft };
    });
  }

  async function save(group: string) {
    const changes = drafts[group] ?? {};
    setSaving(group);
    try {
      const value = await saveRuntimeSettings(changes);
      setData(value);
      // 改了界面配色就在当前页面立即切换。
      const theme = value.items.find((item) => item.key === "ui_theme");
      if (theme) applyTheme(String(theme.value));
      setDrafts((all) => ({ ...all, [group]: {} }));
      onToast(
        "success",
        value.changed?.length
          ? `已保存 ${value.changed.length} 项，${value.cache_seconds} 秒内所有服务生效`
          : "没有需要保存的修改",
      );
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setSaving(null);
    }
  }

  if (!data)
    return (
      <div className="settings-panel">
        <LoadingSkeleton label="正在加载配置">
          <SkeletonBlock className="skeleton-line" />
          <SkeletonBlock className="skeleton-line-short" />
        </LoadingSkeleton>
      </div>
    );
  // 最近修改只列本页签的参数。
  const pageOf = (key: string) =>
    data.pages?.[byKey[key]?.group ?? ""] ?? "rag";
  const history = data.history
    .map((entry) => ({
      ...entry,
      changes: entry.changes.filter((item) => pageOf(item.key) === page),
    }))
    .filter((entry) => entry.changes.length > 0);
  return (
    <div className="settings-panel sys-root">
      <p className="settings-hint sys-lead">
        {page === "rag"
          ? "影响检索和回答效果的参数，改了会改变评测分数。"
          : "和 RAG 效果无关的系统设置。"}
        没改过的项用代码默认值。保存后 {data.cache_seconds} 秒内 api 和 worker
        都会生效，不用重启。向量模型、重排模型、数据库连接等改了需要重建数据或重启的配置，在
        .env 里。
      </p>
      {Object.entries(data.groups)
        .filter(([group]) => (data.pages?.[group] ?? "rag") === page)
        .map(([group, title]) => {
          const items = data.items.filter((item) => item.group === group);
          const draft = drafts[group] ?? {};
          const dirty = Object.keys(draft);
          const warnings = new Set(
            dirty
              .map((key) => META[key]?.impact)
              .filter((impact) => impact && impact !== "now"),
          );
          return (
            <section key={group} className="settings-section sys-group">
              <div className="sys-group-head">
                <div>
                  <h2>{title}</h2>
                  <p className="settings-hint">{GROUP_INTROS[group]}</p>
                </div>
              </div>
              <div className="sys-items">
                {rows(
                  group,
                  items.filter((item) => !item.advanced),
                  draft,
                )}
              </div>
              {items.some((item) => item.advanced) && (
                <details
                  className="sys-advanced"
                  open={items.some(
                    (item) => item.advanced && item.key in draft,
                  )}
                >
                  <summary>高级</summary>
                  <div className="sys-items">
                    {rows(
                      group,
                      items.filter((item) => item.advanced),
                      draft,
                    )}
                  </div>
                </details>
              )}
              {dirty.length > 0 && (
                <div className="sys-save">
                  <span>
                    改了 {dirty.length} 项：
                    {dirty.map((key) => META[key]?.label ?? key).join("、")}
                  </span>
                  {warnings.has("judgement") && (
                    <span className="sys-warning">
                      会改变评测分数或巡检结论，改前改后的结果不能直接比较。
                    </span>
                  )}
                  {warnings.has("new_docs") && (
                    <span className="sys-warning">
                      只影响之后上传的文档，已有文档需要手动补全。
                    </span>
                  )}
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={saving === group}
                      onClick={() =>
                        setDrafts((all) => ({ ...all, [group]: {} }))
                      }
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={saving === group}
                      onClick={() => void save(group)}
                    >
                      {saving === group ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      {history.length > 0 && (
        <section className="settings-section sys-group">
          <h2>最近修改</h2>
          <ul className="sys-history">
            {history.map((entry) => (
              <li key={entry.at}>
                <span className="sys-history-time">
                  {formatTime(entry.at)} · {entry.by}
                </span>
                <span>
                  {entry.changes
                    .map(
                      (item) =>
                        `${META[item.key]?.label ?? item.key}：${byKey[item.key] ? formatValue(byKey[item.key], item.before) : item.before} → ${byKey[item.key] ? formatValue(byKey[item.key], item.after) : item.after}`,
                    )
                    .join("；")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// 一项设置。reasons 是这一项现在不生效的原因（生效条件不满足）：有原因时整项置灰、不能修改，并逐条写出原因。
function SettingRow({
  item,
  value,
  dirty,
  reasons,
  onChange,
}: {
  item: RuntimeSettingItem;
  value: RuntimeSettingValue | null | undefined;
  dirty: boolean;
  reasons: string[];
  onChange: (value: RuntimeSettingValue | null) => void;
}) {
  const disabled = reasons.length > 0;
  const meta = META[item.key] ?? {
    label: item.key,
    what: "",
    impact: "now" as Impact,
  };
  const [text, setText] = useState(
    value === null || value === undefined
      ? ""
      : String(
          meta.percent && typeof value === "number"
            ? Math.round(value * 100)
            : value,
        ),
  );
  const resetValue = item.default;
  const shown = value === null ? resetValue : value;
  useEffect(() => {
    setText(
      shown === undefined
        ? ""
        : String(
            meta.percent && typeof shown === "number"
              ? Math.round(shown * 100)
              : shown,
          ),
    );
  }, [shown]);
  const reset = value === null;
  const tag = IMPACT_TAGS[meta.impact];

  function commitNumber(raw: string) {
    setText(raw);
    if (raw.trim() === "") return;
    const number = Number(raw);
    if (Number.isNaN(number)) return;
    onChange(
      meta.percent
        ? Math.round(number) / 100
        : item.type === "int"
          ? Math.round(number)
          : number,
    );
  }

  const range =
    item.min !== undefined && item.max !== undefined
      ? meta.percent
        ? `${Math.round(item.min * 100)}%–${Math.round(item.max * 100)}%`
        : `${item.min}–${item.max}${meta.unit ? ` ${meta.unit}` : ""}`
      : null;
  const outOfRange =
    item.type !== "bool" &&
    item.type !== "choice" &&
    typeof shown === "number" &&
    item.min !== undefined &&
    item.max !== undefined &&
    (shown < item.min || shown > item.max);

  return (
    <div className={`sys-item ${disabled ? "is-disabled" : ""}`}>
      <div className="sys-item-main">
        <div className="sys-item-title">
          <strong>{meta.label}</strong>
          <Tag size="sm" plain outline tone={tag.tone}>
            {tag.label}
          </Tag>
        </div>
        <p className="sys-what">{meta.what}</p>
        {(meta.why || meta.effect || meta.when) && (
          <dl className="sys-notes">
            {meta.why && (
              <div>
                <dt>为什么是默认值</dt>
                <dd>
                  默认 {formatValue(item, item.default)}。{meta.why}
                </dd>
              </div>
            )}
            {meta.effect && (
              <div>
                <dt>改了会怎样</dt>
                <dd>{meta.effect}</dd>
              </div>
            )}
            {meta.when && (
              <div>
                <dt>什么时候生效</dt>
                <dd>{meta.when}</dd>
              </div>
            )}
          </dl>
        )}
        {disabled && (
          <ul className="sys-disabled-note">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="sys-item-control">
        {dirty && (
          <span className="sys-source is-dirty">
            {reset
              ? "未保存 · 将恢复为默认值"
              : `未保存 · 原来是 ${formatValue(item, item.value)}`}
          </span>
        )}
        {item.type === "bool" ? (
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(shown)}
            aria-label={meta.label}
            disabled={disabled}
            className={`sys-switch ${shown ? "is-on" : ""}`}
            onClick={() => onChange(!shown)}
          >
            <span />
          </button>
        ) : item.type === "choice" ? (
          <select
            value={String(shown)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            {(item.choices ?? [])
              .concat(
                item.choices?.includes(String(shown)) ? [] : [String(shown)],
              )
              .map((choice) => (
                <option key={choice} value={choice}>
                  {choiceLabel(choice)}
                </option>
              ))}
          </select>
        ) : (
          <label className="sys-number">
            <input
              type="number"
              value={text}
              disabled={disabled}
              step={meta.percent ? 5 : (meta.step ?? 1)}
              min={meta.percent ? (item.min ?? 0) * 100 : item.min}
              max={meta.percent ? (item.max ?? 1) * 100 : item.max}
              onChange={(event) => commitNumber(event.target.value)}
              aria-label={meta.label}
            />
            <span>{meta.percent ? "%" : (meta.unit ?? "")}</span>
          </label>
        )}
        {range && (
          <span className={`sys-range ${outOfRange ? "is-error" : ""}`}>
            {outOfRange ? "超出范围：" : "范围 "}
            {range}
          </span>
        )}
        {item.source === "settings" && !reset && (
          <button
            type="button"
            className="sys-reset"
            onClick={() => onChange(null)}
          >
            恢复默认（{formatValue(item, resetValue)}）
          </button>
        )}
      </div>
    </div>
  );
}
