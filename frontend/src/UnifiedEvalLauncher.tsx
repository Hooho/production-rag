import { useEffect, useState } from "react";
import {
  listEvalConfigTemplates,
  saveEvalConfigTemplate,
  type EvalConfigTemplate,
  getEvalParamOptions,
  listEvalCorpus,
  listEvalSuites,
  startEvalBatch,
  type EvalLaunchBody,
  type EvalMode,
  type EvalParams,
} from "./api";
import EvalParamsPanel, {
  visibleParams,
  paramsSummary,
} from "./EvalParamsPanel";
import { ConfirmPopover } from "./ConfirmPopover";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import { useToast, errorText } from "./Toast";
import "./UnifiedEval.css";

type Method = "dense" | "keyword" | "graph";
type Config = {
  label: string;
  kind: "retrieval" | "generation";
  mode: EvalMode;
  methods: Method[];
  params: EvalParams;
};
const empty = (index: number): Config => ({
  label: `配置 ${"ABCD"[index]}`,
  kind: "retrieval",
  mode: "fixed",
  methods: ["dense", "keyword"],
  params: {},
});
export default function UnifiedEvalLauncher({
  onStarted,
  disabled,
  initialTemplate,
}: {
  onStarted: (id: string) => void;
  disabled: boolean;
  initialTemplate?: EvalConfigTemplate | null;
}) {
  const toast = useToast();
  const [data, setData] = useState<{
    params: Awaited<ReturnType<typeof getEvalParamOptions>>;
    corpus: Awaited<ReturnType<typeof listEvalCorpus>>;
    suites: Awaited<ReturnType<typeof listEvalSuites>>;
  } | null>(null);
  const [templates, setTemplates] = useState<EvalConfigTemplate[]>([]);
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [templateBusy, setTemplateBusy] = useState<string | null>(null);
  const [templateBaseline, setTemplateBaseline] = useState("");
  const [configs, setConfigs] = useState<Config[]>([]);
  const [draft, setDraft] = useState<Config>(empty(0));
  const [editing, setEditing] = useState(0);
  const [source, setSource] = useState("dev");
  const [suiteIds, setSuiteIds] = useState<string[]>([]);
  const [corpusIds, setCorpusIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getEvalParamOptions(), listEvalCorpus(), listEvalSuites()])
      .then(([params, corpus, suites]) => {
        if (!cancelled) {
          setData({ params, corpus, suites });
          if (!initialTemplate)
            setCorpusIds(
              corpus.items
                .filter((item) => !item.missing)
                .map((item) => item.id),
            );
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setLoadError(true);
          toast("error", errorText(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast, reload]);
  useEffect(() => {
    listEvalConfigTemplates()
      .then((result) => setTemplates(result.items))
      .catch((reason) => toast("error", errorText(reason)));
  }, [toast]);
  useEffect(() => {
    if (initialTemplate && data) applyTemplate(initialTemplate);
  }, [initialTemplate, data]);
  function applyTemplate(template: EvalConfigTemplate) {
    const c = template.config;
    if (template.issues?.length)
      toast("error", `模板需要修正：${template.issues.join("；")}`);
    if (data) {
      const invalidCorpus = (c.corpus_ids ?? []).filter(
        (id) =>
          !data.corpus.items.some((item) => item.id === id && !item.missing),
      );
      const invalidSuites = (c.suite_ids ?? []).filter(
        (id) => !data.suites.items.some((item) => item.id === id),
      );
      if (invalidCorpus.length || invalidSuites.length) {
        toast("error", "模板中的题集或语料已失效，请重新选择并更新配置模板");
      }
    }
    setPendingTemplate(null);
    const next: Config = {
      label: template.name,
      kind: c.kind === "generation" ? "generation" : "retrieval",
      mode: c.mode,
      methods: c.methods,
      params: c.params ?? {},
    };
    setDraft(next);
    setTemplateId(template.id);
    if (editing === 0 || configs.length === 0) {
      setSource(c.suite_ids?.length ? "suite" : (c.split ?? "dev"));
      setSuiteIds(c.suite_ids ?? []);
      setCorpusIds(c.corpus_ids ?? []);
    } else toast("success", "已加载执行配置；题目和语料沿用第一组");
    setTemplateBaseline(
      JSON.stringify({
        draft: next,
        source:
          editing === 0 || !configs.length
            ? c.suite_ids?.length
              ? "suite"
              : (c.split ?? "dev")
            : source,
        suiteIds:
          editing === 0 || !configs.length ? (c.suite_ids ?? []) : suiteIds,
        corpusIds:
          editing === 0 || !configs.length ? (c.corpus_ids ?? []) : corpusIds,
      }),
    );
  }
  async function persistTemplate(update: boolean) {
    if (
      !draft.label.trim() ||
      !draft.methods.length ||
      !corpusIds.length ||
      (source === "suite" && !suiteIds.length)
    ) {
      toast("error", "请填写名称、检索方式、题集和语料");
      return;
    }
    setTemplateBusy(update ? "update" : "save");
    try {
      const result = await saveEvalConfigTemplate(
        draft.label.trim(),
        {
          version: 2,
          label: draft.label,
          kind: draft.kind,
          mode: draft.mode,
          modes: [draft.mode],
          methods: draft.methods,
          split: source === "suite" ? "all" : source,
          suite_ids: source === "suite" ? suiteIds : [],
          corpus_ids: corpusIds,
          params: draft.params,
        },
        update ? templateId : undefined,
      );
      setTemplates((await listEvalConfigTemplates()).items);
      setTemplateId(result.id);
      setTemplateBaseline(
        JSON.stringify({ draft, source, suiteIds, corpusIds }),
      );
      toast("success", update ? "配置模板已更新" : "配置模板已保存");
    } catch (reason) {
      toast("error", errorText(reason));
    } finally {
      setTemplateBusy(null);
    }
  }
  if (!data && loadError)
    return (
      <section className="unified-eval-launch">
        <p>评测配置暂时无法读取。</p>
        <button
          type="button"
          className={`secondary-button${loading ? " is-loading" : ""}`}
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          重试
        </button>
      </section>
    );
  if (!data)
    return (
      <LoadingSkeleton label="正在加载评测配置">
        <SkeletonBlock />
        <SkeletonBlock />
        <SkeletonBlock />
      </LoadingSkeleton>
    );
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify(configs[editing] ?? empty(editing));
  const sharedDisabled = editing !== 0 && configs.length > 0;
  function save() {
    if (!draft.label.trim() || !draft.methods.length) {
      toast("error", "请填写配置名称并至少选择一种检索方式");
      return;
    }
    const next = [...configs];
    next[editing] = { ...draft, label: draft.label.trim() };
    setConfigs(next);
    // 保存完就把表单重置：接着填下一组，不再停在刚存好的这一份上。
    // 最多 4 组，存满后就留在最后一份上。
    if (next.length < 4) {
      setEditing(next.length);
      setDraft(empty(next.length));
      setTemplateId("");
      setTemplateBaseline("");
    } else {
      setEditing(editing);
      setDraft(next[editing]);
    }
  }
  async function launch() {
    if (!data || !configs.length || dirty) {
      toast("error", "请先将当前配置加入本次运行");
      return;
    }
    if (!corpusIds.length || (source === "suite" && !suiteIds.length)) {
      toast("error", "请选择题集和评测语料");
      return;
    }
    if (configs.some((config) => config.methods.includes("graph"))) {
      const missing = data.corpus.items.filter(
        (item) => corpusIds.includes(item.id) && !item.graph_ready,
      );
      if (missing.length) {
        toast(
          "error",
          `请先为这些文档建立生效图谱，或取消图检索：${missing.map((item) => item.title).join("、")}`,
        );
        return;
      }
    }
    setBusy(true);
    try {
      const bodies: (EvalLaunchBody & {
        version: 2;
        mode: EvalMode;
        methods: Method[];
      })[] = configs.map((config) => ({
        version: 2,
        label: config.label,
        kind: config.kind,
        mode: config.mode,
        modes: [config.mode],
        methods: config.methods,
        split: source === "suite" ? "all" : source,
        suite_ids: source === "suite" ? suiteIds : [],
        corpus_ids: corpusIds,
        params: visibleParams(
          config.params,
          data.params,
          ["common", config.mode],
          config.kind === "generation",
        ),
      }));
      const result = await startEvalBatch("", bodies);
      toast("success", `${configs.length} 组配置已开始评测`);
      onStarted(result.id);
    } catch (reason) {
      toast("error", errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="unified-eval-launch">
      <header>
        <strong>发起评测</strong>
        <span>最多 4 组 · 同一批题目和语料 · 开始时固定实际参数</span>
      </header>
      <div className="unified-eval-row">
        <span>选择配置模板</span>
        <div className="unified-eval-options">
          <select
            aria-label="选择配置模板"
            value={pendingTemplate ?? templateId}
            disabled={templateBusy !== null}
            onChange={(event) => {
              const id = event.target.value;
              if (
                (templateId &&
                  templateBaseline !==
                    JSON.stringify({ draft, source, suiteIds, corpusIds })) ||
                (!templateId &&
                  (JSON.stringify(draft) !== JSON.stringify(empty(editing)) ||
                    source !== "dev" ||
                    suiteIds.length > 0 ||
                    JSON.stringify(corpusIds) !==
                      JSON.stringify(
                        data.corpus.items
                          .filter((item) => !item.missing)
                          .map((item) => item.id),
                      )))
              ) {
                setPendingTemplate(id);
                return;
              }
              const template = templates.find((item) => item.id === id);
              if (template) applyTemplate(template);
              else {
                setTemplateId("");
                setDraft(empty(editing));
                setTemplateBaseline("");
              }
            }}
          >
            <option value="">新建配置模板</option>
            {templates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {pendingTemplate !== null && (
            <>
              <ConfirmPopover
                message="切换会覆盖当前未保存的表单修改，是否继续？"
                confirmText="切换模板"
                onConfirm={() => {
                  const template = templates.find(
                    (item) => item.id === pendingTemplate,
                  );
                  if (template) applyTemplate(template);
                  else {
                    setTemplateId("");
                    setDraft(empty(editing));
                    setPendingTemplate(null);
                  }
                }}
              >
                <button type="button" className="secondary-button">
                  加载选中模板
                </button>
              </ConfirmPopover>
              <button
                type="button"
                className="link-button"
                onClick={() => setPendingTemplate(null)}
              >
                取消切换
              </button>
            </>
          )}

          {(suiteIds.some(
            (id) => !data.suites.items.some((item) => item.id === id),
          ) ||
            corpusIds.some(
              (id) =>
                !data.corpus.items.some(
                  (item) => item.id === id && !item.missing,
                ),
            )) && (
            <>
              <small>存在失效的题集或语料选择</small>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setSuiteIds((ids) =>
                    ids.filter((id) =>
                      data.suites.items.some((item) => item.id === id),
                    ),
                  );
                  setCorpusIds((ids) =>
                    ids.filter((id) =>
                      data.corpus.items.some(
                        (item) => item.id === id && !item.missing,
                      ),
                    ),
                  );
                }}
              >
                移除失效选择
              </button>
            </>
          )}
        </div>
      </div>

      <div className="unified-eval-columns">
        <div className="unified-eval-editor">
          <label className="unified-eval-row">
            <span>配置名称</span>
            <input
              maxLength={40}
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </label>
          <div className="unified-eval-row">
            <span>评测类型</span>
            <div className="unified-eval-options">
              {(
                [
                  ["retrieval", "检索评测"],
                  ["generation", "生成评测"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="unified-kind"
                    checked={draft.kind === value}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        kind: value,
                        mode: value === "generation" ? "fixed" : draft.mode,
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="unified-eval-row">
            <span>运行模式</span>
            <div className="unified-eval-options">
              {(
                [
                  ["fixed", "固定流程"],
                  ["agent", "Agent"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  title={
                    value === "agent" && draft.kind === "generation"
                      ? "生成评测暂不支持 Agent"
                      : undefined
                  }
                >
                  <input
                    type="radio"
                    name="unified-mode"
                    disabled={value === "agent" && draft.kind === "generation"}
                    checked={draft.mode === value}
                    onChange={() => setDraft({ ...draft, mode: value })}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="unified-eval-row">
            <span>检索方式</span>
            <div className="unified-eval-options">
              {(
                [
                  ["dense", "向量检索"],
                  ["keyword", "关键词检索"],
                  ["graph", "图检索"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={draft.methods.includes(value)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        methods: e.target.checked
                          ? [...draft.methods, value]
                          : draft.methods.filter((item) => item !== value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="unified-eval-row">
            <span>题目来源</span>
            <div>
              <select
                disabled={sharedDisabled}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="dev">开发集</option>
                <option value="holdout">留出集</option>
                <option value="all">全部已审核题目</option>
                <option value="suite">自建题集（原专项）</option>
              </select>
              {sharedDisabled && <small>沿用第一组题目和语料</small>}
            </div>
          </div>
          {source === "suite" && (
            <div className="unified-eval-row">
              <span>选择题集</span>
              <div className="unified-eval-options">
                {data.suites.items.map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      disabled={sharedDisabled}
                      checked={suiteIds.includes(item.id)}
                      onChange={(e) =>
                        setSuiteIds(
                          e.target.checked
                            ? [...suiteIds, item.id]
                            : suiteIds.filter((id) => id !== item.id),
                        )
                      }
                    />
                    {item.name}（{item.item_count}题）
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="unified-eval-row">
            <span>评测语料</span>
            <div className="unified-eval-options">
              {data.corpus.items
                .filter((item) => !item.missing)
                .map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      disabled={sharedDisabled}
                      checked={corpusIds.includes(item.id)}
                      onChange={(e) =>
                        setCorpusIds(
                          e.target.checked
                            ? [...corpusIds, item.id]
                            : corpusIds.filter((id) => id !== item.id),
                        )
                      }
                    />
                    {item.title}{" "}
                    {draft.methods.includes("graph") && (
                      <small>{item.graph_ready ? "图谱可用" : "未建图"}</small>
                    )}
                  </label>
                ))}
            </div>
          </div>
          <div className="unified-eval-row">
            <span>参数配置</span>
            <EvalParamsPanel
              methods={draft.methods}
              options={data.params}
              value={draft.params}
              onChange={(params) => setDraft({ ...draft, params })}
              groups={["common", draft.mode]}
              showJudge={draft.kind === "generation"}
            />
          </div>
          <footer>
            <span>
              {dirty
                ? "当前修改尚未加入本次运行"
                : editing >= configs.length
                  ? "新配置还没保存"
                  : "已加入本次运行"}
            </span>
            <div className="unified-eval-options">
              <button
                type="button"
                className={`secondary-button${templateBusy === "save" ? " is-loading" : ""}`}
                disabled={templateBusy !== null}
                onClick={() => void persistTemplate(false)}
              >
                保存配置模板
              </button>
              {templateId && (
                <ConfirmPopover
                  message="更新此配置模板？后续加载使用新配置，历史评测报告保留。"
                  confirmText="更新配置模板"
                  onConfirm={() => persistTemplate(true)}
                >
                  <button
                    type="button"
                    className={`secondary-button${templateBusy === "update" ? " is-loading" : ""}`}
                    disabled={templateBusy !== null}
                  >
                    更新配置模板
                  </button>
                </ConfirmPopover>
              )}
              {templateId &&
                templateBaseline !==
                  JSON.stringify({ draft, source, suiteIds, corpusIds }) && (
                  <small>模板有未保存修改</small>
                )}
              <button type="button" className="secondary-button" onClick={save}>
                加入本次运行
              </button>
            </div>
          </footer>
        </div>
        <aside className="unified-eval-configs">
          <strong>本次运行配置（{configs.length}/4）</strong>
          {!configs.length && <p>先加入第一份配置，再添加其他方案进行对比。</p>}
          {configs.map((config, index) => (
            <article
              key={index}
              className={editing === index ? "is-current" : ""}
            >
              <strong>
                {config.label}
                {index === 0 ? " · 比较基准" : ""}
              </strong>
              <p>
                {config.kind === "retrieval" ? "检索评测" : "生成评测"} ·{" "}
                {config.mode === "fixed" ? "固定流程" : "Agent"} ·{" "}
                {config.methods
                  .map(
                    (m) =>
                      ({ dense: "向量", keyword: "关键词", graph: "图" })[m],
                  )
                  .join("＋")}
              </p>
              <small>
                {paramsSummary(config.params).join("；") ||
                  "参数跟随开始时的系统设置"}
              </small>
              <div>
                <ConfirmPopover
                  when={dirty}
                  message="当前未保存的配置修改将丢失。"
                  confirmText="切换配置"
                  onConfirm={() => {
                    setEditing(index);
                    setDraft(structuredClone(config));
                  }}
                >
                  <button type="button" className="secondary-button button-sm">
                    编辑
                  </button>
                </ConfirmPopover>
                <button
                  type="button"
                  className="secondary-button button-sm"
                  disabled={configs.length >= 4}
                  onClick={() => {
                    const next = {
                      ...structuredClone(config),
                      label: `配置 ${"ABCD"[configs.length]}`,
                    };
                    setConfigs([...configs, next]);
                  }}
                >
                  复制
                </button>
                <ConfirmPopover
                  message="移除此配置后，本次列表中的配置内容将丢失。"
                  confirmText="移除配置"
                  onConfirm={() => {
                    const next = configs.filter((_, i) => i !== index);
                    setConfigs(next);
                    setEditing(0);
                    setDraft(next[0] ? structuredClone(next[0]) : empty(0));
                  }}
                >
                  <button type="button" className="delete-button button-sm">
                    移除
                  </button>
                </ConfirmPopover>
              </div>
            </article>
          ))}
          <ConfirmPopover
            when={dirty}
            message="当前未保存的配置修改将丢失。"
            confirmText="添加配置"
            onConfirm={() => {
              setEditing(configs.length);
              setDraft(empty(configs.length));
            }}
          >
            <button
              type="button"
              className="secondary-button"
              disabled={configs.length >= 4}
            >
              添加配置
            </button>
          </ConfirmPopover>
        </aside>
      </div>
      <footer>
        <span>已保存 {configs.length} 组；题目、语料由第一组统一选择。</span>
        <button
          type="button"
          className={`primary-button${busy ? " is-loading" : ""}`}
          disabled={busy || disabled || !configs.length || dirty}
          onClick={() => void launch()}
        >
          运行所选配置
        </button>
      </footer>
    </section>
  );
}
