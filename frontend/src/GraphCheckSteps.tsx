// 箭头式步骤条（图谱检查的 5 步）：每步一个色块，右边箭头嵌进下一步。
// 5 步始终一行、平分宽度，不滚动；文字放不下时省略号截断，悬停看完整标题、状态和说明。
export type CheckStepState =
  | "current" // 当前步骤（未开始 / 待处理 / 检查中）：实心蓝
  | "done" // 已完成：浅绿
  | "skipped" // 已跳过：浅灰
  | "recheck" // 图已变化，需要重新检查：浅橙
  | "failed" // 有失败：浅红
  | "waiting" // 还没轮到：浅灰
  | "locked"; // 暂未开放：浅灰，不能点

export type CheckStep = {
  key: number;
  title: string;
  // 第二行：状态说明
  text: string;
  state: CheckStepState;
  // 检查进行中时，标题后面显示已用时间
  elapsed?: string;
  // 悬停说明（这一步查什么）
  hint?: string;
};

export function GraphCheckSteps({
  steps,
  selected,
  onSelect,
}: {
  steps: CheckStep[];
  selected: number;
  onSelect: (key: number) => void;
}) {
  return (
    <div className="gc-steps">
      <div className="gc-steps-scroll" role="tablist">
        {steps.map((item) => {
          const locked = item.state === "locked";
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              data-step={item.key}
              aria-selected={selected === item.key}
              disabled={locked}
              title={[`${item.key}. ${item.title}`, item.text, item.hint]
                .filter(Boolean)
                .join("\n")}
              className={`gc-step is-${item.state}${selected === item.key ? " is-selected" : ""}`}
              onClick={() => onSelect(item.key)}
            >
              <strong>
                {item.key}. {item.title}
                {item.elapsed && <em>{item.elapsed}</em>}
              </strong>
              <small>{item.text}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 竖直步骤条：用在某一步里面的小步骤（例如合并这一步的 找出可疑项 → AI 判断 → …），放在内容左边。
// 已完成：浅绿圆圈打勾、下面的连线是绿色；当前：实心蓝圆圈；没轮到：灰圆圈；失败：红圆圈。
export function VerticalSteps({
  steps,
  selected,
  onSelect,
}: {
  steps: CheckStep[];
  selected: number;
  onSelect: (key: number) => void;
}) {
  return (
    <ol className="gv-steps" role="tablist" aria-orientation="vertical">
      {steps.map((item) => (
        <li
          key={item.key}
          className={`gv-step is-${item.state}${selected === item.key ? " is-selected" : ""}`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={selected === item.key}
            disabled={item.state === "locked"}
            title={item.hint}
            onClick={() => onSelect(item.key)}
          >
            <span className="gv-dot">
              {item.state === "done"
                ? "✓"
                : item.state === "failed"
                  ? "!"
                  : item.key}
            </span>
            <span className="gv-text">
              <strong>
                {item.title}
                {item.elapsed && <em>{item.elapsed}</em>}
              </strong>
              <small>{item.text}</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// 横向步骤条（只看不点）：圆圈 + 标题 + 副标题，标题右边一条连线接到下一步，下面一行说明。
// 已完成：白底蓝圈打勾、后面的连线变蓝；进行中：浅蓝底蓝圈数字，说明文字加深；等待：灰圈数字；失败：红圈 ×。
export type HorizontalStepStatus = "finish" | "process" | "wait" | "error";
export type HorizontalStep = {
  key: string;
  title: string;
  subtitle?: string;
  description?: string;
  status: HorizontalStepStatus;
};

export function HorizontalSteps({ steps }: { steps: HorizontalStep[] }) {
  return (
    <ol className="hsteps">
      {steps.map((item, index) => (
        <li key={item.key} className={`hstep is-${item.status}`}>
          <span className="hstep-icon" aria-hidden="true">
            {item.status === "finish" ? (
              <svg viewBox="0 0 16 16" width="16" height="16">
                <path
                  d="M3 8.5l3.2 3.2L13 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : item.status === "error" ? (
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              index + 1
            )}
          </span>
          <span className="hstep-content">
            <span className="hstep-head">
              <strong>{item.title}</strong>
              {item.subtitle && <em>{item.subtitle}</em>}
              {index < steps.length - 1 && <i className="hstep-line" />}
            </span>
            {item.description && <small>{item.description}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}
