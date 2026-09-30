import { useEffect, useState } from "react";
import { submitFeedback, type FeedbackReason, type FeedbackRecord } from "./api";
import "./Feedback.css";

// 点踩原因的显示文字，顺序即界面顺序。
const REASONS: { key: FeedbackReason; label: string }[] = [
  { key: "wrong", label: "答错了" },
  { key: "incomplete", label: "没答全" },
  { key: "missed", label: "资料里有却说找不到" },
  { key: "citation", label: "引用不对" },
  { key: "other", label: "其他" },
];

// 回答下方的反馈栏：点赞或点踩立即保存；点踩后可以再补充原因和正确答案，便于之后排查和转成评测题。
export default function AnswerFeedback({ requestId, initial, onSaved }: { requestId: string; initial?: FeedbackRecord | null; onSaved?: (value: FeedbackRecord) => void }) {
  const [saved, setSaved] = useState<FeedbackRecord | null>(initial ?? null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | null>(initial?.reason ?? null);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 切换会话或历史记录带回新的反馈时，用外部传入的值重置本地状态。
  useEffect(() => {
    setSaved(initial ?? null);
    setReason(initial?.reason ?? null);
    setComment(initial?.comment ?? "");
  }, [requestId, initial]);

  // 提交一次反馈；点赞时不带原因。成功返回 true，失败把错误显示在反馈栏下方。
  async function save(rating: 1 | -1, nextReason: FeedbackReason | null, nextComment: string) {
    setBusy(true);
    setError("");
    try {
      const value = await submitFeedback({ request_id: requestId, rating, reason: rating === -1 ? nextReason : null, comment: nextComment.trim() || null });
      setSaved(value);
      onSaved?.(value);
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // 点击“有帮助 / 没帮助”：点赞直接保存并收起原因面板。
  async function rate(rating: 1 | -1) {
    if (busy) return;
    if (rating === 1) {
      setEditing(false);
      await save(1, null, "");
      return;
    }
    // 点踩先立即记录，用户不填原因也能留下信号；随后展开原因面板。
    const ok = await save(-1, reason, comment);
    if (ok) setEditing(true);
  }

  // 保存补充的原因和说明，成功后收起面板。
  async function submitDetail() {
    if (await save(-1, reason, comment)) setEditing(false);
  }

  const rating = saved?.rating ?? 0;
  const reasonLabel = REASONS.find((item) => item.key === saved?.reason)?.label;
  return <div className="answer-feedback">
    <div className="feedback-bar">
      <span className="feedback-prompt">这个回答有帮助吗？</span>
      <button className={`feedback-button ${rating === 1 ? "is-selected" : ""}`} onClick={() => void rate(1)} disabled={busy} aria-pressed={rating === 1}>有帮助</button>
      <button className={`feedback-button is-negative ${rating === -1 ? "is-selected" : ""}`} onClick={() => void rate(-1)} disabled={busy} aria-pressed={rating === -1}>没帮助</button>
      {rating === -1 && !editing && <span className="feedback-note">已记录{reasonLabel ? `：${reasonLabel}` : ""}<button className="feedback-link" onClick={() => setEditing(true)}>{saved?.reason || saved?.comment ? "修改" : "补充原因"}</button></span>}
      {rating === 1 && <span className="feedback-note">已记录，谢谢</span>}
    </div>
    {editing && rating === -1 && <div className="feedback-detail">
      <div className="feedback-reasons" role="group" aria-label="没帮助的原因">
        {REASONS.map((item) => <button key={item.key} className={`feedback-chip ${reason === item.key ? "is-selected" : ""}`} onClick={() => setReason(reason === item.key ? null : item.key)} aria-pressed={reason === item.key}>{item.label}</button>)}
      </div>
      <textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={2000} rows={2} placeholder="补充说明，或写下正确答案（可选）" />
      <div className="feedback-actions">
        <button className="feedback-link" onClick={() => setEditing(false)} disabled={busy}>取消</button>
        <button className="feedback-submit" onClick={() => void submitDetail()} disabled={busy}>{busy ? "保存中…" : "保存"}</button>
      </div>
    </div>}
    {error && <div className="feedback-error">反馈保存失败：{error}</div>}
  </div>;
}
