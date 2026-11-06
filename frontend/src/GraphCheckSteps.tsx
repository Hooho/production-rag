import { useEffect, useLayoutEffect, useRef, useState } from "react";

// 箭头式步骤条（图谱检查的 5 步）：每步一个色块，右边箭头嵌进下一步。
// 窄屏时横向滚动：还有内容没显示的那一侧边缘显示渐变阴影；打开或切换步骤时把当前步骤滚到可见区域。
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
  const scroller = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState({ left: false, right: false });

  function measure() {
    const node = scroller.current;
    if (!node) return;
    setShadow({
      left: node.scrollLeft > 2,
      right: node.scrollLeft + node.clientWidth < node.scrollWidth - 2,
    });
  }

  useLayoutEffect(() => {
    measure();
  }, [steps]);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const item = scroller.current?.querySelector<HTMLElement>(
      `[data-step="${selected}"]`,
    );
    item?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    <div
      className={`gc-steps${shadow.left ? " has-left" : ""}${shadow.right ? " has-right" : ""}`}
    >
      <div
        className="gc-steps-scroll"
        ref={scroller}
        onScroll={measure}
        role="tablist"
      >
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
              title={item.hint}
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
