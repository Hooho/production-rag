// Agent 模式的执行链（设计稿：问答页 · Agent 模式执行链）。
// 处理阶段里的「Agent 循环」这一步换成这里的视图：先是统计和每轮概览，再逐轮展开
// ① 收到（模型收到的输入，原样）→ ② 输出（接口原始响应和提取出的字段）→ ③ 程序处理 → ④ 工具返回。
// 每一轮的细节存在 agent_rounds 表，会话历史里只有摘要：刚问完的问题用流式推送收到的轮次，历史问题展开时再读取。
import React, {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  getAgentRun,
  type AgentCitation,
  type AgentMessage,
  type AgentRound,
  type AgentToolCall,
  type AgentToolResult,
  type TraceStep,
} from "./api";
import { formatDuration } from "./format";
import { huePicker } from "./hues";
import { Tag } from "./Tag";
import { DetailDialog } from "./DetailDialog";
import "./AgentTrace.css";

const TOOL_LABELS: Record<string, string> = {
  search_knowledge: "知识库检索",
  read_context: "读前后文",
  lookup_order: "订单查询",
  query_data: "业务数据",
};
// 工具颜色：按出现顺序分配色相（预设色相见 hues.ts，和专项题目的类型标签共用）。已有的 4 个工具先占前 4 个，之后新出现的工具依次往后排。
const toolHue = huePicker([
  "search_knowledge",
  "read_context",
  "lookup_order",
  "query_data",
]);
const KIND_LABELS: Record<string, string> = {
  forced: "强制回答轮 · 不带工具",
  citation_retry: "引用重写轮 · 不带工具",
};
const STOP_LABELS: Record<string, string> = {
  answered: "模型认为资料够了，自己结束",
  budget: "工具调用次数用完，程序要求直接回答",
  timeout: "处理时间到上限，程序要求直接回答",
  model_error: "模型调用失败",
  demo: "演示模式，没有调用模型",
};
const STATUS_LABELS: Record<string, string> = {
  ok: "已执行",
  error: "执行出错",
  duplicate: "重复调用，未执行",
  skipped: "超出预算，未执行",
};
const REASON_LABELS: Record<string, string> = {
  no_citation: "回答里没有资料编号",
  unknown_source: "引用了不存在的编号",
  invented_marker: "有不是资料编号的方括号标记",
};
const ROLE_LABELS: Record<string, string> = {
  system: "系统提示词",
  user: "用户消息",
  assistant: "模型上一轮的输出",
  tool: "工具返回",
};

function count(value: unknown) {
  return typeof value === "number" ? value.toLocaleString("en-US") : "—";
}

function percent(part: number, total: number) {
  return total > 0 ? Math.round((part * 100) / total) : 0;
}

function usageNumber(round: AgentRound, key: string) {
  const value = round.usage?.[key];
  return typeof value === "number" ? value : 0;
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return text;
  }
}

// 接口里 arguments 是 JSON 字符串；展示时解析成对象，和设计稿一样按编辑器的颜色格式化。
function readableCalls(calls: AgentToolCall[]) {
  return calls.map((call) => ({
    id: call.id,
    type: call.type ?? "function",
    function: {
      name: call.function?.name,
      arguments: parseArguments(call.function?.arguments),
    },
  }));
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],]/g;

function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const [token, string, colon, literal] = match;
    if (string && colon)
      nodes.push(
        <span className="jk" key={index}>
          {string}
        </span>,
        <span className="jp" key={`${index}c`}>
          {colon}
        </span>,
      );
    else if (string)
      nodes.push(
        <span className="js" key={index}>
          {string}
        </span>,
      );
    else if (literal)
      nodes.push(
        <span className="jb" key={index}>
          {literal}
        </span>,
      );
    else if (/^[{}[\],]$/.test(token))
      nodes.push(
        <span className="jp" key={index}>
          {token}
        </span>,
      );
    else
      nodes.push(
        <span className="jn" key={index}>
          {token}
        </span>,
      );
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// 超过 10 行的内容默认只显示前 10 行，下面放「展开更多」。按实际渲染高度判断，自动换行出来的行也算。
// 所在的折叠块没展开时量不到高度，ResizeObserver 会在展开后重新判断。
function Clamp({
  className,
  children,
  as = "pre",
  id,
}: {
  className?: string;
  children: ReactNode;
  as?: "pre" | "div";
  id?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const check = () =>
      setOver(element.scrollHeight > element.clientHeight + 2);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, open]);
  const Tag = as as "div";
  // 按钮颜色跟着内容块的底色走（推理过程紫、答案琥珀、工具返回绿……），tone 从内容块的类名里取。
  const tone =
    (className ?? "")
      .split(/\s+/)
      .find((name) =>
        ["think", "final", "ret", "raw", "agent-json", "agent-qa-row"].includes(
          name,
        ),
      ) ?? "plain";
  return (
    <div
      className={`agent-clamp-wrap tone-${tone} ${over && !open ? "is-clamped" : ""}`}
    >
      <Tag
        ref={ref as React.RefObject<HTMLDivElement>}
        id={id}
        className={`${className ?? ""} agent-clamp ${open ? "open" : ""}`}
      >
        {children}
      </Tag>
      {(over || open) && (
        <button
          type="button"
          className="agent-more"
          onClick={() => setOpen(!open)}
        >
          {open ? "收起" : "展开更多"}
        </button>
      )}
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  return (
    <Clamp className="agent-pre agent-json">
      {highlightJson(JSON.stringify(value, null, 2))}
    </Clamp>
  );
}

function ToolTag({ name }: { name: string }) {
  return (
    <Tag size="sm" mono hue={toolHue(name)} title={TOOL_LABELS[name]}>
      {name}
    </Tag>
  );
}

// 工具返回消息里只有 tool_call_id，按同一组里模型的 tool_calls 找回工具名。
function toolNameOf(messages: AgentMessage[], message: AgentMessage) {
  for (const item of messages)
    for (const call of item.tool_calls ?? [])
      if (call.id === message.tool_call_id) return call.function?.name;
  return undefined;
}

function EvidenceId({
  id,
  fresh = false,
  cited = false,
}: {
  id: string;
  fresh?: boolean;
  cited?: boolean;
}) {
  const kind = id[0] === "O" ? "o" : id[0] === "D" ? "d" : "s";
  // 编号的颜色跟着产出它的工具：S 是 search_knowledge，O 是 lookup_order，D 是 query_data。
  const hue = toolHue(
    kind === "o"
      ? "lookup_order"
      : kind === "d"
        ? "query_data"
        : "search_knowledge",
  );
  return (
    <span
      className={`agent-rid ${kind} ${fresh ? "new" : ""} ${cited ? "cited" : ""}`}
      style={{ "--tool-h": hue } as React.CSSProperties}
      title={cited ? "回答引用了这条" : undefined}
    >
      {fresh ? "+" : ""}
      {id}
    </span>
  );
}

function evidenceIds(result: AgentToolResult) {
  const trace = result.trace ?? {};
  if (Array.isArray(trace.evidence_ids)) return trace.evidence_ids as string[];
  if (typeof trace.evidence_id === "string") return [trace.evidence_id];
  return [];
}

// 输入里的缓存命中：浅色是和上一轮相同、命中前缀缓存的部分，深色是本轮新增、按原价计费的部分。
function CacheBar({
  prompt,
  cached,
  first,
}: {
  prompt: number;
  cached: number;
  first: boolean;
}) {
  const hit = percent(cached, prompt);
  return (
    <div
      className="agent-cache"
      role="img"
      aria-label={`输入 ${prompt} tok，命中缓存 ${cached}`}
    >
      <div className="agent-cache-bar">
        <i className="hit" style={{ width: `${hit}%` }} />
        <i className="new" style={{ width: `${100 - hit}%` }} />
      </div>
      <div className="agent-cache-text">
        <span>
          本轮输入 <b>{count(prompt)}</b> tok
        </span>
        <span className="hit-text">
          命中缓存 <b>{count(cached)}</b> tok（{hit}%）
        </span>
        <span className="new-text">
          新增 <b>{count(prompt - cached)}</b> tok（{100 - hit}%）
          {first ? "：第 1 轮没有可复用的前缀" : "：本轮追加的消息，按原价计费"}
        </span>
      </div>
    </div>
  );
}

// 整次问答的统计：模型、结束原因、工具调用、引用检查、Token 和每轮缓存命中。
function Summary({ result }: { result: Record<string, unknown> }) {
  const citation = result.citation_check as AgentCitation | null | undefined;
  const usage = (result.token_usage ?? {}) as Record<string, number>;
  const cache = result.cache_hits as
    | {
        prompt_tokens: number;
        cached_tokens: number;
        hit_rate: number | null;
        rounds: Array<{
          round: number;
          kind: string;
          prompt_tokens: number;
          cached_tokens: number;
        }>;
      }
    | undefined;
  const evidence = Array.isArray(result.evidence)
    ? (result.evidence as string[])
    : [];
  const widest = Math.max(
    1,
    ...(cache?.rounds ?? []).map((item) => item.prompt_tokens),
  );
  return (
    <div className="agent-summary">
      <div className="agent-summary-row">
        <span>模型</span>
        <div>
          {String(result.model_called ?? "—")}
          <small>
            {String(result.call_method ?? "")} · 提示词{" "}
            {String(result.prompt_version ?? "")}
          </small>
        </div>
      </div>
      <div className="agent-summary-row">
        <span>结束原因</span>
        <div>
          {STOP_LABELS[String(result.stop_reason)] ??
            String(result.stop_reason ?? "—")}
          <small>
            {count(result.rounds)} 轮 · 调用工具 {count(result.tool_calls)} /{" "}
            {count(result.tool_budget)} 次
          </small>
        </div>
      </div>
      <div className="agent-summary-row">
        <span>资料检索结果</span>
        <div>
          {evidence.length
            ? evidence.map((id) => <EvidenceId key={id} id={id} />)
            : "没有调用工具或没有查到资料"}
        </div>
      </div>
      <div className="agent-summary-row">
        <span>引用检查</span>
        <div>
          {!citation ? (
            "资料池为空，不检查"
          ) : citation.passed ? (
            <>
              通过 · 引用{" "}
              {citation.cited.map((id) => (
                <EvidenceId key={id} id={id} />
              ))}
            </>
          ) : (
            <span className="agent-warn">
              没通过：
              {REASON_LABELS[String(citation.reason)] ?? citation.reason}
              ，已替换成拒答文字
            </span>
          )}
          {result.citation_retried === true && (
            <small>第一次没通过，让模型重写了一次</small>
          )}
        </div>
      </div>
      <div className="agent-summary-row">
        <span>Token</span>
        <div>
          输入 {count(usage.prompt_tokens)} · 输出{" "}
          {count(usage.completion_tokens)} · 命中缓存{" "}
          {count(usage.cached_tokens)}
          {cache?.hit_rate != null
            ? `（${Math.round(cache.hit_rate * 100)}%）`
            : ""}
        </div>
      </div>
      {cache && cache.rounds.length > 0 && (
        <div className="agent-summary-row">
          <span>缓存命中</span>
          <div className="agent-bars">
            {cache.rounds.map((item) => (
              <div className="agent-bar-row" key={item.round}>
                <span>
                  第 {item.round} 轮
                  {item.kind === "forced"
                    ? "（强制）"
                    : item.kind === "citation_retry"
                      ? "（重写）"
                      : ""}
                </span>
                <div className="agent-bar-track">
                  <i
                    className="hit"
                    style={{ width: `${(item.cached_tokens * 100) / widest}%` }}
                  />
                  <i
                    className="new"
                    style={{
                      width: `${((item.prompt_tokens - item.cached_tokens) * 100) / widest}%`,
                    }}
                  />
                </div>
                <strong>{count(item.prompt_tokens)}</strong>
                <small>
                  命中 {count(item.cached_tokens)} ·{" "}
                  {percent(item.cached_tokens, item.prompt_tokens)}%
                </small>
              </div>
            ))}
            <small>
              浅色是命中缓存（和上一轮相同的前缀），深色是本轮新增。强制回答轮和引用重写轮不带工具，前缀变了，命中会明显下降。
            </small>
          </div>
        </div>
      )}
    </div>
  );
}

// 每一轮做了什么：一行一次工具调用；没有调用工具的一轮写成直接回答。
function Overview({ rounds }: { rounds: AgentRound[] }) {
  const seen = new Set<string>();
  return (
    <div className="agent-table-wrap">
      <table className="agent-table">
        <thead>
          <tr>
            <th>轮次</th>
            <th>模型的决定</th>
            <th>工具调用参数</th>
            <th>结果</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((round) => {
            const results = round.tool_results ?? [];
            if (results.length === 0) {
              const label = round.error
                ? "调用失败"
                : round.kind === "forced"
                  ? "强制回答"
                  : round.kind === "citation_retry"
                    ? "重写回答"
                    : "直接回答";
              return (
                <tr key={round.round} className="round-start">
                  <td>第 {round.round} 轮</td>
                  <td>
                    <Tag size="sm" mono outline>
                      {label}
                    </Tag>
                  </td>
                  <td>
                    <span className="agent-muted">无（没有调用工具）</span>
                  </td>
                  <td>
                    {round.citation_check ? (
                      <>
                        {round.citation_check.passed
                          ? "引用 "
                          : "引用检查没通过 "}
                        {round.citation_check.cited.map((id) => (
                          <EvidenceId key={id} id={id} />
                        ))}
                      </>
                    ) : round.error ? (
                      <span className="agent-warn">{round.error}</span>
                    ) : (
                      ""
                    )}
                  </td>
                  <td>{formatDuration(round.duration_ms)}</td>
                </tr>
              );
            }
            return results.map((result, index) => {
              const ids = evidenceIds(result);
              const args = parseArguments(result.arguments);
              return (
                <tr
                  key={`${round.round}-${index}`}
                  className={index === 0 ? "round-start" : undefined}
                >
                  {index === 0 && (
                    <td rowSpan={results.length}>
                      第 {round.round} 轮
                      {results.length > 1 && (
                        <small>同时调用 {results.length} 个</small>
                      )}
                    </td>
                  )}
                  <td>
                    <ToolTag name={result.name} />
                  </td>
                  <td>
                    {args && typeof args === "object" ? (
                      <table
                        className="agent-param-table tool-tinted-table"
                        style={
                          {
                            "--tool-h": toolHue(result.name),
                          } as React.CSSProperties
                        }
                      >
                        <tbody>
                          {Object.entries(args as Record<string, unknown>).map(
                            ([key, value]) => (
                              <tr key={key}>
                                <th>{key}</th>
                                <td>
                                  <code>
                                    {typeof value === "string"
                                      ? value
                                      : JSON.stringify(value)}
                                  </code>
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    ) : (
                      <code>{String(args)}</code>
                    )}
                  </td>
                  <td>
                    {result.status !== "ok" ? (
                      <span className="agent-warn">
                        {STATUS_LABELS[result.status]}
                      </span>
                    ) : ids.length ? (
                      ids.map((id) => {
                        const fresh = !seen.has(id);
                        seen.add(id);
                        return <EvidenceId key={id} id={id} fresh={fresh} />;
                      })
                    ) : (
                      <span className="agent-muted">没有资料</span>
                    )}
                  </td>
                  {index === 0 && (
                    <td rowSpan={results.length}>
                      {formatDuration(round.duration_ms)}
                    </td>
                  )}
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

function Flow({
  kind,
  no,
  title,
  meta,
  children,
}: {
  kind: "in" | "out" | "prog" | "ret" | "next";
  no: string;
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <details className={`agent-flow-step ${kind}`}>
      <summary>
        <span className="agent-flow-no">{no}</span>
        <strong>{title}</strong>
        <span className="agent-flow-meta">{meta}</span>
      </summary>
      <div className="agent-flow-body">{children}</div>
    </details>
  );
}

function TraceContent({
  title,
  label,
  children,
  className = "",
  id,
  style,
}: {
  title: string;
  label: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className} style={style}>
      <button
        type="button"
        id={id}
        className="agent-content-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {label}
        <span className="agent-content-open" aria-hidden="true">
          ↗
        </span>
      </button>
      {open && (
        <DetailDialog
          open
          title={title}
          onClose={() => setOpen(false)}
          className="agent-content-dialog"
        >
          <div className="agent-content-body">{children}</div>
        </DetailDialog>
      )}
    </div>
  );
}

function Field({
  name,
  note,
  children,
  raw = false,
  tag,
}: {
  name: string;
  note: string;
  children: ReactNode;
  raw?: boolean;
  tag?: string;
}) {
  return (
    <TraceContent
      className={`agent-field ${raw ? "raw" : ""}`}
      title={name}
      label={
        <>
          {tag && <span className="agent-field-tag">{tag}</span>}
          <b>{name}</b>
          <span> · {note}</span>
        </>
      }
    >
      {children}
    </TraceContent>
  );
}

function messageText(message: AgentMessage) {
  return typeof message.content === "string" ? message.content : "";
}

function FieldLabel({ name, note }: { name: string; note: string }) {
  return (
    <div className="agent-msg-field">
      <span className="agent-field-tag">AI 响应字段</span>
      <b>{name}</b>
      <span>· {note}</span>
    </div>
  );
}

// 一条消息的正文：assistant 可能带推理过程和工具调用，其他角色只有文字。
function MessageBody({ message }: { message: AgentMessage }) {
  const text = messageText(message);
  // 模型上一轮的输出原样放回消息里：每块标明是哪个响应字段，和「② 输出」里的写法一致。
  return message.role === "assistant" ? (
    <>
      {message.reasoning_content && (
        <>
          <FieldLabel name="reasoning_content" note="推理过程" />
          <Clamp className="agent-pre think">{message.reasoning_content}</Clamp>
        </>
      )}
      {text && (
        <>
          <FieldLabel name="content" note="文字回复" />
          <Clamp className="agent-pre">{text}</Clamp>
        </>
      )}
      {message.tool_calls && message.tool_calls.length > 0 && (
        <>
          <FieldLabel name="tool_calls" note="工具调用" />
          <JsonView value={readableCalls(message.tool_calls)} />
        </>
      )}
    </>
  ) : (
    <Clamp className={`agent-pre ${message.role === "tool" ? "ret" : ""}`}>
      {text || "（空）"}
    </Clamp>
  );
}

function MessageBlock({
  message,
  anchor,
  name,
  tool,
}: {
  message: AgentMessage;
  anchor: string;
  name?: string;
  tool?: string;
}) {
  return (
    <details className={`agent-message role-${message.role}`} id={anchor}>
      <summary>
        <span>
          {name ?? ROLE_LABELS[message.role] ?? ""}
          {tool && (
            <>
              {" "}
              <ToolTag name={tool} />
            </>
          )}
          {message.tool_call_id ? ` · ${message.tool_call_id}` : ""}
        </span>
        <small>{messageText(message).length} 字</small>
      </summary>
      <MessageBody message={message} />
    </details>
  );
}

// group / kind：这条消息第一次出现时属于哪一组、哪一类，后面轮次的“和之前一样”列表按组合并、按类上色。
type Placed = {
  message: AgentMessage;
  round: number;
  index: number;
  name: string;
  group: string;
  kind: GroupKind;
};
type GroupKind =
  | "system"
  | "memory"
  | "question"
  | "model"
  | "tool"
  | "prompt"
  | "loop";
// loop：本次问答前面几轮 Agent 循环留下的消息（模型的工具调用决策 + 工具返回结果，或模型的回答 + 程序追加的提示），
// 整组算作循环历史，和“历史问答”（之前的提问）区分开。
const KIND_TEXT: Record<GroupKind, string> = {
  system: "系统",
  memory: "记忆",
  question: "问题",
  model: "模型输出",
  tool: "工具",
  prompt: "程序提示",
  loop: "循环历史",
};
// 消息类型的颜色：分类色，按上面的顺序固定取色（hues.ts）。
const kindHue = huePicker(Object.keys(KIND_TEXT));
// 模型调用叫“第 N 轮”；带上的之前的提问按离本轮多远命名（上一次提问、前 2 次提问……），
// 不写成 1、2、3：带上的只是最近几次（更早的已压进摘要），编号容易被当成会话里的第几次提问。
function earlierLabel(number: number, total: number) {
  const distance = total - number;
  return distance === 1 ? "上一次提问" : `前 ${distance} 次提问`;
}
// pairs：记忆这一组里每一次历史问答（问题、回答）的下标，分别再圈一个小框。
type MemorySection = { title: string; text: string };
type MessageGroup = {
  label: string;
  note: string;
  items: number[];
  kind?: GroupKind;
  names?: string[];
  pairs?: number[][];
  // 从本轮用户消息开头的 <memory> 里拆出来单独显示的部分（长期记忆、对话摘要、最近订单），question 是去掉记忆后的问题。
  sections?: MemorySection[];
  question?: string;
  virtual?: boolean;
};

// 拆开本轮用户消息：<memory> 里按“## 标题”分段，后面“本轮问题：”之后是用户的原话。没有 <memory> 时整条就是问题。
function splitMemory(text: string): {
  sections: MemorySection[];
  question: string;
} {
  const match = text.match(/^<memory>\n([\s\S]*?)\n?<\/memory>\n?([\s\S]*)$/);
  if (!match) return { sections: [], question: text };
  const sections = match[1]
    .split(/^## /m)
    .filter((part) => part.trim())
    .map((part) => {
      const [title, ...rest] = part.split("\n");
      return { title: title.trim(), text: rest.join("\n").trim() };
    });
  return { sections, question: match[2].replace(/^本轮问题：/, "").trim() };
}

// 把本轮新增的消息按“属于哪一次问答 / 哪一轮”分组，每组用一个框圈起来：
// 系统提示词、记忆（最近几轮问答，每轮一个小框）、本轮问题；后面的轮次是上一轮模型的工具调用 + 工具返回、
// 或者上一轮的回答 + 程序追加的提示（引用检查的修改提示、强制回答的提示）。
function groupMessages(
  messages: AgentMessage[],
  roundNo: number,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    const next = messages[index + 1];
    if (message.role === "system") {
      groups.push({
        label: "系统提示词",
        note: "工作方式、规则、今天日期",
        items: [index],
        kind: "system",
      });
      index += 1;
    } else if (
      message.role === "user" &&
      next?.role === "assistant" &&
      !next.tool_calls?.length &&
      roundNo === 1
    ) {
      // 第 1 轮里本轮问题之前的问答都是记忆：读取记忆这一步从 Checkpointer 取出的压缩后保留的原文，写成真实的 user / assistant 消息。
      let memory = groups.find((group) => group.pairs);
      if (!memory) {
        memory = {
          label: "本对话记忆",
          note: "这个会话里的短期记忆",
          items: [],
          pairs: [],
          kind: "memory",
        };
        groups.push(memory);
      }
      memory.items.push(index, index + 1);
      memory.pairs!.push([index, index + 1]);
      index += 2;
    } else if (message.role === "assistant" && message.tool_calls?.length) {
      const items = [index];
      index += 1;
      while (index < messages.length && messages[index].role === "tool")
        items.push(index++);
      groups.push({
        label: `第 ${roundNo - 1} 轮 Agent 调用详情：模型调用工具决策 + 工具返回结果`,
        note: "上一轮的输出和程序放回的结果",
        items,
        kind: "loop",
      });
    } else if (message.role === "assistant") {
      const items = next?.role === "user" ? [index, index + 1] : [index];
      groups.push({
        label: `第 ${roundNo - 1} 轮 Agent 调用详情：模型的回答${items.length > 1 ? " + 程序追加的提示" : ""}`,
        note: "上一轮没有调用工具，程序检查后要求它继续",
        items,
        kind: "loop",
        names: ["模型上一轮的回答", "程序追加的提示"],
      });
      index += items.length;
    } else {
      if (roundNo === 1) {
        // 本轮用户消息开头的 <memory>：长期记忆单独成组；对话摘要、最近订单属于本对话记忆，放进那一组。
        const { sections, question } = splitMemory(messageText(message));
        const longTerm = sections.filter(
          (section) => section.title === "用户偏好",
        );
        const session = sections.filter(
          (section) => section.title !== "用户偏好",
        );
        if (longTerm.length) {
          // 长期记忆排在本对话记忆前面：先是跨会话的，再是这个会话的。
          const at = groups.findIndex((group) => group.pairs);
          groups.splice(at < 0 ? groups.length : at, 0, {
            label: "长期记忆",
            note: "跨会话记住的用户偏好、身份（LangGraph Store），实际放在本轮用户消息开头的 <memory> 里",
            items: [],
            sections: longTerm,
            virtual: true,
          });
        }
        if (session.length) {
          let memory = groups.find((group) => group.pairs);
          if (!memory) {
            memory = {
              label: "本对话记忆",
              note: "这个会话里的短期记忆",
              items: [],
              pairs: [],
              kind: "memory",
            };
            groups.push(memory);
          }
          memory.sections = session;
        }
        groups.push({
          label: "本轮问题",
          note: "用户这次的问题",
          items: [index],
          names: ["本轮问题"],
          question,
          kind: "question",
        });
      } else {
        groups.push({
          label: "程序追加的提示",
          note: "引用检查或预算、超时后程序发给模型的话",
          items: [index],
          names: ["程序追加的提示"],
          kind: "prompt",
        });
      }
      index += 1;
    }
  }
  return groups;
}

// 每条消息在页面上的中文名字，后面轮次的“和之前完全一样”列表用它，不再显示 system / user 这些角色名。
function messageNames(messages: AgentMessage[], roundNo: number) {
  const names: string[] = messages.map(
    (message) => ROLE_LABELS[message.role] ?? message.role,
  );
  const groups: { label: string; kind: GroupKind }[] = messages.map(() => ({
    label: "",
    kind: "model",
  }));
  for (const group of groupMessages(messages, roundNo)) {
    const label = group.pairs
      ? `本对话记忆 · 最近 ${group.pairs.length} 次提问`
      : group.label;
    group.items.forEach((index) => {
      groups[index] = { label, kind: group.kind ?? "model" };
    });
    if (group.pairs)
      group.pairs.forEach((pair, number) => {
        names[pair[0]] = `${earlierLabel(number, group.pairs!.length)}的问题`;
        names[pair[1]] = `${earlierLabel(number, group.pairs!.length)}的回答`;
      });
    else if (!group.virtual)
      group.items.forEach((index, position) => {
        const message = messages[index];
        names[index] =
          group.names?.[position] ??
          (message.role === "tool"
            ? `工具返回（${message.tool_call_id ?? ""}）`
            : message.role === "assistant"
              ? "模型调用工具决策"
              : group.label);
      });
  }
  return { names, groups };
}

// 「① 收到」里的输入清单：按接口请求的真实结构排，一个框装下 tools 和 messages。
// messages 是一张连续的表，每行同一种样式：序号（消息在请求里的位置）、类型、名称、大小。
// 之前轮次已有的消息排在上面，按组合并；所有消息均点击打开内容弹窗。
function range(first: number, last: number) {
  return first === last ? `#${first}` : `#${first}–${last}`;
}

function InputRow({
  no,
  kind,
  label,
  note,
  size,
  id,
  children,
  hue,
}: {
  no: string;
  kind: GroupKind;
  label: ReactNode;
  note?: ReactNode;
  size: string;
  id?: string;
  children: ReactNode;
  hue?: number;
}) {
  const head = (
    <>
      <span className="agent-input-no">{no}</span>
      <Tag size="sm" hue={kindHue(kind)} className="agent-kind">
        {KIND_TEXT[kind]}
      </Tag>
      <strong>{label}</strong>
      {note && <span className="agent-input-note">{note}</span>}
      <small>{size}</small>
    </>
  );
  // hue：工具返回的消息按工具颜色着色（和 ③④ 里同一个工具的卡片一致）。
  return (
    <TraceContent
      className={`agent-input-row ${hue !== undefined ? "tool-tinted-row" : ""}`}
      id={id}
      title={`${no} · ${typeof label === "string" ? label : KIND_TEXT[kind]}`}
      style={
        hue !== undefined
          ? ({ "--tool-h": hue } as React.CSSProperties)
          : undefined
      }
      label={head}
    >
      {children}
    </TraceContent>
  );
}

function RequestInput({
  round,
  before,
  anchor,
  startIndex,
}: {
  round: AgentRound;
  before: Placed[];
  anchor: string;
  startIndex: number;
}) {
  const messages = round.new_messages;
  const position = (index: number) => startIndex + index + 1;
  const reused: { first: Placed; items: Placed[] }[] = [];
  for (const item of before) {
    const last = reused[reused.length - 1];
    if (
      last &&
      last.first.round === item.round &&
      last.first.group === item.group
    )
      last.items.push(item);
    else reused.push({ first: item, items: [item] });
  }
  const groups = groupMessages(messages, round.round);
  const questionIndex = groups.find((group) => group.kind === "question")
    ?.items[0];
  const insideQuestion =
    questionIndex === undefined
      ? ""
      : `写在 #${position(questionIndex)} 开头的 <memory> 里`;
  const rows: ReactNode[] = [];
  for (const group of groups) {
    const sectionChars = (group.sections ?? []).reduce(
      (sum, section) => sum + section.text.length,
      0,
    );
    const chars =
      group.items.reduce(
        (sum, index) => sum + messageText(messages[index]).length,
        0,
      ) + sectionChars;
    if (group.virtual) {
      // 长期记忆：从本轮问题那条消息里拆出来的，没有单独的一条消息。展开直接列出所有条目。
      rows.push(
        <InputRow
          key="long-term"
          no={questionIndex === undefined ? "—" : `#${position(questionIndex)}`}
          kind="memory"
          label="长期记忆"
          note={insideQuestion}
          size={`${chars} 字`}
        >
          <Clamp className="agent-pre">
            {(group.sections ?? [])
              .map((section) => section.text)
              .filter(Boolean)
              .join("\n")}
          </Clamp>
        </InputRow>,
      );
    } else if (group.pairs) {
      // 本对话记忆：带上的最近几次提问（每次一问一答两条消息），加上写在本轮问题开头的对话摘要、最近订单。
      const no = group.items.length
        ? range(
            position(group.items[0]),
            position(group.items[group.items.length - 1]),
          )
        : `#${position(questionIndex ?? 0)}`;
      const parts = [
        group.pairs.length ? `最近 ${group.pairs.length} 次提问` : "",
        group.sections?.length
          ? `${group.sections.map((section) => section.title.replace(/^之前的/, "")).join("、")}（${insideQuestion}）`
          : "",
      ].filter(Boolean);
      rows.push(
        <InputRow
          key="memory"
          no={no}
          kind="memory"
          label="本对话记忆"
          note={parts.join(" + ")}
          size={`${chars} 字`}
        >
          {(group.sections ?? []).map((section) => (
            <details className="agent-msg-pair" key={section.title}>
              <summary>
                <strong>{section.title}</strong>
                <small>{section.text.length} 字</small>
              </summary>
              <Clamp className="agent-pre">{section.text}</Clamp>
            </details>
          ))}
          {group.pairs.map((pair, number) => (
            <details className="agent-msg-pair" key={pair[0]}>
              <summary>
                <strong>{earlierLabel(number, group.pairs!.length)}</strong>
                <small>
                  {pair.reduce(
                    (sum, index) => sum + messageText(messages[index]).length,
                    0,
                  )}{" "}
                  字
                </small>
              </summary>
              <div className="agent-qa">
                {pair.map((index, side) => (
                  <Clamp
                    as="div"
                    className="agent-qa-row"
                    key={index}
                    id={`${anchor}-m${startIndex + index}`}
                  >
                    <strong>{side === 0 ? "问题：" : "答案："}</strong>
                    <span>{messageText(messages[index])}</span>
                  </Clamp>
                ))}
              </div>
            </details>
          ))}
        </InputRow>,
      );
    } else if (group.kind === "question") {
      const index = group.items[0];
      rows.push(
        <InputRow
          key={index}
          no={`#${position(index)}`}
          kind="question"
          label="本轮问题"
          size={`${(group.question ?? messageText(messages[index])).length} 字`}
          id={`${anchor}-m${startIndex + index}`}
        >
          <Clamp className="agent-pre">
            {group.question ?? messageText(messages[index])}
          </Clamp>
        </InputRow>,
      );
    } else {
      // 系统提示词、上一轮的输出、工具返回、程序追加的提示：一条消息一行。
      for (const index of group.items) {
        const message = messages[index];
        const tool =
          message.role === "tool" ? toolNameOf(messages, message) : undefined;
        const kind: GroupKind =
          message.role === "system"
            ? "system"
            : message.role === "tool"
              ? "tool"
              : message.role === "assistant"
                ? "model"
                : "prompt";
        // 本轮新增的这些消息都来自上一轮：上一轮模型的输出、上一轮执行工具的返回、上一轮结束后程序追加的提示。
        // 名称里写明是第几轮的，免得以为是本轮产生的。
        const previous = round.round - 1;
        const label =
          message.role === "system" ? (
            "系统提示词"
          ) : message.role === "tool" ? (
            <>
              第 {previous} 轮的工具返回结果 {tool && <ToolTag name={tool} />}
            </>
          ) : message.role === "assistant" ? (
            message.tool_calls?.length ? (
              <>
                第 {previous} 轮的工具调用决策{" "}
                {message.tool_calls.map((call, position) => (
                  <ToolTag
                    key={call.id ?? position}
                    name={call.function?.name ?? "?"}
                  />
                ))}
              </>
            ) : (
              `第 ${previous} 轮的回答`
            )
          ) : (
            `第 ${previous} 轮结束后程序追加的提示${round.kind === "forced" ? "（要求直接回答）" : round.kind === "citation_retry" ? "（要求重写回答）" : ""}`
          );
        rows.push(
          <InputRow
            key={index}
            no={`#${position(index)}`}
            kind={kind}
            label={label}
            note={message.tool_call_id}
            size={`${messageText(message).length} 字`}
            id={`${anchor}-m${startIndex + index}`}
            hue={tool ? toolHue(tool) : undefined}
          >
            <MessageBody message={message} />
          </InputRow>,
        );
      }
    }
  }
  return (
    <div className="agent-input">
      <div className="agent-input-title">本次请求的输入</div>
      <div className="agent-input-section">
        <div className="agent-input-head">
          <code>tools</code>
          <span>
            {round.tools_sent.length
              ? `${round.tools_sent.length} 个`
              : "不带工具，模型只能直接回答"}
          </span>
        </div>
        {round.tools_sent.length > 0 && (
          <div className="agent-input-tools">
            {round.tools_sent.map((name) => (
              <ToolTag key={name} name={name} />
            ))}
          </div>
        )}
      </div>
      <div className="agent-input-section">
        <div className="agent-input-head">
          <code>messages</code>
          <span>{round.message_count} 条</span>
          {before.length > 0 && <small>新增 {messages.length}</small>}
        </div>
        <div className="agent-input-rows">
          {reused.map(({ first, items }) => (
            <InputRow
              key={`reused-${first.index}`}
              no={range(first.index + 1, items[items.length - 1].index + 1)}
              kind={first.kind}
              label={first.group}
              size={`${items.length} 条`}
            >
              {items.map((item) => (
                <div key={item.index}>
                  <strong>
                    #{item.index + 1} · {item.name}
                  </strong>
                  <MessageBody message={item.message} />
                </div>
              ))}
            </InputRow>
          ))}
          {before.length > 0 && messages.length > 0 && (
            <div className="agent-input-divider">以下为本轮新增</div>
          )}
          {rows}
        </div>
      </div>
    </div>
  );
}

// 程序对一次工具调用做了什么：参数、执行状态、关键结果（检索漏斗、查询计划、读到的位置）。
function ProgramItem({ result }: { result: AgentToolResult }) {
  const trace = result.trace ?? {};
  const retrieval = trace.retrieval as
    | { stats?: Record<string, unknown> }
    | undefined;
  const stats = retrieval?.stats ?? {};
  const ids = evidenceIds(result);
  // 每次工具调用一张可折叠的卡片，默认展开；标题行写工具、执行状态、耗时、剩余预算和返回了几条资料，收起后也能看个大概。
  return (
    <details
      className="agent-prog-item tool-tinted"
      open
      style={{ "--tool-h": toolHue(result.name) } as React.CSSProperties}
    >
      <summary className="agent-prog-head">
        <ToolTag name={result.name} />
        <Tag
          size="sm"
          plain
          tone={result.status === "ok" ? "success" : "danger"}
        >
          {STATUS_LABELS[result.status] ?? result.status}
        </Tag>
        {typeof result.duration_ms === "number" && (
          <small>{formatDuration(result.duration_ms)}</small>
        )}
        {typeof result.budget_left === "number" && (
          <small>剩余预算 {result.budget_left} 次</small>
        )}
        {ids.length > 0 && <small>返回 {ids.length} 条资料</small>}
      </summary>
      <div className="agent-block-label">
        模型给出的参数<code>tool_calls.arguments</code>
      </div>
      <JsonView value={parseArguments(result.arguments)} />
      <ul className="agent-prog-list">
        {result.status === "duplicate" && (
          <li>工具名和参数都和之前某一轮完全相同，程序没有再执行，不占预算</li>
        )}
        {result.status === "skipped" && (
          <li>这一轮调用的工具超过了剩余预算，超出的部分没有执行</li>
        )}
        {result.name === "read_context" && Array.isArray(trace.positions) && (
          <li>
            读取 {String(trace.source_id)} 的
            {trace.direction === "before" ? "前文" : "后文"}：第{" "}
            {(trace.positions as number[]).join("、")} 片
          </li>
        )}
        {result.name === "lookup_order" && trace.found === false && (
          <li>
            没有找到：订单不存在，或者当前用户没有权限查看（两种情况返回同一句话）
          </li>
        )}
        {typeof trace.error === "string" && (
          <li className="agent-warn">{trace.error}</li>
        )}
      </ul>
      {result.name === "search_knowledge" && retrieval && (
        <RetrievalFunnel stats={stats} topK={trace.top_k} given={ids.length} />
      )}
      {result.name === "query_data" && trace.plan != null && result.ok && (
        <>
          <div className="agent-block-label">
            程序校验后，实际用来生成 SQL 的查询计划
            <span>
              校验字段、操作符、权限，并补上默认值；按它执行后查到{" "}
              {count(trace.total)} 条
            </span>
          </div>
          <JsonView value={trace.plan} />
        </>
      )}
      {/* 工具的最终结果放在最后：这次返回了哪几条资料、编号是什么（资料池是整次问答所有工具查到的资料的总清单）。 */}
      {ids.length > 0 && (
        <div className="agent-evidence-result">
          <span>本次返回 {ids.length} 条资料，编号</span>
          {ids.map((id) => (
            <EvidenceId key={id} id={id} />
          ))}
          <small>
            模型回答时用这些编号标注出处，最后的引用检查也按它们核对
          </small>
        </div>
      )}
    </details>
  );
}

// 检索漏斗（设计稿：③ 程序处理里的漏斗）：每一行是这一步之后剩下多少，右边写这一步去掉多少、为什么。
function RetrievalFunnel({
  stats,
  topK,
  given,
}: {
  stats: Record<string, unknown>;
  topK: unknown;
  given: number;
}) {
  const num = (value: unknown) => (typeof value === "number" ? value : 0);
  const dense = num(stats.dense_hits),
    keyword = num(stats.keyword_hits),
    fused = num(stats.fused_candidates);
  const reranked = num(stats.reranked),
    filtered = num(stats.filtered),
    returned = num(stats.returned);
  const minScore = typeof stats.min_score === "number" ? stats.min_score : null;
  const removed = (value: number, reason: string, none: string) =>
    value > 0
      ? { text: `去掉${reason} ${value}`, removed: true }
      : { text: none, removed: false };
  const hasRerank = reranked > 0;
  const passed = hasRerank ? reranked - filtered : fused;
  const stages = [
    {
      label: "向量 + 关键词召回",
      value: dense + keyword,
      ...{ text: `向量 ${dense} · 关键词 ${keyword}`, removed: false },
    },
    {
      label: "RRF 融合去重",
      value: fused,
      ...removed(dense + keyword - fused, "重复", "没有重复"),
    },
    hasRerank
      ? {
          label: "交给重排",
          value: reranked,
          ...removed(fused - reranked, "超出候选上限", "全部交给重排"),
        }
      : {
          label: stats.rerank_error ? "重排失败" : "未重排",
          value: fused,
          text: "按 RRF 排序",
          removed: false,
        },
    hasRerank && minScore !== null
      ? stats.fallback_used
        ? {
            label: `相关性 ≥ ${minScore}`,
            value: passed,
            text: `全部低于阈值，兜底保留最高的 1 条（> ${stats.fallback_min_score}）`,
            removed: true,
          }
        : {
            label: `相关性 ≥ ${minScore}`,
            value: passed,
            ...removed(filtered, "低于阈值", "全部通过"),
          }
      : {
          label: "未做相关性过滤",
          value: passed,
          text: "未过滤",
          removed: false,
        },
    {
      label: "返回",
      value: returned,
      ...removed(passed - returned, "超出上限或并入同一父块", "全部返回"),
    },
    {
      label: `交给模型（top_k ${typeof topK === "number" ? topK : "—"}）`,
      value: given,
      ...removed(returned - given, "超出 top_k", "全部交给模型"),
    },
  ];
  const widest = Math.max(1, stages[0].value);
  return (
    <div className="agent-funnel-wrap">
      <div className="agent-funnel">
        {stages.map((stage) => (
          <Fragment key={stage.label}>
            <span>{stage.label}</span>
            <div className="agent-funnel-track">
              <div
                className="agent-funnel-fill"
                style={{ width: `${(stage.value * 100) / widest}%` }}
              />
            </div>
            <b>{stage.value}</b>
            <em className={stage.removed ? "removed" : ""}>{stage.text}</em>
          </Fragment>
        ))}
      </div>
      <small className="agent-funnel-time">
        耗时：召回 {formatDuration(stats.recall_ms as number)} · 重排{" "}
        {formatDuration(stats.rerank_ms as number)}
      </small>
    </div>
  );
}

function CitationView({
  check,
  prompt,
}: {
  check: AgentCitation;
  prompt?: string;
}) {
  const cited = new Set(check.cited);
  const unused = check.allowed.filter((id) => !cited.has(id));
  return (
    <div className="agent-citation">
      <div className="agent-citation-result">
        {check.passed ? (
          <Tag dot tone="success">
            通过
          </Tag>
        ) : (
          <Tag dot tone="danger">
            没通过：{REASON_LABELS[String(check.reason)] ?? check.reason}
          </Tag>
        )}
        <small>
          引用 {check.cited.length} / 可用 {check.allowed.length}
          {unused.length ? `，没用到 ${unused.join("、")}` : ""}
        </small>
      </div>
      <div className="agent-citation-ids">
        <small>可以引用的编号（深色是回答引用了的）</small>
        <div>
          {check.allowed.map((id) => (
            <EvidenceId key={id} id={id} cited={cited.has(id)} />
          ))}
        </div>
      </div>
      {check.unknown.length > 0 && (
        <p className="agent-warn agent-citation-line">
          不存在的编号：{check.unknown.join("、")}
        </p>
      )}
      {(check.markers ?? []).length > 0 && (
        <p className="agent-warn agent-citation-line">
          不是资料编号的标记：{(check.markers ?? []).join("、")}
        </p>
      )}
      {prompt && (
        <Field name="修改提示" note="程序发给模型，让它重写一次">
          <Clamp className="agent-pre">{prompt}</Clamp>
        </Field>
      )}
      {check.raw_answer && (
        <Field name="模型原话" note="重写后仍没通过，用户看到的是拒答文字">
          <Clamp className="agent-pre">{check.raw_answer}</Clamp>
        </Field>
      )}
    </div>
  );
}

// 这一轮结束后要不要开启下一轮，以及为什么。规则和后端 app/agentic/loop.py 一致：
// 回复里有 tool_calls 就继续；没有就做引用检查，通过即结束，没通过让模型重写一次；
// 工具预算用完或超时后，下一轮不带工具、要求直接回答。next 是下一轮（没有就是最后一轮），stopReason 是整次问答的结束原因。
function nextDecision(
  round: AgentRound,
  next: AgentRound | undefined,
  stopReason: string | undefined,
) {
  const results = round.tool_results ?? [];
  const check = round.citation_check;
  const reasons: string[] = [];
  if (round.error)
    return {
      go: false,
      title: "模型调用失败，循环结束",
      reasons: [
        `模型调用失败：${round.error}`,
        "已经跑完的轮次会保存下来，这次问答返回失败",
      ],
    };
  if (results.length > 0) {
    // 这一轮只是查资料：查到的东西够不够回答，要等下一轮模型读了工具结果才知道，所以这里不说“资料不足”。
    const found = results.reduce(
      (sum, result) => sum + evidenceIds(result).length,
      0,
    );
    reasons.push(
      `模型这一轮调用了 ${results.length} 个工具查资料（finish_reason: tool_calls）`,
    );
    reasons.push(
      found
        ? `共返回 ${found} 条资料，下一轮交给模型读取，由它判断能不能回答、要不要再查`
        : "没有查到资料，下一轮交给模型决定换个问法再查，还是直接回答",
    );
    const lefts = results
      .map((result) => result.budget_left)
      .filter((value): value is number => typeof value === "number");
    const left = lefts.length ? Math.min(...lefts) : undefined;
    if (next?.kind === "forced") {
      const outOfBudget = left === 0;
      reasons.push(
        outOfBudget
          ? "工具调用次数已经用完（剩余 0 次），下一轮不带工具，程序要求模型直接回答"
          : "处理时间到了上限，下一轮不带工具，程序要求模型直接回答",
      );
      return {
        go: true,
        title: outOfBudget
          ? "工具次数用完，下一轮强制回答"
          : "处理超时，下一轮强制回答",
        reasons,
      };
    }
    if (next) {
      reasons.push(
        `剩余预算 ${left ?? "—"} 次，处理时间没到上限，下一轮继续提供工具信息给模型调用`,
      );
      return {
        go: true,
        title: found
          ? "已查到资料，下一轮交给模型读取并判断能否回答"
          : "没查到资料，下一轮交给模型决定下一步",
        reasons,
      };
    }
    if (!stopReason)
      return { go: true, title: "已调用工具，等待下一轮（进行中）", reasons };
    reasons.push(STOP_LABELS[stopReason] ?? stopReason);
    return { go: false, title: "调用了工具，但循环结束", reasons };
  }
  reasons.push(
    `模型这一轮没有调用工具，直接给出了回答（finish_reason: ${round.finish_reason ?? "—"}）`,
  );
  if (check && !check.passed) {
    const reason = REASON_LABELS[String(check.reason)] ?? String(check.reason);
    if (round.citation_fix_prompt) {
      if (check.allowed.length) {
        reasons.push(
          `引用检查没通过：${reason}。程序追加修改提示，下一轮让模型重写，不带工具，不占工具预算`,
        );
        return { go: true, title: "引用检查没通过，下一轮重写回答", reasons };
      }
      reasons.push(
        "引用检查没通过：这次还没查过资料，编号来自历史消息。程序追加提示，下一轮让模型先调用工具查询",
      );
      return {
        go: true,
        title: "没查资料就引用了编号，下一轮先查资料",
        reasons,
      };
    }
    reasons.push(
      `引用检查仍没通过：${reason}。已经重写过一次，不再重写，回答替换成拒答文字（模型原话保存在记录里）`,
    );
    return {
      go: false,
      title: "引用检查仍没通过，替换成拒答，循环结束",
      reasons,
    };
  }
  reasons.push(
    check ? "引用检查通过" : "这次没有查过资料（资料池为空），不做引用检查",
  );
  if (round.kind === "forced") {
    reasons.push(
      "这是强制回答轮（工具预算用完或超时），模型的回答就是最终答案",
    );
    return { go: false, title: "强制回答完成，循环结束", reasons };
  }
  if (round.kind === "citation_retry") {
    reasons.push("这是引用重写轮，重写后的回答就是最终答案");
    return { go: false, title: "重写后引用检查通过，循环结束", reasons };
  }
  reasons.push(
    check
      ? "没有再调用工具，说明模型认为资料已经够了"
      : "模型判断这个问题不需要查资料",
  );
  return {
    go: false,
    title: check
      ? "资料已够，模型没有调用工具，循环结束"
      : "模型没有调用工具，直接回答，循环结束",
    reasons,
  };
}

function DecisionView({
  decision,
}: {
  decision: ReturnType<typeof nextDecision>;
}) {
  return (
    <div className="agent-decision">
      <span className={`agent-decision-tag ${decision.go ? "go" : "stop"}`}>
        {decision.go ? "继续" : "结束"}
      </span>
      <ul className="agent-prog-list">
        {decision.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <small className="agent-decision-rule">
        判断规则：回复里有 tool_calls
        就继续；没有就做引用检查，通过即结束，没通过让模型重写一次；工具预算用完或超时，下一轮不带工具、要求直接回答。
      </small>
    </div>
  );
}

function RoundView({
  round,
  before,
  anchor,
  next,
  stopReason,
}: {
  round: AgentRound;
  before: Placed[];
  anchor: string;
  next?: AgentRound;
  stopReason?: string;
}) {
  // 每一轮的步骤按实际出现的顺序编号：有工具调用时是 ①～⑤，没有时引用检查是 ③、下一步判断是 ④。
  let step = 0;
  const no = (label: string) => `${"①②③④⑤⑥⑦"[step++]} ${label}`;
  const decision = nextDecision(round, next, stopReason);
  const prompt = usageNumber(round, "prompt_tokens");
  const cached = round.cached_tokens ?? 0;
  const output = usageNumber(round, "completion_tokens");
  const results = round.tool_results ?? [];
  const calls = round.tool_calls ?? [];
  const startIndex = before.length;
  return (
    <details className={`agent-round kind-${round.kind}`} open>
      <summary className="agent-round-head">
        <b>第 {round.round} 轮</b>
        {KIND_LABELS[round.kind] && (
          <span className="agent-kind">{KIND_LABELS[round.kind]}</span>
        )}
        <span className="agent-round-meta">
          {formatDuration(round.duration_ms)} · 输入 {count(prompt)} tok ·
          命中缓存 {count(cached)}（{percent(cached, prompt)}%）· 输出{" "}
          {count(output)} tok
        </span>
      </summary>
      <div className="agent-flow">
        <Flow
          kind="in"
          no={no("收到")}
          title="模型收到的输入"
          meta={`${round.message_count} 条消息 · 新增 ${round.new_messages.length} 条`}
        >
          {prompt > 0 && (
            <CacheBar
              prompt={prompt}
              cached={cached}
              first={round.round === 1}
            />
          )}
          <RequestInput
            round={round}
            before={before}
            anchor={anchor}
            startIndex={startIndex}
          />
        </Flow>
        <Flow
          kind="out"
          no={no("输出")}
          title="模型的输出（一次调用返回的一条回复）"
          meta={
            round.error
              ? "调用失败"
              : `finish_reason: ${round.finish_reason ?? "—"} · ${formatDuration(round.model_ms)}`
          }
        >
          {round.error ? (
            <p className="agent-warn">{round.error}</p>
          ) : (
            <>
              <Field name="原始响应" note="接口返回的原文，未格式化" raw>
                <Clamp className="agent-pre raw">{round.raw_response}</Clamp>
              </Field>
              <p className="agent-note">
                ↓ 下面是从原始响应里提取出来的字段，方便逐个查看
              </p>
              <Field
                tag="AI 响应字段"
                name="reasoning_content"
                note="推理过程（开启思考的模型才有）"
              >
                {round.reasoning ? (
                  <Clamp className="agent-pre think">{round.reasoning}</Clamp>
                ) : (
                  <p className="agent-empty">
                    （无，这个模型没有返回推理过程）
                  </p>
                )}
              </Field>
              <Field
                tag="AI 响应字段"
                name="content"
                note="文字回复（不再调用工具时就是答案）"
              >
                {round.content ? (
                  <Clamp className="agent-pre final">{round.content}</Clamp>
                ) : (
                  <p className="agent-empty">（空，这一轮只调用工具）</p>
                )}
              </Field>
              <Field tag="AI 响应字段" name="tool_calls" note="工具调用">
                {calls.length ? (
                  <JsonView value={readableCalls(calls)} />
                ) : (
                  <p className="agent-empty">（无，这一轮没有调用工具）</p>
                )}
              </Field>
              {!round.reasoning &&
                calls.length === 0 &&
                round.kind === "normal" && (
                  <p className="agent-note agent-warn-note">
                    模型这一轮没有返回推理过程，看不到它为什么没有调用工具就直接回答（推理过程由模型自己决定是否返回）。
                  </p>
                )}
            </>
          )}
        </Flow>
        {results.length > 0 && (
          <>
            <Flow
              kind="prog"
              no={no("内置程序处理")}
              title="执行工具调用"
              meta={`${results.length} 次`}
            >
              {results.map((result, index) => (
                <ProgramItem key={index} result={result} />
              ))}
            </Flow>
            <Flow
              kind="ret"
              no={no("工具返回结果")}
              title="下一轮发给模型的内容"
            >
              {results.map((result, index) => (
                <TraceContent
                  className="agent-ret-item tool-tinted"
                  key={index}
                  title={`${result.name} · 工具返回结果`}
                  style={
                    { "--tool-h": toolHue(result.name) } as React.CSSProperties
                  }
                  label={
                    <>
                      <ToolTag name={result.name} />
                      {result.id && (
                        <span className="agent-ret-id">{result.id}</span>
                      )}
                      <small>{(result.content ?? "").length} 字</small>
                    </>
                  }
                >
                  <Clamp className="agent-pre ret">{result.content}</Clamp>
                </TraceContent>
              ))}
            </Flow>
          </>
        )}
        {round.citation_check && (
          <Flow kind="prog" no={no("内置程序处理")} title="引用检查">
            {
              <CitationView
                check={round.citation_check}
                prompt={round.citation_fix_prompt}
              />
            }
          </Flow>
        )}
        <Flow
          kind="next"
          no={no("本轮执行结果")}
          title={decision.title}
          meta={decision.go ? "开启下一轮" : "Agent 循环结束"}
        >
          <DecisionView decision={decision} />
        </Flow>
      </div>
    </details>
  );
}

// 全部轮次：概览表 + 逐轮展开。每条消息只在第一次出现的那一轮完整显示，之后的轮次列成“同第几轮的 xx”，点击跳转。
export function AgentRounds({
  rounds,
  anchor,
  stopReason,
}: {
  rounds: AgentRound[];
  anchor: string;
  stopReason?: string;
}) {
  let placed: Placed[] = [];
  const views: ReactNode[] = [];
  rounds.forEach((round, position) => {
    views.push(
      <RoundView
        key={round.round}
        round={round}
        before={placed}
        anchor={anchor}
        next={rounds[position + 1]}
        stopReason={stopReason}
      />,
    );
    const { names, groups } = messageNames(round.new_messages, round.round);
    placed = placed.concat(
      round.new_messages.map((message, index) => ({
        message,
        round: round.round,
        index: placed.length + index,
        name: names[index],
        group: groups[index].label || names[index],
        kind: groups[index].kind,
      })),
    );
  });
  return (
    <div className="agent-rounds">
      <div className="agent-legend">
        <span>
          <i className="dot in" />① 收到 模型收到的输入
        </span>
        <span>
          <i className="dot out" />② 输出 模型返回的内容
        </span>
        <span>
          <i className="dot prog" />③ 内置程序处理
        </span>
        <span>
          <i className="dot ret" />④ 工具返回结果
        </span>
        <span>
          <i className="dot next" />
          本轮执行结果 是否开启下一轮
        </span>
        <span>
          资料编号：
          <EvidenceId id="S1" /> 知识库 <EvidenceId id="O1" /> 订单{" "}
          <EvidenceId id="D1" /> 业务数据，带 + 表示本轮新增
        </span>
      </div>
      {rounds.length > 0 && <Overview rounds={rounds} />}
      {views.map((view, index) => (
        <Fragment key={index}>{view}</Fragment>
      ))}
    </div>
  );
}

// 处理阶段里「Agent 循环」这一步的内容。rounds 有值时直接显示（刚问完的问题），否则展开时读取（历史问题）。
export function AgentStepView({
  step,
  requestId,
  rounds: provided,
}: {
  step: TraceStep;
  requestId?: string;
  rounds?: AgentRound[];
}) {
  const [rounds, setRounds] = useState<AgentRound[] | null>(provided ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (provided) setRounds(provided);
  }, [provided]);
  function load() {
    if (rounds || loading || !requestId) return;
    setLoading(true);
    getAgentRun(requestId)
      .then((run) => setRounds(run.rounds))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }
  return (
    <div className="agent-step">
      <Summary result={step.result ?? {}} />
      <details
        className="agent-detail"
        onToggle={(event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) load();
        }}
      >
        <summary>每一轮的细节：收到 → 输出 → 程序处理 → 工具返回</summary>
        {loading ? (
          <p className="agent-note">正在读取每一轮的记录…</p>
        ) : error ? (
          <p className="agent-warn">读取失败：{error}</p>
        ) : rounds ? (
          <AgentRounds
            rounds={rounds}
            anchor={`agent-${requestId ?? "live"}`}
            stopReason={step.result?.stop_reason as string | undefined}
          />
        ) : null}
      </details>
    </div>
  );
}

// 回答过程中实时显示已经完成的轮次（Agent 循环这一步要等全部轮次结束才出现）。
export function AgentLiveRounds({
  rounds,
  busy,
}: {
  rounds: AgentRound[];
  busy: boolean;
}) {
  if (rounds.length === 0) return null;
  return (
    <details className="agent-live" open>
      <summary>
        Agent 循环{busy ? " · 进行中" : ""}
        <small>已完成 {rounds.length} 轮</small>
      </summary>
      <AgentRounds rounds={rounds} anchor="agent-live" />
    </details>
  );
}
