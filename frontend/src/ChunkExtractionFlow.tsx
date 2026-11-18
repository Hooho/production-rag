import { useState, type ReactNode } from "react";
import type { ChunkGraph } from "./api";
import { DetailDialog } from "./DetailDialog";
import { InfoPopover } from "./Popover";
import { HighlightedText } from "./HighlightedText";
import { Tag } from "./Tag";
import { formatJsonOutput } from "./formatJsonOutput";
import "./ChunkExtractionFlow.css";

export function ChunkExtractionFlow({
  graph,
  originalText,
  onRetry,
}: {
  graph: ChunkGraph;
  originalText: string;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const parsed = graph.parsed_result;
  const failed = graph.status === "failed";
  const state = failed
    ? "失败"
    : graph.status === "reused"
      ? "复用历史抽取"
      : "已抽取";
  const input = graph.prompt
    ?.map((m) => `【${m.role}】\n${m.content}`)
    .join("\n\n");
  const relations = parsed?.relations ?? [];
  const steps: { title: string; status: string; body: ReactNode }[] = [
    {
      title: "请求 AI",
      status: input
        ? graph.status === "reused"
          ? "历史请求"
          : "已记录"
        : "未记录",
      body: (
        <>
          <p>
            状态：{state} · 模型：{graph.model ?? "未记录"} · 提示词：
            {graph.prompt_tag ?? "未记录"}
          </p>
          {input ? (
            <InfoPopover title="完整请求" content={() => <pre>{input}</pre>}>
              <button className="link-button button-sm">查看完整请求</button>
            </InfoPopover>
          ) : (
            <p>未记录</p>
          )}
        </>
      ),
    },
    {
      title: "模型返回",
      status: graph.raw_output != null ? "已记录" : failed ? "失败" : "未记录",
      body: (
        <>
          <p>
            输入 {graph.input_tokens ?? "未记录"} / 输出{" "}
            {graph.output_tokens ?? "未记录"} token · 耗时{" "}
            {graph.duration_ms == null
              ? "未记录"
              : `${graph.duration_ms / 1000} 秒`}
          </p>
          {graph.error && <p>{graph.error}</p>}
          {graph.raw_output != null && (
            <InfoPopover
              title="模型原始输出"
              content={() => <pre>{formatJsonOutput(graph.raw_output)}</pre>}
            >
              <button className="link-button button-sm">查看格式化 JSON</button>
            </InfoPopover>
          )}
        </>
      ),
    },
    {
      title: "解析与校验",
      status: parsed
        ? `保留 ${parsed.entities?.length ?? 0} 实体 / ${relations.length} 关系，丢弃 ${graph.dropped.length} 项`
        : "未记录",
      body: (
        <>
          <h5>抽取时结果</h5>
          {parsed ? (
            <pre>{JSON.stringify(parsed, null, 2)}</pre>
          ) : (
            <p>未记录</p>
          )}
          {graph.dropped.map((item, i) => (
            <div key={i}>
              <Tag tone="neutral">{item.reason}</Tag>
              <pre>{JSON.stringify(item.item, null, 2)}</pre>
            </div>
          ))}
        </>
      ),
    },
    {
      title: "实体归并",
      status: `${graph.mentions.length} 个实体`,
      body: graph.mentions.map((item, i) => (
        <p key={i}>
          {item.name} → {item.entity_name ?? "未记录"}{" "}
          <Tag tone="neutral">{item.method_label ?? "归并依据未记录"}</Tag>
        </p>
      )),
    },
    {
      title: "关系入图",
      status: "历史写入过程未记录",
      body: (
        <>
          <p>下列为抽取时通过校验的关系，不作为历史写入成功凭据。</p>
          {relations.map((item, i) => (
            <div key={i}>
              <strong>
                {item.source} → {item.category} → {item.target}
              </strong>
              <p>描述：{item.description}</p>
              <p>原文依据：{item.evidence || "未记录"}</p>
              {item.evidence && (
                <InfoPopover
                  title="原文依据"
                  content={() => (
                    <HighlightedText
                      text={originalText}
                      groups={[{ kind: "evidence", texts: [item.evidence] }]}
                    />
                  )}
                >
                  <button className="link-button button-sm">查看原文</button>
                </InfoPopover>
              )}
            </div>
          ))}
        </>
      ),
    },
    {
      title: "后续处理与当前结果",
      status: graph.current_relations
        ? `当前 ${graph.current_relations.length} 条关系`
        : "未记录",
      body: (
        <>
          <h5>处理记录</h5>
          <p>以下为已保存的归并依据；完整操作时间线未记录。</p>
          {graph.processing?.map((item, i) => (
            <p key={i}>
              {item.name} → {item.entity_name} · {item.method_label} ·{" "}
              {item.scope_label}
            </p>
          ))}
          <h5>当前入图关系</h5>
          {graph.current_relations ? (
            graph.current_relations.map((item) => (
              <div key={item.id}>
                <strong>
                  {item.source_entity} → {item.category} → {item.target_entity}
                </strong>
                <p>描述：{item.description}</p>
                <p>原文依据：{item.evidence || "未记录"}</p>
              </div>
            ))
          ) : (
            <p>未记录</p>
          )}
        </>
      ),
    },
  ];
  return (
    <section className="chunk-group chunk-extraction-flow">
      <h4>
        实体关系 <Tag tone={failed ? "danger" : "neutral"}>{state}</Tag>
      </h4>
      {failed && onRetry && (
        <button
          type="button"
          className="link-button button-sm"
          onClick={onRetry}
        >
          重试这一片
        </button>
      )}
      <p>
        {graph.mentions.length} 个实体 · {graph.relations.length} 条关系 · 去掉{" "}
        {graph.dropped.length} 项
      </p>
      <p className="extraction-summary">
        请求 AI → 模型返回 → 解析校验 → 实体归并 → 关系入图 → 当前结果
      </p>
      <button className="link-button button-sm" onClick={() => setOpen(true)}>
        查看流程
      </button>
      {open && (
        <DetailDialog
          open
          title="分片抽取流程"
          onClose={() => setOpen(false)}
          className="chunk-extraction-flow"
        >
          <ol className="extraction-steps">
            {steps.map((step, i) => (
              <li key={step.title}>
                <span className="extraction-number">{i + 1}</span>
                <details>
                  <summary>
                    {step.title} <Tag tone="neutral">{step.status}</Tag>
                  </summary>
                  <div>{step.body}</div>
                </details>
              </li>
            ))}
          </ol>
        </DetailDialog>
      )}
    </section>
  );
}
