import { useEffect, useState } from "react";
import { ConfirmPopover } from "./ConfirmPopover";
import { formatShortTime } from "./format";
import { Tag } from "./Tag";
import {
  activateGraphVersion,
  noteGraphVersion,
  type GraphVersion,
} from "./api";
import { errorText } from "./Toast";

const ORIGIN_LABELS: Record<GraphVersion["origin"], string> = {
  build: "建图写入",
  retry: "补跑分片后写入",
  check: "图谱检查写入",
};

function counts(version: GraphVersion) {
  const { entity_count: entities, relation_count: relations } = version.summary;
  return entities === undefined
    ? ""
    : `${entities} 个实体 · ${relations ?? 0} 条关系`;
}

// 下拉框里的名字：有备注就显示备注（生效的后面标「生效」），没有备注按版本号、来源、时间、数量显示。
function label(version: GraphVersion) {
  const note = version.note?.trim();
  if (note) return version.active ? `${note} · 生效` : note;
  return details(version);
}

function details(version: GraphVersion) {
  return [
    `v${version.number}`,
    version.active ? "生效" : null,
    ORIGIN_LABELS[version.origin] ?? version.origin,
    formatShortTime(version.created),
    counts(version),
  ]
    .filter(Boolean)
    .join(" · ");
}

// 文档「实体关系」页签顶部的版本条：切换查看哪个版本、把版本设为生效（检索和全局图谱只用生效版本）、写备注。
export function GraphVersionBar({
  documentId,
  versions,
  shown,
  canManage,
  busy,
  onSelect,
  onChanged,
  onToast,
}: {
  documentId: string;
  versions: GraphVersion[];
  shown: GraphVersion;
  canManage: boolean;
  // 建图或写入进行中：不能切换生效版本。
  busy: boolean;
  // 传 null 表示回到默认（生效版本）。
  onSelect: (versionId: string | null) => void;
  onChanged: () => void;
  onToast: (kind: "success" | "error", message: string) => void;
}) {
  const active = versions.find((item) => item.active) ?? null;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(shown.note ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setEditing(false);
    setNote(shown.note ?? "");
  }, [shown.id, shown.note]);

  async function activate() {
    try {
      await activateGraphVersion(documentId, shown.id);
      onToast("success", `v${shown.number} 已生效，检索和全局图谱改用这个版本`);
      onSelect(null);
      onChanged();
    } catch (reason) {
      onToast("error", errorText(reason));
    }
  }

  async function saveNote() {
    setSaving(true);
    try {
      await noteGraphVersion(documentId, shown.id, note);
      setEditing(false);
      onChanged();
    } catch (reason) {
      onToast("error", errorText(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`graph-version-bar${shown.active ? "" : " is-inactive"}`}>
      <label className="graph-version-select">
        <span>图谱版本</span>
        <select
          value={shown.id}
          onChange={(event) => {
            const next = versions.find(
              (item) => item.id === event.target.value,
            );
            onSelect(next && !next.active ? next.id : null);
          }}
        >
          {versions.map((item) => (
            <option key={item.id} value={item.id} title={details(item)}>
              {label(item)}
            </option>
          ))}
        </select>
      </label>
      {shown.active ? (
        <Tag size="sm" tone="success">
          生效中
        </Tag>
      ) : (
        <>
          <Tag size="sm" tone="warning">
            未生效
          </Tag>
          <span className="graph-note">
            正在查看 v{shown.number}
            {active ? `，检索和全局图谱用的是 v${active.number}` : ""}
          </span>
          {canManage && (
            <ConfirmPopover
              message={
                <>
                  把 v{shown.number} 设为生效？检索和全局图谱会改用这个版本。
                  <br />v{shown.number}：{counts(shown) || "数量未记录"}
                  {active && (
                    <>
                      <br />
                      当前生效 v{active.number}：
                      {counts(active) || "数量未记录"}
                    </>
                  )}
                </>
              }
              confirmText="设为生效"
              disabled={busy}
              onConfirm={activate}
            >
              <button
                type="button"
                className="primary-button button-sm"
                disabled={busy}
                title={busy ? "建图或写入进行中，完成后再切换" : undefined}
              >
                设为生效
              </button>
            </ConfirmPopover>
          )}
          <button
            type="button"
            className="link-button"
            onClick={() => onSelect(null)}
          >
            回到生效版本
          </button>
        </>
      )}
      {shown.summary.changes && (
        <span className="graph-note">{shown.summary.changes}</span>
      )}
      {editing ? (
        <span className="graph-version-note">
          <input
            value={note}
            maxLength={500}
            placeholder="这个版本改了什么、为什么"
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            className="secondary-button button-sm"
            disabled={saving}
            onClick={() => void saveNote()}
          >
            保存
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setEditing(false)}
          >
            取消
          </button>
        </span>
      ) : (
        <span className="graph-version-note">
          {shown.note && <span>备注：{shown.note}</span>}
          {canManage && (
            <button
              type="button"
              className="link-button"
              onClick={() => setEditing(true)}
            >
              {shown.note ? "改备注" : "加备注"}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
