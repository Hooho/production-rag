import { formatJsonOutput } from "./formatJsonOutput";
import { useState, type ReactNode } from "react";
import { DetailDialog } from "./DetailDialog";
import { GraphEntityPanel } from "./GraphEntityPanel";
import type { ChunkGraph, DocumentChunk } from "./api";
import { evidenceRanges } from "./evidenceRanges";
import { Tag } from "./Tag";

// 分片卡片：知识库文档详情的「全部分块」和评测语料库共用，从 App.tsx 挪出来。
// 分片技术信息的一行：名称 | 值，值下面一行小字解释；warn 是需要注意的问题，橙色显示。
function TechRow({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  warn?: string;
}) {
  return (
    <>
      <span>{label}</span>
      <div className="chunk-tech-value">
        <strong>{value}</strong>
        {warn && <small className="is-warn">{warn}</small>}
        {note && <small>{note}</small>}
      </div>
    </>
  );
}

const ELEMENT_TYPE_LABELS: Record<string, string> = {
  NarrativeText: "正文段落",
  Title: "标题",
  ListItem: "列表项",
  Table: "表格",
  FigureCaption: "图注",
  Header: "页眉",
  Footer: "页脚",
  Text: "文本",
  UncategorizedText: "未分类文本",
  Image: "图片",
  Formula: "公式",
  Address: "地址",
  EmailAddress: "邮箱",
};

// 组成元素的说明：中间缺号时指出缺的是哪几个，一般是页眉、页码这类被过滤掉的元素。
function elementNote(indexes: number[]) {
  const base =
    "解析工具把整份文档拆成一串元素（一个标题、一段正文、一个表格各算一个），这一片由这几个元素拼成";
  const numbers = [...indexes].sort((a, b) => a - b).map((item) => item + 1);
  const gaps: number[] = [];
  for (let index = 1; index < numbers.length; index += 1) {
    for (
      let value = numbers[index - 1] + 1;
      value < numbers[index] && gaps.length < 5;
      value += 1
    )
      gaps.push(value);
  }
  return gaps.length > 0
    ? `${base}；中间缺的第 ${gaps.join("、")} 个没有收进来，一般是页眉、页码这类被过滤掉的元素`
    : base;
}

const CONTEXT_SOURCE_LABELS: Record<string, string> = {
  reused: "复用上一版本（分片文字没变，沿用当时生成的说明）",
  cached: "命中缓存（同样的原文和分片以前生成过）",
  generated: "新生成（调用大模型）",
  failed: "生成失败",
};

// 展示单个分块：展开后先看"位置 / 上下文说明 / 内容"，排查用的技术信息默认折叠。
// 以前 11 个字段一行一个平铺，位置、正文和排查信息混在一起；作者识别不到时每个分片都重复同一句。
export function DocumentChunkCard({
  chunk,
  expanded,
  onToggle,
  onRetryGraph,
}: {
  chunk: DocumentChunk;
  expanded: boolean;
  onToggle?: () => void;
  onRetryGraph?: (chunkId: string) => void;
}) {
  const [entityId, setEntityId] = useState<string | null>(null);
  const heading =
    chunk.heading_path.length > 0 ? chunk.heading_path.join(" / ") : "根文档";
  // 表格（Excel、CSV）的分片记的是行号，没有页码。
  const pages =
    chunk.row_start != null
      ? chunk.row_start === chunk.row_end
        ? `第 ${chunk.row_start} 行`
        : `第 ${chunk.row_start}–${chunk.row_end} 行`
      : chunk.page_start && chunk.page_end
        ? chunk.page_start === chunk.page_end
          ? `第 ${chunk.page_start} 页`
          : `第 ${chunk.page_start}–${chunk.page_end} 页`
        : "页码未记录";
  // 文件名去掉扩展名后和标题一样时只写一次。
  const sameName =
    chunk.source.replace(/\.[^.]+$/, "") === chunk.document_title;
  return (
    <article className={`document-chunk-card ${expanded ? "expanded" : ""}`}>
      <div className="document-chunk-summary">
        <div className="document-chunk-copy">
          <strong>
            第 {String(chunk.position).padStart(3, "0")} 段 · {chunk.char_count}{" "}
            字 · {pages}
            {chunk.context && !chunk.context.includes("<think")
              ? ""
              : " · 无上下文说明"}
            {chunk.vector_source && (
              <Tag
                size="sm"
                plain
                className="is-after"
                tone={chunk.vector_source === "reused" ? "neutral" : "info"}
              >
                {chunk.vector_source === "reused" ? "复用" : "新计算"}
              </Tag>
            )}
            {chunk.graph && <GraphBadge graph={chunk.graph} />}
          </strong>
          <small>{heading}</small>
        </div>
        {onToggle && (
          <button className="chunk-toggle-button" onClick={onToggle}>
            {expanded ? "收起" : "展开"}
          </button>
        )}
      </div>
      {expanded && (
        <div className="document-chunk-body">
          <section className="chunk-group">
            <h4>位置</h4>
            <div className="chunk-location">
              <div>
                <span>文档</span>
                <strong>
                  {chunk.document_title}
                  {sameName ? "" : ` · ${chunk.source}`}
                </strong>
              </div>
              <div>
                <span>章节</span>
                <strong>{heading}</strong>
              </div>
              <div>
                <span>{chunk.row_start != null ? "行号" : "页码"}</span>
                <strong>{pages}</strong>
              </div>
              {chunk.author && (
                <div>
                  <span>作者</span>
                  <strong>
                    {chunk.author}
                    {chunk.author_source ? `（${chunk.author_source}）` : ""}
                  </strong>
                </div>
              )}
            </div>
          </section>
          <section className="chunk-group">
            <h4>
              上下文说明<small>Contextual Retrieval</small>
            </h4>
            {chunk.context && chunk.context.includes("<think") ? (
              <small className="chunk-note is-warn">
                生成有误：早期版本把模型的思考过程当成了说明，可在「处理流程」里重试生成上下文
              </small>
            ) : chunk.context ? (
              <>
                <p className="chunk-context">{chunk.context}</p>
                <small className="chunk-note">
                  由大模型读完整篇文档后为这个分片补写，拼在正文前面一起生成向量和关键词索引，让孤立的片段也能被检索到
                </small>
              </>
            ) : (
              <small className="chunk-note is-warn">
                未生成：上下文生成失败或未启用，可在「处理流程」里重试生成上下文
              </small>
            )}
          </section>
          <section className="chunk-group">
            <h4>
              内容
              <small>
                {chunk.char_count} 字
                {chunk.graph && chunk.graph.mentions.length > 0
                  ? " · 黄色是抽出的实体名字"
                  : ""}
              </small>
            </h4>
            <p className="chunk-content">
              {chunk.graph
                ? highlight(chunk.content, chunk.graph, setEntityId)
                : chunk.content}
            </p>
          </section>
          {chunk.graph && (
            <ChunkGraphSection
              chunkId={chunk.chunk_id}
              graph={chunk.graph}
              onRetry={onRetryGraph}
              onSelectEntity={setEntityId}
            />
          )}
          <details className="chunk-group chunk-tech">
            <summary>
              技术信息<small>排查切分和解析问题时看</small>
            </summary>
            {/* 每项先写结果，下面一行小字说明这项是什么意思；以前只有 NarrativeText、heading_paragraph_sentence 这类原始值。 */}
            <div className="chunk-tech-grid">
              <TechRow
                label="分块 ID"
                value={<code>{chunk.chunk_id}</code>}
                note="文档版本 id : 这个版本里的第几个分片（从 0 开始数）"
              />
              <TechRow
                label="元素类型"
                value={
                  chunk.element_types.length > 0
                    ? chunk.element_types
                        .map(
                          (item) =>
                            `${ELEMENT_TYPE_LABELS[item] ?? item}（${item}）`,
                        )
                        .join("、")
                    : "未提供"
                }
                note="解析工具给每块内容标的类型。常见的有：标题 Title、正文段落 NarrativeText、列表项 ListItem、表格 Table、图注 FigureCaption、页眉 Header、页脚 Footer"
              />
              <TechRow
                label="组成元素"
                value={
                  chunk.element_indexes.length > 0
                    ? `第 ${chunk.element_indexes.map((item) => item + 1).join("、")} 个元素`
                    : "未记录"
                }
                note={elementNote(chunk.element_indexes)}
              />
              <TechRow
                label="Token 数"
                value={chunk.token_count ?? "当前向量接口未提供"}
                warn={
                  chunk.truncated
                    ? "超过向量模型的长度上限，超出的部分没有参与向量计算"
                    : undefined
                }
                note="向量模型分词后的长度，包括拼在前面的标题路径和上下文说明"
              />
              {chunk.vector_source && (
                <TechRow
                  label="向量"
                  value={
                    chunk.vector_source === "reused"
                      ? `复用上一版本的分片 ${chunk.reused_from ?? ""}`
                      : "新计算"
                  }
                  note={
                    chunk.vector_source === "reused"
                      ? "分片文字和上一版本完全相同，直接沿用当时的向量"
                      : "上一版本没有文字相同的分片"
                  }
                />
              )}
              {chunk.context_source && (
                <TechRow
                  label="上下文说明"
                  value={
                    CONTEXT_SOURCE_LABELS[chunk.context_source] ??
                    chunk.context_source
                  }
                />
              )}
            </div>
          </details>
        </div>
      )}
      {entityId && (
        <DetailDialog open title="实体详情" onClose={() => setEntityId(null)}>
          <GraphEntityPanel
            entityId={entityId}
            documentId={chunk.document_id}
            onClose={() => setEntityId(null)}
          />
        </DetailDialog>
      )}
    </article>
  );
}

const GRAPH_STATUS_LABELS: Record<string, string> = {
  extracted: "新抽取",
  reused: "复用",
  failed: "抽取失败",
};

// 分片标题行上的抽取状态：失败标红，没抽出实体单独说明。
function GraphBadge({ graph }: { graph: ChunkGraph }) {
  if (graph.status === "failed")
    return (
      <Tag size="sm" plain className="is-after" tone="danger">
        图谱：抽取失败
      </Tag>
    );
  if (graph.empty)
    return (
      <Tag size="sm" plain className="is-after" tone="neutral">
        图谱：没抽出实体
      </Tag>
    );
  return (
    <Tag size="sm" plain className="is-after" tone="info">
      图谱：{graph.mentions.length} 个名字 · {graph.relations.length} 条关系
    </Tag>
  );
}

// 原文里高亮抽出的名字（长的先匹配，「苹果公司」不会被拆成「苹果」）。
// 匹配忽略空白、全角半角和 PDF 部首字（evidenceRanges），和其他原文高亮一致。
function highlight(
  content: string,
  graph: ChunkGraph,
  onSelectEntity: (id: string) => void,
) {
  const names = [
    ...new Set(
      graph.mentions.map((item) => item.name).filter((name) => name.length > 0),
    ),
  ].sort((a, b) => b.length - a.length);
  if (names.length === 0) return content;
  const byName = new Map(graph.mentions.map((item) => [item.name, item]));
  // 每个字符归到哪个名字；先占先得，长名字先放。
  const owner: (string | null)[] = new Array(content.length).fill(null);
  const starts = new Set<number>();
  for (const name of names)
    for (const [start, end] of evidenceRanges(content, [name])) {
      if (owner.slice(start, end).some((value) => value !== null)) continue;
      for (let index = start; index < end; index += 1) owner[index] = name;
      starts.add(start);
    }
  const parts: { text: string; name: string | null }[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const last = parts[parts.length - 1];
    // 名字换了，或者同一个名字又从这里开始出现一次，就新起一段。
    if (last && last.name === owner[index] && !starts.has(index))
      last.text += content[index];
    else parts.push({ text: content[index], name: owner[index] });
  }
  return parts.map((part, index) => {
    const mention = part.name ? byName.get(part.name) : undefined;
    if (!mention) return part.text;
    if (mention.entity_id)
      return (
        <button
          key={index}
          type="button"
          className="chunk-graph-mark is-clickable"
          onClick={() => onSelectEntity(mention.entity_id!)}
          title={`查看「${mention.entity_name ?? part.text}」的实体详情`}
        >
          {part.text}
        </button>
      );
    return (
      <mark
        key={index}
        className="chunk-graph-mark"
        title={`${mention.type} → 归到「${mention.entity_name ?? mention.canonical ?? part.text}」（${mention.method_label ?? ""}）`}
      >
        {part.text}
      </mark>
    );
  });
}

// 这一片的抽取结果：名字 → 归到哪个实体、关系、丢掉的项；发给模型的完整提示词和原始输出点击弹窗查看。
function ChunkGraphSection({
  chunkId,
  graph,
  onRetry,
  onSelectEntity,
}: {
  chunkId: string;
  graph: ChunkGraph;
  onRetry?: (chunkId: string) => void;
  onSelectEntity: (id: string) => void;
}) {
  const [sourceDetail, setSourceDetail] = useState<"prompt" | "output" | null>(
    null,
  );
  const tokens =
    graph.input_tokens != null
      ? ` · token 输入 ${graph.input_tokens}，输出 ${graph.output_tokens ?? 0}`
      : "";
  const seconds =
    graph.duration_ms != null
      ? ` · ${(graph.duration_ms / 1000).toFixed(1)} 秒`
      : "";
  return (
    <section className="chunk-group">
      <h4>
        实体关系
        <small>
          {GRAPH_STATUS_LABELS[graph.status] ?? graph.status}
          {graph.status === "reused"
            ? "（分片、清单、模型、提示词都和以前一样，沿用当时的结果）"
            : ""}
          {tokens}
          {seconds}
        </small>
      </h4>
      {graph.status === "failed" ? (
        <p className="chunk-note is-warn">
          抽取失败：{graph.error}
          {onRetry && (
            <>
              {" "}
              <button
                type="button"
                className="link-button"
                title="重新抽取当前分片的实体和关系"
                onClick={() => onRetry(chunkId)}
              >
                重试这一片
              </button>
            </>
          )}
        </p>
      ) : graph.mentions.length === 0 ? (
        <small className="chunk-note">这一片没有抽出实体</small>
      ) : (
        <>
          <ul className="chunk-graph-list">
            {graph.mentions.map((item) => (
              <li key={item.name}>
                <strong>{item.name}</strong>（{item.type}
                {item.type_fixed_from
                  ? `，模型写的是「${item.type_fixed_from}」，不在清单里`
                  : ""}
                ）<span className="chunk-graph-arrow">→</span>
                {item.entity_id ? (
                  <button
                    type="button"
                    className="link-button"
                    title={`查看「${item.entity_name ?? item.canonical ?? item.name}」的实体详情`}
                    aria-label={`查看「${item.entity_name ?? item.canonical ?? item.name}」的实体详情`}
                    onClick={() => onSelectEntity(item.entity_id!)}
                  >
                    {item.entity_name ?? item.canonical}
                  </button>
                ) : (
                  (item.entity_name ?? item.canonical)
                )}
                {item.method_label && (
                  <small>
                    {item.method_label}
                    {item.canonical && item.canonical !== item.name
                      ? `：模型给的标准名「${item.canonical}」`
                      : ""}
                  </small>
                )}
              </li>
            ))}
          </ul>
          {graph.relations.length > 0 && (
            <ul className="chunk-graph-list">
              {graph.relations.map((item, index) => (
                <li key={index}>
                  {item.source}
                  <span className="chunk-graph-arrow">─{item.category}→</span>
                  {item.target}
                  <small className="grt-rel-desc">
                    【原文】{item.description}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {graph.dropped.length > 0 && (
        <details className="chunk-graph-raw">
          <summary>
            丢掉了 {graph.dropped.length}{" "}
            项（格式不对、重复、关系的起点终点对不上）
          </summary>
          <ul className="chunk-graph-list">
            {graph.dropped.map((item, index) => (
              <li key={index}>
                {item.reason}
                <small>{JSON.stringify(item.item)}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {graph.prompt && (
        <div className="chunk-graph-raw">
          <button
            type="button"
            className="link-button"
            title="打开弹窗，查看发送给模型的完整提示词"
            onClick={() => setSourceDetail("prompt")}
          >
            发给模型的完整提示词
          </button>
        </div>
      )}
      {graph.raw_output != null && (
        <div className="chunk-graph-raw">
          <button
            type="button"
            className="link-button"
            title="打开弹窗，查看模型原始输出"
            onClick={() => setSourceDetail("output")}
          >
            模型原始输出
          </button>
        </div>
      )}
      {sourceDetail && (
        <DetailDialog
          open
          title={
            sourceDetail === "prompt" ? "发给模型的完整提示词" : "模型原始输出"
          }
          onClose={() => setSourceDetail(null)}
        >
          <pre className="graph-prompt">
            {sourceDetail === "prompt"
              ? graph.prompt
                  ?.map(
                    (message) =>
                      `【${message.role === "system" ? "系统提示词" : "用户消息"}】\n${message.content}`,
                  )
                  .join("\n\n")
              : formatJsonOutput(graph.raw_output)}
          </pre>
        </DetailDialog>
      )}
    </section>
  );
}
