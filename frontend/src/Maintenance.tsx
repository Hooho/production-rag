import "./Maintenance.css";

// 系统维护：管理员维护系统行为的地方，和日常的问答、知识库、评测分开。
// 目前两块：提示词（线上问答和文档导入发给大模型的提示词）、安全样本（输入安全检查的攻击样本库）。
// 每块是一个标签，地址分别是 /maintenance/prompts 和 /maintenance/security；旧地址 /prompts、/security 仍然能打开。
export type MaintenanceTab = "prompts" | "security";

const TABS: { id: MaintenanceTab; label: string; note: string; path: string }[] = [
  { id: "prompts", label: "提示词", note: "发给大模型的提示词 · 版本和回滚", path: "/maintenance/prompts" },
  { id: "security", label: "安全样本", note: "输入安全检查 · 攻击样本库", path: "/maintenance/security" },
];

export function MaintenanceHeader({ active, onNavigate, children }: { active: MaintenanceTab; onNavigate: (path: string) => void; children: React.ReactNode }) {
  return <header className="topbar mt-topbar">
    <div>
      <h1>系统维护</h1>
      <div className="mt-tabs" role="tablist" aria-label="系统维护">
        {TABS.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={tab.id === active} className={tab.id === active ? "is-active" : ""} onClick={() => onNavigate(tab.path)}>
          {tab.label}<small>{tab.note}</small>
        </button>)}
      </div>
      {children}
    </div>
  </header>;
}
