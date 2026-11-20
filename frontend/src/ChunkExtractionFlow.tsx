import { useState, type ReactNode } from "react";
import type { ChunkGraph } from "./api";
import { DetailDialog } from "./DetailDialog";
import { HighlightedText } from "./HighlightedText";
import { Tag } from "./Tag";
import Table from "./Table";
import { formatJsonOutput } from "./formatJsonOutput";
import "./ChunkExtractionFlow.css";

function FlowTable<T>({
  rows,
  headers,
  render,
}: {
  rows: T[];
  headers: string[];
  render: (row: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return <p className="extraction-step-status">无记录项</p>;
  return (
    <>
      <Table className="extraction-data-table">
        <thead>
          <tr>
            {headers.map((title) => (
              <th key={title}>{title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(expanded ? rows : rows.slice(0, 5)).map((row, index) => (
            <tr key={index}>{render(row)}</tr>
          ))}
        </tbody>
      </Table>
      {rows.length > 5 && (
        <button
          type="button"
          className="link-button button-sm"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : `展开全部 ${rows.length} 项`}
        </button>
      )}
    </>
  );
}

function CategoryTag({ value }: { value?: string | null }) {
  return value && value !== "未记录" ? (
    <Tag hue size="sm">
      {value}
    </Tag>
  ) : (
    <Tag tone="neutral" size="sm">
      未记录
    </Tag>
  );
}

function droppedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "空项");
  return Object.entries(value)
    .map(
      ([key, item]) =>
        `${key}：${typeof item === "object" ? droppedText(item) : String(item)}`,
    )
    .join("；");
}

export function ChunkExtractionFlow({
  graph,
  originalText,
  onRetry,
}: {
  graph: ChunkGraph;
  originalText: string;
  onRetry?: () => void;
}) {
  const [detail, setDetail] = useState<{
    title: string;
    text: string;
    evidence?: string;
  } | null>(null);
  const parsed = graph.parsed_result;
  const relations = parsed?.relations ?? [];
  const failed = graph.status === "failed";
  const state = failed
    ? "失败"
    : graph.status === "reused"
      ? "复用历史抽取"
      : "已抽取";
  const input = graph.prompt
    ?.map((message) => `【${message.role}】\n${message.content}`)
    .join("\n\n");
  const evidence = (text: string) => (
    <>
      {text || "未记录"}
      {text && (
        <button
          type="button"
          className="link-button button-sm"
          onClick={() =>
            setDetail({
              title: "完整分片原文",
              text: originalText,
              evidence: text,
            })
          }
        >
          原文
        </button>
      )}
    </>
  );
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
            模型：{graph.model ?? "未记录"} · 提示词：
            {graph.prompt_tag ?? "未记录"}
          </p>
          {input && (
            <button
              type="button"
              className="link-button button-sm"
              onClick={() => setDetail({ title: "完整请求", text: input })}
            >
              完整请求
            </button>
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
            <button
              type="button"
              className="link-button button-sm"
              onClick={() =>
                setDetail({
                  title: "模型原始输出",
                  text: formatJsonOutput(graph.raw_output),
                })
              }
            >
              原始输出
            </button>
          )}
        </>
      ),
    },
    {
      title: "解析与校验",
      status: parsed
        ? `保留 ${parsed.entities?.length ?? 0} 实体 / ${relations.length} 关系，丢弃 ${graph.dropped.length} 项`
        : "未记录",
      body: parsed ? (
        <>
          <h5>实体</h5>
          <FlowTable
            rows={parsed.entities ?? []}
            headers={["实体名称", "类型", "模型标准名"]}
            render={(item) => (
              <>
                <td>{item.name}</td>
                <td>
                  <CategoryTag value={item.type} />
                </td>
                <td>{item.canonical ?? "未记录"}</td>
              </>
            )}
          />
          <h5>关系</h5>
          <FlowTable
            rows={relations}
            headers={["起点", "关系", "终点", "描述", "原文依据"]}
            render={(item) => (
              <>
                <td>{item.source}</td>
                <td>
                  <CategoryTag value={item.category} />
                </td>
                <td>{item.target}</td>
                <td>{item.description}</td>
                <td>{evidence(item.evidence)}</td>
              </>
            )}
          />
          {graph.dropped.length > 0 && (
            <>
              <h5>丢弃项</h5>
              <FlowTable
                rows={graph.dropped}
                headers={["类型", "内容", "原因"]}
                render={(item) => (
                  <>
                    <td>
                      <CategoryTag
                        value={
                          item.kind === "entity"
                            ? "实体"
                            : item.kind === "relation"
                              ? "关系"
                              : item.kind
                        }
                      />
                    </td>
                    <td>{droppedText(item.item)}</td>
                    <td>
                      <Tag tone="warning" size="sm">
                        {item.reason}
                      </Tag>
                    </td>
                  </>
                )}
              />
            </>
          )}
        </>
      ) : (
        <p>解析结果未记录</p>
      ),
    },
    {
      title: "实体归并",
      status: `${graph.mentions.length} 个实体`,
      body: (
        <FlowTable
          rows={graph.mentions}
          headers={["抽取名称", "图谱实体", "归并依据"]}
          render={(item) => (
            <>
              <td>{item.name}</td>
              <td>{item.entity_name ?? "未记录"}</td>
              <td>
                <CategoryTag value={item.method_label} />
              </td>
            </>
          )}
        />
      ),
    },
    {
      title: "关系入图",
      status: "历史写入过程未记录",
      body: (
        <>
          <p className="extraction-step-status">
            下列为抽取关系的当前实体映射；历史写入状态未记录。
          </p>
          <FlowTable
            rows={graph.relations}
            headers={["归并后关系", "历史写入状态"]}
            render={(item) => (
              <>
                <td>
                  {item.source_entity ?? item.source} →{" "}
                  <CategoryTag value={item.category} /> →{" "}
                  {item.target_entity ?? item.target}
                </td>
                <td>
                  <Tag tone="neutral" size="sm">
                    未记录
                  </Tag>
                </td>
              </>
            )}
          />
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
          <h5>已保存的处理依据</h5>
          <p className="extraction-step-status">完整操作时间线未记录。</p>
          <FlowTable
            rows={graph.processing ?? []}
            headers={["名称", "当前实体", "处理方式", "范围"]}
            render={(item) => (
              <>
                <td>{item.name}</td>
                <td>{item.entity_name}</td>
                <td>
                  <CategoryTag value={item.method_label} />
                </td>
                <td>
                  <CategoryTag value={item.scope_label} />
                </td>
              </>
            )}
          />
          <h5>当前入图关系</h5>
          {graph.current_relations ? (
            <FlowTable
              rows={graph.current_relations}
              headers={["关系", "描述", "原文依据"]}
              render={(item) => (
                <>
                  <td>
                    {item.source_entity} → <CategoryTag value={item.category} />{" "}
                    → {item.target_entity}
                  </td>
                  <td>{item.description}</td>
                  <td>{evidence(item.evidence)}</td>
                </>
              )}
            />
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
      <ol className="extraction-steps" aria-label="分片抽取流程">
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="extraction-number" aria-hidden="true">
              {index + 1}
            </span>
            <strong className="extraction-step-title">{step.title}</strong>
            <span className="extraction-step-status">{step.status}</span>
            <div className="extraction-step-body">{step.body}</div>
          </li>
        ))}
      </ol>
      {detail && (
        <DetailDialog
          open
          title={detail.title}
          onClose={() => setDetail(null)}
          className="chunk-extraction-flow extraction-step-dialog"
        >
          {detail.evidence ? (
            <HighlightedText
              text={detail.text}
              groups={[{ kind: "evidence", texts: [detail.evidence] }]}
            />
          ) : (
            <pre>{detail.text}</pre>
          )}
        </DetailDialog>
      )}
    </section>
  );
}
