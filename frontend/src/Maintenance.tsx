import { ModelSettings } from "./Settings";
import SystemSettings from "./SystemSettings";
import Prompts from "./Prompts";
import Security from "./Security";
import "./Maintenance.css";

// 系统管理（只有管理员）：维护系统怎么运行的地方，和日常的问答、知识库、评测分开。
// 模型配置、RAG 配置原来在「设置」页，提示词、安全样本原来各占一个导航；都决定问答怎么运行，放在一起，用标签切换。
// 「设置」页留系统配置（时区、配色这类和问答无关的）、用户、部门、数据权限；普通用户在那里查看当前模型配置。
// 地址是 /maintenance/<标签>，提示词详情是 /maintenance/prompts/<id>；旧地址 /prompts、/security 仍然能打开。
export type MaintenanceTab = "model" | "rag" | "prompts" | "security";
type ShowToast = (kind: "success" | "error", message: string) => void;

export const MAINTENANCE_TABS: { id: MaintenanceTab; label: string }[] = [
  { id: "model", label: "模型配置" },
  { id: "rag", label: "RAG 配置" },
  { id: "prompts", label: "提示词" },
  { id: "security", label: "安全样本" },
];

export default function Maintenance({ tab, promptId, onNavigate, onToast }: { tab: MaintenanceTab; promptId: string | null; onNavigate: (path: string) => void; onToast: ShowToast }) {
  return <div className={`mt-page is-${tab}`}>
    <header className="topbar"><div><h1>系统管理</h1></div></header>
    <div className="document-detail-tabs mt-tabs" role="tablist" aria-label="系统管理">
      {MAINTENANCE_TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === tab} className={item.id === tab ? "active" : ""} onClick={() => onNavigate(`/maintenance/${item.id}`)}>{item.label}</button>)}
    </div>
    <div className="mt-body">
      {tab === "model" && <ModelSettings isAdmin onToast={onToast} />}
      {tab === "rag" && <SystemSettings key="rag" page="rag" onToast={onToast} />}
      {tab === "prompts" && <Prompts promptId={promptId} onNavigate={onNavigate} onToast={onToast} />}
      {tab === "security" && <Security onNavigate={onNavigate} onToast={onToast} />}
    </div>
  </div>;
}
