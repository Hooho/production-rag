import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { getOverview, type Overview as OverviewData, type OverviewDay } from "./api";
import { formatDuration } from "./format";
import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";
import "./Overview.css";

// 运行概览：近 7 / 30 / 90 天线上问答的量、失败、拒答、耗时、Token 和反馈。数据来自问答记录、失败记录和反馈三张表，
// 看的是按天的趋势；单条问答怎么处理的，到知识问答的处理过程或知识巡检里看。

const RANGES = [7, 30, 90];

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function count(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return value.toLocaleString("zh-CN");
}

function shortDate(date: string) {
  return date.slice(5).replace("-", "/");
}

export default function Overview() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    getOverview(days).then(setData).catch((reason: Error) => setError(reason.message));
  }, [days]);
  const totals = data?.totals;
  return <div className="ov-page">
    <header className="topbar ov-topbar">
      <div>
        <h1>运行概览</h1>
        <p className="ov-subtitle">线上问答按天的趋势：用了多少、失败多少、答不上来多少、多快、花了多少 Token、用户满不满意。{data && `日期按 ${data.timezone} 计算。`}</p>
      </div>
      <div className="ov-range" role="group" aria-label="时间范围">
        {RANGES.map((value) => <button key={value} type="button" className={value === days ? "is-selected" : ""} aria-pressed={value === days} onClick={() => setDays(value)}>近 {value} 天</button>)}
      </div>
    </header>
    {error && <div className="field-error">{error}</div>}
    {!data && !error && <LoadingSkeleton label="正在加载运行概览"><div className="ov-tiles">{RANGES.concat(RANGES).map((item, index) => <SkeletonBlock key={index} className="ov-skeleton-tile" />)}</div><SkeletonBlock className="ov-skeleton-chart" /></LoadingSkeleton>}
    {data && totals && <>
      <section className="ov-tiles">
        <Tile label="提问次数" value={count(totals.requests)} note={`成功 ${count(totals.runs)}，失败 ${count(totals.errors)}`} />
        <Tile label="失败率" value={percent(totals.error_rate)} note="处理出错、没有返回回答的比例" />
        <Tile label="拒答率" value={percent(totals.refusal_rate)} note={`知识问答 ${count(totals.knowledge)} 次，回答资料不足 ${count(totals.refused)} 次`} />
        <Tile label="耗时 P95" value={formatDuration(totals.p95_ms)} note={`95% 的问答在这个时间内完成；P50（一半的问答）${formatDuration(totals.p50_ms)}`} />
        <Tile label="点踩率" value={percent(totals.down_rate)} note={`收到反馈 ${count(totals.feedback)} 条：赞 ${count(totals.up)}，踩 ${count(totals.down)}`} />
        <Tile label="回答 Token" value={count(totals.tokens.total)} note={totals.avg_tokens ? `平均每次 ${count(totals.avg_tokens)}（输入 ${count(totals.tokens.input)}，输出 ${count(totals.tokens.output)}）` : "这段时间没有记录到 Token 用量"} />
      </section>

      <section className="ov-charts">
        <DailyChart title="每天提问次数" days={data.daily} kind="bar" value={(day) => day.requests} format={count} />
        <DailyChart title="每天失败次数" days={data.daily} kind="bar" value={(day) => day.errors} format={count} detail={(day) => `失败率 ${percent(day.error_rate)}`} />
        <DailyChart title="每天拒答率（知识问答）" days={data.daily} kind="line" value={(day) => day.refusal_rate} format={percent} detail={(day) => `${day.refused} / ${day.knowledge} 次`} />
        <DailyChart title="每天 P95 耗时" days={data.daily} kind="line" value={(day) => day.p95_ms} format={formatDuration} detail={(day) => `P50 ${formatDuration(day.p50_ms)}`} />
        <DailyChart title="每天回答 Token" days={data.daily} kind="bar" value={(day) => day.tokens} format={count} />
        <DailyChart title="每天点踩数" days={data.daily} kind="bar" value={(day) => day.down} format={count} detail={(day) => `点赞 ${day.up}`} />
      </section>

      <section className="ov-panels">
        <Panel title="各阶段耗时" note="一次问答经过的各个步骤，按处理顺序。P95 最长的那一步通常就是要优化的地方。">
          {data.stages.length === 0 ? <Empty /> : <table className="ov-table">
            <thead><tr><th>阶段</th><th className="num">次数</th><th className="num">P50</th><th className="num">P95</th><th aria-hidden="true" /></tr></thead>
            <tbody>{data.stages.map((stage) => {
              const max = Math.max(...data.stages.map((item) => item.p95_ms ?? 0)) || 1;
              return <tr key={stage.stage}><td>{stage.label}</td><td className="num">{count(stage.count)}</td><td className="num">{formatDuration(stage.p50_ms)}</td><td className="num">{formatDuration(stage.p95_ms)}</td>
                <td className="ov-bar-cell"><span className="ov-inline-bar" style={{ width: `${((stage.p95_ms ?? 0) / max) * 100}%` }} /></td></tr>;
            })}</tbody>
          </table>}
        </Panel>
        <Panel title="问题分流" note="每个问题被分到哪条处理路线。">
          <Breakdown items={data.routes.map((item) => ({ key: item.route, label: item.label, count: item.count }))} />
        </Panel>
        <Panel title="意图识别" note="每个问题依次尝试：规则 → 本地小模型 → 大模型，前一环认不出才交给下一环；大模型出错或没启用时由规则兜底。命中率 = 这一环命中 / 到达这一环的次数；占比 = 这一环命中 / 全部识别次数。">
          {data.intent.runs === 0 ? <Empty /> : <>
            <table className="ov-table">
              <thead><tr><th>环节</th><th className="num">到达</th><th className="num">命中</th><th className="num">命中率</th><th className="num">占比</th><th aria-hidden="true" /></tr></thead>
              <tbody>{data.intent.stages.map((stage) => <tr key={stage.stage}>
                <td>{stage.label}</td><td className="num">{count(stage.reached)}</td><td className="num">{count(stage.accepted)}</td>
                <td className="num">{stage.stage === "fallback" ? "—" : percent(stage.hit_rate)}</td><td className="num">{percent(stage.share)}</td>
                <td className="ov-bar-cell"><span className="ov-inline-bar" style={{ width: `${(stage.share ?? 0) * 100}%` }} /></td>
              </tr>)}</tbody>
            </table>
            {data.intent.fallback_causes.length > 0 && <p className="ov-codes">走到规则兜底的原因：{data.intent.fallback_causes.map((item) => `${item.label} ${item.count} 次`).join("，")}</p>}
            {data.intent.stages.find((stage) => stage.stage === "small_model")?.reached === 0 && <p className="ov-codes">本地小模型没有到达过：「系统管理 › RAG 配置」里没有开启本地小模型，规则认不出的问题直接交给大模型。</p>}
          </>}
        </Panel>
        <Panel title="检索" note="只统计走了知识检索的问答（含拒答）。">
          {data.retrieval.runs === 0 ? <Empty /> : <dl className="ov-facts">
            <div><dt>检索次数</dt><dd>{count(data.retrieval.runs)}</dd></div>
            <div><dt>一段资料都没交给模型</dt><dd>{count(data.retrieval.returned_zero)} 次（{percent(data.retrieval.returned_zero_rate)}）</dd></div>
            <div><dt>最相关资料得分（中位数）</dt><dd>{data.retrieval.top_score_p50 === null ? "—" : data.retrieval.top_score_p50.toFixed(2)}</dd></div>
            <div><dt>最高分低于相关度阈值 {data.retrieval.min_score.toFixed(2)}</dt><dd>{count(data.retrieval.below_threshold)} 次</dd></div>
          </dl>}
        </Panel>
        <Panel title="拒答原因" note="知识问答里回答「资料不足」或被引用检查拦截的原因，按处理顺序。没检索到资料、充分性判断资料不足是知识缺口，该补文档；相关度都低于阈值，看阈值是否太严；后三类是回答被引用检查拦截，看模型和回答提示词。">
          <Breakdown items={data.refusals.reasons.map((item) => ({ key: item.reason, label: item.label, count: item.count }))} emptyText="这段时间没有拒答" />
          {data.refusals.partial > 0 && <p className="ov-codes">另有 {count(data.refusals.partial)} 次没有拒答，但充分性判断认为资料只能回答一部分，也是知识缺口。</p>}
        </Panel>
        <Panel title="安全检查" note="问题进模型前、来源交给模型前、回答返回前各检查一次。">
          <dl className="ov-facts">
            <div><dt>问题被拦截</dt><dd>{count(data.security.blocked)} 次（{percent(data.security.blocked_rate)}）</dd></div>
            <div><dt>来源里清理掉注入句子</dt><dd>{count(data.security.redacted_runs)} 次问答，共 {count(data.security.redacted)} 句</dd></div>
            <div><dt>回答里处理了不安全内容</dt><dd>{count(data.security.output_runs)} 次</dd></div>
            <div><dt>和攻击样本相似</dt><dd>{data.security.vector.checked === 0 ? "没有比对过" : `拦截 ${count(data.security.vector.blocked)} 次，只记录 ${count(data.security.vector.logged)} 次（比对 ${count(data.security.vector.checked)} 次）`}</dd></div>
          </dl>
          {data.security.rules.length > 0 && <><h3 className="ov-sub">拦截命中的规则</h3><Breakdown items={data.security.rules} /></>}
          {data.security.issues.length > 0 && <><h3 className="ov-sub">回答检查处理的问题</h3><Breakdown items={data.security.issues} /></>}
        </Panel>
        <Panel title="失败发生在" note="失败前最后完成的一步，失败出在它之后的那一步；具体错误到知识巡检的「系统问题」里看。">
          {data.errors.stages.length === 0 ? <Empty text="这段时间没有失败" /> : <>
            <Breakdown items={data.errors.stages.map((item) => ({ key: item.stage, label: `${item.label}之后`, count: item.count }))} />
            <p className="ov-codes">状态码：{data.errors.codes.map((item) => `${item.code} × ${item.count}`).join("，")}</p>
          </>}
        </Panel>
        <Panel title="点踩原因" note="用户点踩时选的原因。">
          <Breakdown items={data.feedback_reasons.map((item) => ({ key: item.reason, label: item.label, count: item.count }))} emptyText="这段时间没有点踩" />
        </Panel>
      </section>
      <p className="ov-footnote">Token 只统计生成回答这一步（意图识别、问题改写、充分性判断、分片说明用的大模型调用没有算进来）。提问次数 = 成功的问答 + 失败的问答。</p>
    </>}
  </div>;
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="ov-tile"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function Panel({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <div className="ov-panel"><h2>{title}</h2><p>{note}</p>{children}</div>;
}

function Empty({ text = "这段时间没有数据" }: { text?: string }) {
  return <div className="ov-empty">{text}</div>;
}

// 横向条形：每项一行，条长按最大值的比例，右侧写次数和占比。
function Breakdown({ items, emptyText }: { items: { key: string; label: string; count: number }[]; emptyText?: string }) {
  if (items.length === 0) return <Empty text={emptyText} />;
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const max = Math.max(...items.map((item) => item.count));
  return <ul className="ov-breakdown">{items.map((item) => <li key={item.key}>
    <span className="ov-breakdown-label">{item.label}</span>
    <span className="ov-breakdown-track"><span className="ov-inline-bar" style={{ width: `${(item.count / max) * 100}%` }} /></span>
    <span className="ov-breakdown-value">{count(item.count)}<small>{percent(item.count / total)}</small></span>
  </li>)}</ul>;
}

// 按天的单指标趋势图：一个纵轴，柱状（次数类）或折线（比例、耗时）。悬停或用左右方向键选中某一天，提示框写出当天的值。
function DailyChart({ title, days, kind, value, format, detail }: { title: string; days: OverviewDay[]; kind: "bar" | "line"; value: (day: OverviewDay) => number | null; format: (value: number | null) => string; detail?: (day: OverviewDay) => string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(480);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(260, Math.round(entries[0].contentRect.width))));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  const height = 180;
  const margin = { top: 12, right: 8, bottom: 24, left: 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = days.map(value);
  const maxValue = Math.max(0, ...values.map((item) => item ?? 0));
  const top = maxValue > 0 ? niceCeil(maxValue) : 1;
  const step = plotWidth / days.length;
  const x = (index: number) => margin.left + step * index + step / 2;
  const y = (item: number) => margin.top + (1 - item / top) * plotHeight;
  const ticks = top === 1 && kind === "bar" ? [0, top] : [0, top / 2, top];
  // 横轴最多标 7 个日期，天数多时隔几天标一个。
  const labelEvery = Math.ceil(days.length / 7);
  let path = "";
  values.forEach((item, index) => {
    if (item === null) return;
    path += `${path && values[index - 1] !== null ? "L" : "M"}${x(index).toFixed(1)},${y(item).toFixed(1)}`;
  });
  function pick(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relative = ((event.clientX - rect.left) / rect.width) * width;
    setHover(Math.min(days.length - 1, Math.max(0, Math.floor((relative - margin.left) / step))));
  }
  function onKey(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (event.key === "ArrowRight") setHover((current) => Math.min(days.length - 1, (current ?? -1) + 1));
    if (event.key === "ArrowLeft") setHover((current) => Math.max(0, (current ?? days.length) - 1));
  }
  const hovered = hover === null ? null : days[hover];
  const barWidth = Math.max(2, Math.min(28, step - 2));
  const empty = values.every((item) => item === null || item === 0);
  return <div className="ov-chart">
    <h3>{title}</h3>
    <div className="ov-chart-frame" ref={frameRef}>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}，${days[0].date} 到 ${days[days.length - 1].date}`} tabIndex={0} onPointerMove={pick} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
        {ticks.map((tick) => <g key={tick}><line className="ov-grid" x1={margin.left} x2={margin.left + plotWidth} y1={y(tick)} y2={y(tick)} /><text className="ov-axis" x={margin.left - 6} y={y(tick) + 4} textAnchor="end">{format(tick)}</text></g>)}
        {days.map((day, index) => index % labelEvery === 0 || index === days.length - 1 ? <text key={day.date} className="ov-axis" x={x(index)} y={height - 6} textAnchor="middle">{shortDate(day.date)}</text> : null)}
        {hovered && <rect className="ov-hover-band" x={margin.left + step * hover!} y={margin.top} width={step} height={plotHeight} />}
        {kind === "bar" ? values.map((item, index) => item ? <path key={index} className="ov-bar" d={barPath(x(index) - barWidth / 2, y(item), barWidth, margin.top + plotHeight - y(item))} /> : null)
          : <><path className="ov-line" d={path} />{values.map((item, index) => item === null ? null : <circle key={index} className={`ov-dot ${hover === index ? "is-active" : ""}`} cx={x(index)} cy={y(item)} r={hover === index ? 4.5 : days.length > 31 ? 0 : 2.5} />)}</>}
      </svg>
      {empty && <div className="ov-chart-empty">这段时间没有数据</div>}
      {hovered && <div className={`ov-tooltip ${hover! > days.length / 2 ? "is-left" : ""}`} style={{ left: `${(x(hover!) / width) * 100}%` }}>
        <div className="ov-tooltip-title">{hovered.date}</div>
        <strong>{format(values[hover!])}</strong>
        {detail && <span>{detail(hovered)}</span>}
      </div>}
    </div>
  </div>;
}

// 纵轴上限取「好读」的数：1、2、4、6、8 乘 10 的幂（中间刻度是它的一半，也是整数）；比例类（不超过 1）按 10% 取整。
function niceCeil(value: number) {
  if (value <= 1 && value > 0 && value !== Math.round(value)) return Math.min(1, Math.ceil(value * 10) / 10);
  const power = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 4, 6, 8, 10]) {
    if (factor * power >= value) return factor * power;
  }
  return 10 * power;
}

// 柱子：顶部两个角圆 4px，底部贴着横轴是直角。
function barPath(left: number, top: number, width: number, height: number) {
  const radius = Math.min(4, width / 2, height);
  return `M${left},${top + height}V${top + radius}Q${left},${top} ${left + radius},${top}H${left + width - radius}Q${left + width},${top} ${left + width},${top + radius}V${top + height}Z`;
}
