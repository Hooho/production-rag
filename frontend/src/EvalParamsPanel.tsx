import { useState, type ReactNode } from "react";
import type {
  EvalParamGroup,
  EvalParamOptions,
  EvalParams,
  RuntimeSettingItem,
  RuntimeSettingValue,
} from "./api";
import { settingLabel } from "./SystemSettings";
import { useAnchoredBubble } from "./Popover";
import "./EvalParams.css";

// 发起评测页的「参数配置」：模型、运行参数、提示词版本，每项默认跟随系统设置，改成自定义后只对这一次评测生效
// （后端见 app/evaluation/params.py）。分三组，跟着勾选的运行模式显示；每组默认收起，标题行写着改了哪几项。

type SettingItem = EvalParamOptions["settings"][number];
type PromptItem = EvalParamOptions["prompts"][number];
type ParamGroup = EvalParamOptions["groups"][number];

// 只保留要显示的组里的参数：例如没勾 Agent 时，之前改过的 Agent 参数不提交。
export function visibleParams(
  params: EvalParams,
  options: EvalParamOptions | null,
  groups: EvalParamGroup[],
  showJudge: boolean,
): EvalParams {
  if (!options) return {};
  const groupOf = (key: string) =>
    options.settings.find((item) => item.key === key)?.eval;
  const promptGroup = (id: string) =>
    options.prompts.find((item) => item.id === id)?.eval;
  const result: EvalParams = {};
  if (params.llm && groups.includes("common")) result.llm = params.llm;
  if (params.judge && showJudge) result.judge = params.judge;
  const settings = Object.fromEntries(
    Object.entries(params.settings ?? {}).filter(([key]) => {
      const group = groupOf(key);
      return group !== undefined && groups.includes(group);
    }),
  );
  if (Object.keys(settings).length) result.settings = settings;
  const prompts = Object.fromEntries(
    Object.entries(params.prompts ?? {}).filter(([id]) => {
      const group = promptGroup(id);
      return group !== undefined && groups.includes(group);
    }),
  );
  if (Object.keys(prompts).length) result.prompts = prompts;
  return result;
}

// 评测记录上「自定义参数」的一行行说明，例如「Agent 相关度阈值：0.2」。
export function paramsSummary(params: EvalParams | undefined): string[] {
  if (!params) return [];
  const lines: string[] = [];
  if (params.llm)
    lines.push(`大模型：${params.llm.model ?? params.llm.provider}`);
  if (params.judge)
    lines.push(`评审模型：${params.judge.model ?? params.judge.provider}`);
  for (const [key, value] of Object.entries(params.settings ?? {}))
    lines.push(`${settingLabel(key)}：${formatValue(value)}`);
  for (const [id, version] of Object.entries(params.prompts ?? {}))
    lines.push(
      `${PROMPT_LABELS[id] ?? id}提示词：${version ? `v${version}` : "内置"}`,
    );
  return lines;
}

const PROMPT_LABELS: Record<string, string> = {
  intent: "改写",
  sufficiency: "充分性判断",
  answer: "回答",
  agent: "Agent ",
};

function formatValue(value: RuntimeSettingValue) {
  if (typeof value === "boolean") return value ? "开" : "关";
  return String(value);
}

export default function EvalParamsPanel({
  options,
  value,
  onChange,
  groups,
  showJudge,
  methods,
}: {
  options: EvalParamOptions | null;
  value: EvalParams;
  onChange: (next: EvalParams) => void;
  groups: EvalParamGroup[];
  showJudge: boolean;
  methods?: string[];
}) {
  const [openGroup, setOpenGroup] = useState<EvalParamGroup | null>(null);
  const visible =
    options?.groups.filter((group) => groups.includes(group.key)) ?? [];
  const open = visible.find((group) => group.key === openGroup);
  // 点开的参数组在标题按钮旁边弹一个气泡，不再把下面的表单撑开。
  const { anchor, bubble, place, style } = useAnchoredBubble(
    open !== undefined,
    (next) => {
      if (!next) setOpenGroup(null);
    },
  );
  if (!options) {
    return <span className="ev-muted-note">正在读取参数…</span>;
  }
  const setSetting = (key: string, next: RuntimeSettingValue | undefined) => {
    const settings = { ...(value.settings ?? {}) };
    if (next === undefined) delete settings[key];
    else settings[key] = next;
    onChange({ ...value, settings });
  };
  const setPrompt = (id: string, next: number | undefined) => {
    const prompts = { ...(value.prompts ?? {}) };
    if (next === undefined) delete prompts[id];
    else prompts[id] = next;
    onChange({ ...value, prompts });
  };
  const setModel = (
    key: "llm" | "judge",
    next: EvalParams["llm"] | undefined,
  ) => {
    const result = { ...value };
    if (next === undefined) delete result[key];
    else result[key] = next;
    onChange(result);
  };

  // 一组里有哪些参数：模型（只在公共参数组里）、运行参数、提示词版本。
  const groupItems = (group: ParamGroup) => {
    const effective = (key: string) =>
      value.settings?.[key] ??
      options.settings.find((item) => item.key === key)?.value;
    const mode = effective("source_selection_mode");
    const settings = options.settings
      .filter((item) => {
        if (item.eval !== group.key) return false;
        if (
          item.key === "return_limit" ||
          item.key === "rerank_excellent_score"
        )
          return mode !== "tokens";
        if (item.key === "source_token_budget") return mode === "tokens";
        if (item.key === "source_graph_budget_ratio")
          return (
            mode === "tokens" &&
            (methods
              ? methods.includes("graph")
              : effective("graph_retrieval") === true)
          );
        return true;
      })
      .sort((a, b) => {
        const order = [
          "source_selection_mode",
          "return_limit",
          "source_token_budget",
          "source_graph_budget_ratio",
        ];
        const ai = order.indexOf(a.key),
          bi = order.indexOf(b.key);
        if (ai < 0 && bi < 0) return 0;
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
      });
    const prompts = options.prompts.filter((item) => item.eval === group.key);
    const models: ("llm" | "judge")[] =
      group.key === "common"
        ? options.llm.enabled
          ? showJudge
            ? ["llm", "judge"]
            : ["llm"]
          : []
        : [];
    return { models, settings, prompts };
  };
  // 标题行上写清这组改了哪几项，不打开气泡也能看出来。
  const changedOf = (
    models: ("llm" | "judge")[],
    settings: SettingItem[],
    prompts: PromptItem[],
  ) => [
    ...models
      .filter((key) => value[key])
      .map(
        (key) =>
          `${key === "llm" ? "大模型" : "评审模型"} ${value[key]?.model ?? value[key]?.provider}`,
      ),
    ...settings
      .filter((item) => value.settings?.[item.key] !== undefined)
      .map(
        (item) =>
          `${settingLabel(item.key)} ${formatValue(value.settings![item.key])}`,
      ),
    ...prompts
      .filter((item) => value.prompts?.[item.id] !== undefined)
      .map(
        (item) =>
          `${item.label} ${value.prompts![item.id] ? `v${value.prompts![item.id]}` : "内置"}`,
      ),
  ];
  const openItems = open ? groupItems(open) : null;

  return (
    <>
      <div className="evp-groups">
        {visible.map((group) => {
          const { models, settings, prompts } = groupItems(group);
          const changed = changedOf(models, settings, prompts);
          const expanded = openGroup === group.key;
          return (
            <section
              key={group.key}
              className={`evp-group ${changed.length ? "is-changed" : ""}`}
            >
              <button
                type="button"
                className="evp-head"
                aria-expanded={expanded}
                aria-haspopup="dialog"
                ref={
                  expanded
                    ? (node: HTMLButtonElement | null) => {
                        anchor.current = node;
                      }
                    : undefined
                }
                onClick={() => setOpenGroup(expanded ? null : group.key)}
              >
                <span className="evp-caret" aria-hidden="true">
                  {expanded ? "▾" : "▸"}
                </span>
                <span className="evp-title">{group.label}</span>
                <span className="evp-summary">
                  {changed.length
                    ? `已自定义 ${changed.length} 项：${changed.join("、")}`
                    : "全部跟随系统"}
                </span>
              </button>
            </section>
          );
        })}
      </div>
      {open && openItems && (
        <div
          ref={bubble}
          popover="manual"
          role="dialog"
          aria-modal="false"
          aria-label={open.label}
          className={`anchored-popover evp-popover is-${place?.side ?? "top"}`}
          onClick={(event) => event.stopPropagation()}
          style={style}
        >
          <div className="evp-popover-head">
            <strong>{open.label}</strong>
            <button
              type="button"
              className="link-button button-sm"
              onClick={() => setOpenGroup(null)}
            >
              关闭
            </button>
          </div>
          <div className="evp-popover-body">
            {openItems.models.map((key) => (
              <ModelRow
                key={key}
                label={key === "llm" ? "大模型" : "评审模型"}
                hint={
                  key === "llm"
                    ? "改写、充分性判断、Agent 和回答都用它。"
                    : "生成评测给答案打分；不选就和回答用同一个模型。"
                }
                options={options}
                value={value[key]}
                onChange={(next) => setModel(key, next)}
              />
            ))}
            {openItems.settings.map((item) => (
              <SettingRow
                key={item.key}
                item={item}
                value={value.settings?.[item.key]}
                onChange={(next) => setSetting(item.key, next)}
              />
            ))}
            {openItems.prompts.map((item) => (
              <PromptRow
                key={item.id}
                item={item}
                value={value.prompts?.[item.id]}
                onChange={(next) => setPrompt(item.id, next)}
              />
            ))}
          </div>
          <span
            className="anchored-popover-arrow"
            style={{ left: place?.arrow ?? 0 }}
            aria-hidden="true"
          />
        </div>
      )}
    </>
  );
}

// 一行：名称 · 跟随系统（灰字显示当前系统值）/ 自定义，选自定义后出现输入框。
function Row({
  label,
  hint,
  systemText,
  custom,
  onFollow,
  onCustom,
  children,
}: {
  label: string;
  hint?: string;
  systemText: string;
  custom: boolean;
  onFollow: () => void;
  onCustom: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`evp-row ${custom ? "is-custom" : ""}`}>
      <div className="evp-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="evp-control">
        <div className="evp-switch" role="radiogroup" aria-label={label}>
          <button
            type="button"
            role="radio"
            aria-checked={!custom}
            className={!custom ? "is-selected" : ""}
            onClick={onFollow}
          >
            跟随系统
            <em>{systemText}</em>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={custom}
            className={custom ? "is-selected" : ""}
            onClick={onCustom}
          >
            自定义
          </button>
        </div>
        {custom && <div className="evp-input">{children}</div>}
      </div>
    </div>
  );
}

function SettingRow({
  item,
  value,
  onChange,
}: {
  item: SettingItem;
  value: RuntimeSettingValue | undefined;
  onChange: (next: RuntimeSettingValue | undefined) => void;
}) {
  const custom = value !== undefined;
  return (
    <Row
      label={settingLabel(item.key)}
      systemText={formatValue(item.value)}
      custom={custom}
      onFollow={() => onChange(undefined)}
      onCustom={() => onChange(item.value)}
    >
      <SettingInput
        item={item}
        value={value ?? item.value}
        onChange={onChange}
      />
    </Row>
  );
}

function SettingInput({
  item,
  value,
  onChange,
}: {
  item: RuntimeSettingItem;
  value: RuntimeSettingValue;
  onChange: (next: RuntimeSettingValue) => void;
}) {
  if (item.type === "bool") {
    return (
      <select
        className="input-sm"
        value={value ? "on" : "off"}
        onChange={(event) => onChange(event.target.value === "on")}
      >
        <option value="on">开</option>
        <option value="off">关</option>
      </select>
    );
  }
  if (item.type === "choice") {
    return (
      <select
        className="input-sm"
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      >
        {(item.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }
  return (
    <>
      <input
        className="input-sm"
        type="number"
        min={item.min}
        max={item.max}
        step={item.type === "int" ? 1 : 0.05}
        value={String(value)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (event.target.value !== "" && Number.isFinite(next))
            onChange(item.type === "int" ? Math.round(next) : next);
        }}
      />
      {item.min !== undefined && item.max !== undefined && (
        <small>
          范围 {item.min}–{item.max}
        </small>
      )}
    </>
  );
}

function PromptRow({
  item,
  value,
  onChange,
}: {
  item: PromptItem;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <Row
      label={`${item.label}提示词`}
      systemText={item.active_label}
      custom={value !== undefined}
      onFollow={() => onChange(undefined)}
      onCustom={() => onChange(item.active_version)}
    >
      <select
        className="input-sm"
        value={String(value ?? item.active_version)}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {item.versions.map((version) => (
          <option key={version.version} value={version.version}>
            {version.label}
            {version.note ? ` · ${version.note}` : ""}
          </option>
        ))}
      </select>
    </Row>
  );
}

function ModelRow({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  options: EvalParamOptions;
  value: EvalParams["llm"];
  onChange: (next: EvalParams["llm"] | undefined) => void;
}) {
  const current = options.llm.current;
  const profiles = options.llm.profiles;
  const pick = (provider: string) => ({
    provider,
    model: profiles.find((item) => item.provider === provider)?.model,
  });
  return (
    <Row
      label={label}
      hint={hint}
      systemText={`${current.provider} · ${current.model}`}
      custom={value !== undefined}
      onFollow={() => onChange(undefined)}
      onCustom={() => onChange(pick(current.provider))}
    >
      <select
        className="input-sm"
        value={value?.provider ?? current.provider}
        onChange={(event) => onChange(pick(event.target.value))}
      >
        {profiles.map((item) => (
          <option key={item.provider} value={item.provider}>
            {item.provider}
            {item.is_active ? "（当前）" : ""}
          </option>
        ))}
      </select>
      <input
        className="input-sm"
        type="text"
        value={value?.model ?? ""}
        placeholder="模型名"
        aria-label={`${label}名称`}
        onChange={(event) =>
          onChange({
            provider: value?.provider ?? current.provider,
            model: event.target.value,
          })
        }
      />
    </Row>
  );
}
