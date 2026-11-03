import { useEffect, useMemo, useState } from "react";
import {
  buildDocumentGraph,
  buildGraphBatch,
  estimateDocumentGraph,
  getGraphSchemas,
  getLLMSettings,
  type GraphEstimate,
  type GraphSchemas,
  type LLMProfile,
} from "./api";

type ShowToast = (kind: "success" | "error", message: string) => void;
export type GraphChoice = {
  schema_id: string | null;
  provider: string | null;
  model: string | null;
};

// 清单和抽取模型的选择，建图对话框和上传弹窗共用。
// 清单可以展开看内容和「如何匹配」（规范化规则、合并规则、实际发给模型的提示词）；模型列出已保存的模型配置，默认选当前启用的。
export function GraphOptions({
  value,
  onChange,
}: {
  value: GraphChoice;
  onChange: (value: GraphChoice) => void;
}) {
  const [schemas, setSchemas] = useState<GraphSchemas | null>(null);
  const [profiles, setProfiles] = useState<LLMProfile[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    Promise.all([getGraphSchemas(), getLLMSettings().catch(() => null)])
      .then(([schemaList, llm]) => {
        if (cancelled) return;
        setSchemas(schemaList);
        const items = llm?.profiles ?? [];
        setProfiles(items);
        const active = items.find((item) => item.is_active) ?? null;
        onChange({
          schema_id: value.schema_id ?? schemaList.default_id,
          provider: value.provider ?? active?.provider ?? llm?.provider ?? null,
          model: value.model ?? active?.model ?? llm?.model ?? null,
        });
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
    // 只在打开时读一次。
  }, []);
  const schema =
    schemas?.schemas.find((item) => item.id === value.schema_id) ?? null;
  if (error) return <div className="field-error">{error}</div>;
  if (!schemas) return <p className="graph-note">正在读取清单和模型配置…</p>;
  return (
    <>
      <div className="graph-dialog-section">
        <label>清单（抽哪些实体、关系分哪几类）</label>
        <select
          value={value.schema_id ?? ""}
          onChange={(event) =>
            onChange({ ...value, schema_id: event.target.value })
          }
        >
          {schemas.schemas.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} v{item.version}
              {item.source === "default" ? "（内置）" : ""}
            </option>
          ))}
        </select>
        {schema && (
          <details>
            <summary className="graph-note">查看清单内容</summary>
            <div className="graph-schema-list">
              {schema.entity_types.map((item) => (
                <FragmentRow
                  key={`e-${item.name}`}
                  name={item.name}
                  text={item.description}
                  examples={item.examples}
                />
              ))}
            </div>
            <p className="graph-note">
              关系分类（关系本身用一句话描述，分类只用于筛选）：
            </p>
            <div className="graph-schema-list">
              {schema.relation_categories.map((item) => (
                <FragmentRow
                  key={`r-${item.name}`}
                  name={item.name}
                  text={item.description}
                />
              ))}
            </div>
            {schema.note && <p className="graph-note">{schema.note}</p>}
          </details>
        )}
        <details>
          <summary className="graph-note">
            如何匹配（规范化、合并规则和发给模型的提示词）
          </summary>
          <p className="graph-note">名字规范化：</p>
          <ol className="graph-note">
            {schemas.matching.normalize.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
          <p className="graph-note">合并规则：</p>
          <ol className="graph-note">
            {schemas.matching.merge.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
          <p className="graph-note">
            系统提示词（{schemas.prompt.tag}，在「系统管理 → 提示词」里修改）：
          </p>
          <pre className="graph-prompt">{schemas.prompt.system}</pre>
          <p className="graph-note">用户消息示例（清单在建图时填进来）：</p>
          <pre className="graph-prompt">{schemas.prompt.example_user}</pre>
        </details>
      </div>
      <div className="graph-dialog-section">
        <label>抽取模型</label>
        {profiles.length > 0 ? (
          <select
            value={value.provider ?? ""}
            onChange={(event) => {
              const profile = profiles.find(
                (item) => item.provider === event.target.value,
              );
              onChange({
                ...value,
                provider: profile?.provider ?? null,
                model: profile?.model ?? null,
              });
            }}
          >
            {profiles.map((item) => (
              <option key={item.provider} value={item.provider}>
                {item.provider} · {item.model}
                {item.is_active ? "（当前启用）" : ""}
              </option>
            ))}
          </select>
        ) : (
          <p className="graph-note">
            {value.model
              ? `当前启用的模型：${value.provider} · ${value.model}`
              : "还没有配置聊天模型，请先在「系统管理 → 模型配置」里配置"}
          </p>
        )}
        {schemas.model_mode !== "openai" && (
          <p className="graph-estimate is-warn">
            现在是演示模式（MODEL_MODE=demo），没有大模型，不能建图。
          </p>
        )}
      </div>
    </>
  );
}

function FragmentRow({
  name,
  text,
  examples,
}: {
  name: string;
  text: string;
  examples?: string[];
}) {
  return (
    <>
      <b>{name}</b>
      <span>
        {text}
        {examples && examples.length > 0 && (
          <small>，例如 {examples.join("、")}</small>
        )}
      </span>
    </>
  );
}

// 建图对话框：一份文档时显示预估（要新抽取几片、能复用几片，也就是要调用模型几次）；多份时批量建图。
export function GraphBuildDialog({
  documentIds,
  title,
  onClose,
  onStarted,
  onToast,
}: {
  documentIds: string[];
  title: string;
  onClose: () => void;
  onStarted: () => void;
  onToast: ShowToast;
}) {
  const [choice, setChoice] = useState<GraphChoice>({
    schema_id: null,
    provider: null,
    model: null,
  });
  const [estimate, setEstimate] = useState<GraphEstimate | null>(null);
  const [estimateError, setEstimateError] = useState("");
  const [busy, setBusy] = useState(false);
  const single = documentIds.length === 1 ? documentIds[0] : null;
  const ready = Boolean(choice.schema_id);
  const estimateKey = useMemo(
    () => `${choice.schema_id}|${choice.provider}|${choice.model}`,
    [choice],
  );
  useEffect(() => {
    if (!single || !ready) return;
    let cancelled = false;
    setEstimate(null);
    setEstimateError("");
    estimateDocumentGraph(
      single,
      choice.schema_id,
      choice.provider,
      choice.model,
    )
      .then((value) => !cancelled && setEstimate(value))
      .catch((reason: Error) => !cancelled && setEstimateError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [single, estimateKey]);

  async function submit() {
    setBusy(true);
    const body = {
      schema_id: choice.schema_id,
      llm: choice.provider
        ? { provider: choice.provider, model: choice.model }
        : null,
    };
    try {
      if (single) {
        await buildDocumentGraph(single, body);
        onToast(
          "success",
          "已开始建图，抽取进度会显示在这里，处理流程里也能看到。",
        );
      } else {
        const result = await buildGraphBatch(documentIds, body);
        const skipped = result.skipped
          .map((item) => `《${item.title ?? item.document_id}》${item.reason}`)
          .join("；");
        onToast(
          result.started.length > 0 ? "success" : "error",
          `已开始 ${result.started.length} 份文档的建图${skipped ? `；没有开始的：${skipped}` : ""}`,
        );
      }
      onStarted();
    } catch (reason) {
      onToast("error", (reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="upload-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="upload-modal graph-dialog">
        <div className="upload-modal-heading">
          <div>
            <h2>建图</h2>
            <p>{title}</p>
          </div>
          <button className="upload-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <GraphOptions value={choice} onChange={setChoice} />
        {single && (
          <div className="graph-dialog-section">
            {estimateError ? (
              <p className="graph-estimate is-warn">{estimateError}</p>
            ) : estimate ? (
              <p
                className={`graph-estimate ${estimate.to_extract > 0 ? "" : "is-warn"}`}
              >
                共 {estimate.total} 个分片：可以复用以前的抽取结果{" "}
                {estimate.reusable} 个，需要调用模型 {estimate.to_extract} 次（
                {estimate.prompt_tag}）。
                {estimate.to_extract === 0
                  ? "分片、清单、模型和提示词都没变，这次不会调用模型。"
                  : ""}
              </p>
            ) : (
              <p className="graph-note">正在预估…</p>
            )}
          </div>
        )}
        {!single && (
          <p className="graph-note">
            共 {documentIds.length}{" "}
            份文档，每份文档都按上面的清单和模型建图；没处理完、正在建图的会跳过并说明原因。
          </p>
        )}
        <div className="upload-modal-actions">
          <button className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={busy || !ready || Boolean(single && estimateError)}
            onClick={() => void submit()}
          >
            {busy ? "提交中…" : "开始建图 →"}
          </button>
        </div>
      </div>
    </div>
  );
}
