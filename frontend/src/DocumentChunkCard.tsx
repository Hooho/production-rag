import type { ReactNode } from "react";
import type { DocumentChunk } from "./api";
import { Tag } from "./Tag";

// 分片卡片：知识库文档详情的「全部分块」和评测语料库共用，从 App.tsx 挪出来。
// 分片技术信息的一行：名称 | 值，值下面一行小字解释；warn 是需要注意的问题，橙色显示。
function TechRow({ label, value, note, warn }: { label: string; value: ReactNode; note?: string; warn?: string }) {
  return <><span>{label}</span><div className="chunk-tech-value"><strong>{value}</strong>{warn && <small className="is-warn">{warn}</small>}{note && <small>{note}</small>}</div></>;
}

const ELEMENT_TYPE_LABELS: Record<string, string> = {
  NarrativeText: "正文段落", Title: "标题", ListItem: "列表项", Table: "表格", FigureCaption: "图注",
  Header: "页眉", Footer: "页脚", Text: "文本", UncategorizedText: "未分类文本", Image: "图片", Formula: "公式", Address: "地址", EmailAddress: "邮箱",
};

// 组成元素的说明：中间缺号时指出缺的是哪几个，一般是页眉、页码这类被过滤掉的元素。
function elementNote(indexes: number[]) {
  const base = "解析工具把整份文档拆成一串元素（一个标题、一段正文、一个表格各算一个），这一片由这几个元素拼成";
  const numbers = [...indexes].sort((a, b) => a - b).map((item) => item + 1);
  const gaps: number[] = [];
  for (let index = 1; index < numbers.length; index += 1) {
    for (let value = numbers[index - 1] + 1; value < numbers[index] && gaps.length < 5; value += 1) gaps.push(value);
  }
  return gaps.length > 0 ? `${base}；中间缺的第 ${gaps.join("、")} 个没有收进来，一般是页眉、页码这类被过滤掉的元素` : base;
}

const CONTEXT_SOURCE_LABELS: Record<string, string> = {
  reused: "复用上一版本（分片文字没变，沿用当时生成的说明）",
  cached: "命中缓存（同样的原文和分片以前生成过）",
  generated: "新生成（调用大模型）",
  failed: "生成失败",
};

// 展示单个分块：展开后先看"位置 / 上下文说明 / 内容"，排查用的技术信息默认折叠。
// 以前 11 个字段一行一个平铺，位置、正文和排查信息混在一起；作者识别不到时每个分片都重复同一句。
export function DocumentChunkCard({ chunk, expanded, onToggle }: { chunk: DocumentChunk; expanded: boolean; onToggle: () => void }) {
  const heading = chunk.heading_path.length > 0 ? chunk.heading_path.join(" / ") : "根文档";
  // 表格（Excel、CSV）的分片记的是行号，没有页码。
  const pages = chunk.row_start != null ? (chunk.row_start === chunk.row_end ? `第 ${chunk.row_start} 行` : `第 ${chunk.row_start}–${chunk.row_end} 行`)
    : chunk.page_start && chunk.page_end ? (chunk.page_start === chunk.page_end ? `第 ${chunk.page_start} 页` : `第 ${chunk.page_start}–${chunk.page_end} 页`) : "页码未记录";
  // 文件名去掉扩展名后和标题一样时只写一次。
  const sameName = chunk.source.replace(/\.[^.]+$/, "") === chunk.document_title;
  return <article className={`document-chunk-card ${expanded ? "expanded" : ""}`}>
    <div className="document-chunk-summary"><div className="document-chunk-copy"><strong>第 {String(chunk.position).padStart(3, "0")} 段 · {chunk.char_count} 字 · {pages}{chunk.context && !chunk.context.includes("<think") ? "" : " · 无上下文说明"}{chunk.vector_source && <Tag size="sm" plain className="is-after" tone={chunk.vector_source === "reused" ? "neutral" : "info"}>{chunk.vector_source === "reused" ? "复用" : "新计算"}</Tag>}</strong><small>{heading}</small></div><button className="chunk-toggle-button" onClick={onToggle}>{expanded ? "收起" : "展开"}</button></div>
    {expanded && <div className="document-chunk-body">
      <section className="chunk-group">
        <h4>位置</h4>
        <div className="chunk-location">
          <div><span>文档</span><strong>{chunk.document_title}{sameName ? "" : ` · ${chunk.source}`}</strong></div>
          <div><span>章节</span><strong>{heading}</strong></div>
          <div><span>{chunk.row_start != null ? "行号" : "页码"}</span><strong>{pages}</strong></div>
          {chunk.author && <div><span>作者</span><strong>{chunk.author}{chunk.author_source ? `（${chunk.author_source}）` : ""}</strong></div>}
        </div>
      </section>
      <section className="chunk-group">
        <h4>上下文说明<small>Contextual Retrieval</small></h4>
        {chunk.context && chunk.context.includes("<think")
          ? <small className="chunk-note is-warn">生成有误：早期版本把模型的思考过程当成了说明，可在「处理流程」里重试生成上下文</small>
          : chunk.context
            ? <><p className="chunk-context">{chunk.context}</p><small className="chunk-note">由大模型读完整篇文档后为这个分片补写，拼在正文前面一起生成向量和关键词索引，让孤立的片段也能被检索到</small></>
            : <small className="chunk-note is-warn">未生成：上下文生成失败或未启用，可在「处理流程」里重试生成上下文</small>}
      </section>
      <section className="chunk-group">
        <h4>内容<small>{chunk.char_count} 字</small></h4>
        <p className="chunk-content">{chunk.content}</p>
      </section>
      <details className="chunk-group chunk-tech">
        <summary>技术信息<small>排查切分和解析问题时看</small></summary>
        {/* 每项先写结果，下面一行小字说明这项是什么意思；以前只有 NarrativeText、heading_paragraph_sentence 这类原始值。 */}
        <div className="chunk-tech-grid">
          <TechRow label="分块 ID" value={<code>{chunk.chunk_id}</code>} note="文档版本 id : 这个版本里的第几个分片（从 0 开始数）" />
          <TechRow label="元素类型" value={chunk.element_types.length > 0 ? chunk.element_types.map((item) => `${ELEMENT_TYPE_LABELS[item] ?? item}（${item}）`).join("、") : "未提供"}
            note="解析工具给每块内容标的类型。常见的有：标题 Title、正文段落 NarrativeText、列表项 ListItem、表格 Table、图注 FigureCaption、页眉 Header、页脚 Footer" />
          <TechRow label="组成元素" value={chunk.element_indexes.length > 0 ? `第 ${chunk.element_indexes.map((item) => item + 1).join("、")} 个元素` : "未记录"} note={elementNote(chunk.element_indexes)} />
          <TechRow label="Token 数" value={chunk.token_count ?? "当前向量接口未提供"} warn={chunk.truncated ? "超过向量模型的长度上限，超出的部分没有参与向量计算" : undefined}
            note="向量模型分词后的长度，包括拼在前面的标题路径和上下文说明" />
          {chunk.vector_source && <TechRow label="向量" value={chunk.vector_source === "reused" ? `复用上一版本的分片 ${chunk.reused_from ?? ""}` : "新计算"} note={chunk.vector_source === "reused" ? "分片文字和上一版本完全相同，直接沿用当时的向量" : "上一版本没有文字相同的分片"} />}
          {chunk.context_source && <TechRow label="上下文说明" value={CONTEXT_SOURCE_LABELS[chunk.context_source] ?? chunk.context_source} />}
        </div>
      </details>
    </div>}
  </article>;
}

