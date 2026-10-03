import { useEffect, useState } from "react";
import { locateEvalEvidence, type EvalEvidenceChunk, type EvalEvidenceLookup } from "./api";
import "./EvidenceChunks.css";

// 证据原文所在的分片：展开时到评测语料当前的分片里现查（题目不存分片 id，分片规则变了也不会指错），
// 整段显示分片正文，证据那句高亮；本地向量模型能给出截断位置时，没参与向量计算的部分标灰。
export function EvidenceChunks({ texts }: { texts: string[] }) {
  const [data, setData] = useState<EvalEvidenceLookup | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    locateEvalEvidence(texts).then((value) => { if (!cancelled) setData(value); }).catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [texts.join("\n")]);

  if (error) return <p className="evc-note is-warn">{error}</p>;
  if (!data) return <p className="evc-note">正在查找所在分片…</p>;
  return <div className="evc-root">
    {!data.imported && <p className="evc-note">评测语料还没导入（还没跑过评测），这里按当前分片规则临时切分，没有 token 数。</p>}
    {data.imported && !data.cuts_available && <p className="evc-note">当前不是本地向量模型，拿不到截断位置，没法标出哪部分没参与向量计算。</p>}
    {data.items.map((item, index) => <div key={index} className="evc-item">
      {data.items.length > 1 && <div className="evc-evidence">证据 {index + 1}：{item.text}</div>}
      {item.chunks.length === 0 ? <p className="evc-note is-warn">当前分片里找不到这条证据：可能正好跨在两个分片中间，或者语料改过。这道题需要改短证据或重新标注。</p>
        : item.chunks.map((chunk, chunkIndex) => <ChunkView key={chunkIndex} chunk={chunk} />)}
    </div>)}
  </div>;
}

function ChunkView({ chunk }: { chunk: EvalEvidenceChunk }) {
  const [start, end] = chunk.match;
  const cut = chunk.cut;
  const inCut = cut !== null && start >= cut;
  const cutChars = cut === null ? 0 : chunk.content.length - cut;
  return <div className="evc-chunk">
    <div className="evc-chunk-head">
      <strong>《{chunk.title}》</strong>
      {chunk.heading && <span>{chunk.heading}</span>}
      <span>第 {chunk.position + 1} 段 · {chunk.chars} 字{chunk.token_count !== null ? ` · ${chunk.token_count} token` : ""}</span>
      {chunk.truncated && <span className="evc-tag is-cut">超过 {chunk.max_tokens ?? 512} token，最后 {cutChars} 字没参与向量计算</span>}
      {chunk.truncated && <span className={`evc-tag ${inCut ? "is-cut" : "is-ok"}`}>{inCut ? "证据在被截掉的部分" : "证据在保留的部分"}</span>}
    </div>
    {chunk.prefix && <details className="evc-prefix"><summary>算向量时正文前面还加了一段</summary><div>{chunk.prefix}</div></details>}
    <div className="evc-content">{pieces(chunk.content, start, end, cut).map((piece, index) => <span key={index} className={`${piece.match ? "evc-match" : ""} ${piece.cut ? "evc-cut" : ""}`}>{piece.text}</span>)}</div>
    {cut !== null && <p className="evc-note">灰色部分没参与向量计算，只能靠关键词检索找到。</p>}
  </div>;
}

// 按证据起止位置和截断位置把正文切成几段，分别标记是否高亮、是否被截掉。
function pieces(text: string, start: number, end: number, cut: number | null) {
  const points = Array.from(new Set([0, start, end, cut ?? text.length, text.length])).filter((value) => value >= 0 && value <= text.length).sort((a, b) => a - b);
  const result: { text: string; match: boolean; cut: boolean }[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (to <= from) continue;
    result.push({ text: text.slice(from, to), match: from >= start && to <= end, cut: cut !== null && from >= cut });
  }
  return result;
}

// 默认收起；第一次展开时才去查，列表里几十道题不会一打开页面就各查一遍。
export function EvidenceDetails({ texts, summary = "看证据所在的分片" }: { texts: string[]; summary?: string }) {
  const [opened, setOpened] = useState(false);
  if (texts.length === 0) return null;
  return <details className="evc-details" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) setOpened(true); }}>
    <summary>{summary}</summary>
    {opened && <EvidenceChunks texts={texts} />}
  </details>;
}
