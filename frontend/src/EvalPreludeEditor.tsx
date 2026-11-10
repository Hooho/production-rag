import { useEffect, useState } from "react";
import {
  generateEvalPrelude,
  listEvalCorpus,
  type EvalPreludeTurn,
  type Source,
} from "./api";
import { useToast, errorText } from "./Toast";
import { ConfirmPopover } from "./ConfirmPopover";
import { DetailDialog } from "./DetailDialog";
import { HighlightedText } from "./HighlightedText";

export default function EvalPreludeEditor({
  value,
  onChange,
}: {
  value: EvalPreludeTurn[];
  onChange: (turns: EvalPreludeTurn[]) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [corpus, setCorpus] = useState<Awaited<
    ReturnType<typeof listEvalCorpus>
  > | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [sources, setSources] = useState<Record<number, Source[]>>({});
  const [original, setOriginal] = useState<Source | null>(null);
  useEffect(() => {
    let cancelled = false;
    listEvalCorpus()
      .then((data) => {
        if (!cancelled) {
          setCorpus(data);
          setPicked(
            data.items.filter((item) => !item.missing).map((item) => item.id),
          );
        }
      })
      .catch((reason) => toast("error", errorText(reason)));
    return () => {
      cancelled = true;
    };
  }, [toast]);
  function update(index: number, change: Partial<EvalPreludeTurn>) {
    setSources((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => Number(key) < index),
      ),
    );
    onChange(
      value.map((turn, i) =>
        i < index
          ? turn
          : i === index
            ? { ...turn, ...change, confirmed: false }
            : { ...turn, confirmed: false },
      ),
    );
  }
  async function answer(index: number) {
    if (!picked.length) {
      toast("error", "请先选择用于生成答案的语料");
      return;
    }
    setBusy(index);
    try {
      const result = await generateEvalPrelude(
        value[index].question,
        value.slice(0, index),
        picked,
      );
      update(index, { answer: result.answer });
      setSources((current) => ({
        ...Object.fromEntries(
          Object.entries(current).filter(([key]) => Number(key) < index),
        ),
        [index]: result.sources,
      }));
    } catch (reason) {
      toast("error", errorText(reason));
    } finally {
      setBusy(null);
    }
  }
  function move(index: number, offset: number) {
    const next = [...value];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(
      next.map((turn, i) =>
        i < Math.min(index, index + offset)
          ? turn
          : { ...turn, confirmed: false },
      ),
    );
    setSources({});
  }
  return (
    <div className="eval-prelude-editor">
      <div className="unified-eval-prelude-heading">
        <strong>前置对话（可选）</strong>
        <small>问答确认后固定保存，评测时只运行目标问题。</small>
        <button
          type="button"
          className="secondary-button button-sm"
          disabled={value.length >= 20 || busy !== null}
          onClick={() =>
            onChange([...value, { question: "", answer: "", confirmed: false }])
          }
        >
          添加一轮
        </button>
      </div>
      {value.length > 0 && (
        <details>
          <summary>AI 回答使用的语料</summary>
          {corpus?.items
            .filter((item) => !item.missing)
            .map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  disabled={busy !== null}
                  checked={picked.includes(item.id)}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked
                        ? [...picked, item.id]
                        : picked.filter((id) => id !== item.id),
                    )
                  }
                />
                {item.title}
              </label>
            ))}
        </details>
      )}
      {value.map((turn, index) => (
        <article key={index}>
          <strong>
            第 {index + 1} 轮 · {turn.confirmed ? "已确认" : "待确认"}
          </strong>
          <label>
            用户问题
            <input
              maxLength={1000}
              value={turn.question}
              disabled={busy !== null}
              onChange={(e) => update(index, { question: e.target.value })}
            />
          </label>
          <label>
            助手回答
            <textarea
              maxLength={6000}
              value={turn.answer}
              rows={3}
              disabled={busy !== null}
              onChange={(e) => update(index, { answer: e.target.value })}
            />
          </label>
          <div className="eval-prelude-actions">
            <ConfirmPopover
              when={Boolean(turn.answer)}
              message="生成新答案将覆盖当前答案，后续问答需重新确认。"
              confirmText="生成 RAG 回答"
              disabled={
                busy !== null ||
                !turn.question.trim() ||
                value.slice(0, index).some((item) => !item.confirmed)
              }
              onConfirm={() => answer(index)}
            >
              <button
                type="button"
                className={`secondary-button button-sm${busy === index ? " is-loading" : ""}`}
                disabled={
                  busy !== null ||
                  !turn.question.trim() ||
                  value.slice(0, index).some((item) => !item.confirmed)
                }
              >
                AI 回答
              </button>
            </ConfirmPopover>
            <button
              type="button"
              className="secondary-button button-sm"
              disabled={
                busy !== null ||
                !turn.question.trim() ||
                !turn.answer.trim() ||
                value.slice(0, index).some((item) => !item.confirmed)
              }
              onClick={() =>
                onChange(
                  value.map((item, i) =>
                    i === index ? { ...item, confirmed: true } : item,
                  ),
                )
              }
            >
              确认本轮
            </button>
            <button
              type="button"
              className="secondary-button button-sm"
              disabled={busy !== null || index === 0}
              onClick={() => move(index, -1)}
            >
              上移
            </button>
            <button
              type="button"
              className="secondary-button button-sm"
              disabled={busy !== null || index === value.length - 1}
              onClick={() => move(index, 1)}
            >
              下移
            </button>
            <ConfirmPopover
              message="删除本轮后，后续问答需要重新确认。"
              confirmText="删除本轮"
              danger
              onConfirm={() => {
                onChange(
                  value
                    .filter((_, i) => i !== index)
                    .map((item, i) =>
                      i < index ? item : { ...item, confirmed: false },
                    ),
                );
                setSources({});
              }}
            >
              <button
                type="button"
                className="delete-button button-sm"
                disabled={busy !== null}
              >
                删除
              </button>
            </ConfirmPopover>
          </div>
          {sources[index]?.length > 0 && (
            <div>
              检索出处：
              {sources[index].map((source) => (
                <button
                  key={source.id}
                  type="button"
                  className="link-button button-sm"
                  onClick={() => setOriginal(source)}
                >
                  {source.id} · {source.title}
                </button>
              ))}
            </div>
          )}
        </article>
      ))}
      {original && (
        <DetailDialog
          open
          title={`前置回答出处 · ${original.title}`}
          onClose={() => setOriginal(null)}
        >
          <HighlightedText text={original.text} />
        </DetailDialog>
      )}
    </div>
  );
}
