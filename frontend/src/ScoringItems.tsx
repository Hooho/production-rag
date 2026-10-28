import { EvidenceTargetTags, type EvidenceTarget } from "./EvidenceTargetTags";

export function ScoringItems({
  items,
}: {
  items: { label?: string; targets?: EvidenceTarget[] }[];
}) {
  return (
    <div className="ag-evidence-list">
      {items.map((item, index) => (
        <div className="ag-evidence" key={index}>
          <p>
            <strong>
              计分项 {index + 1}：{item.label || `要点 ${index + 1}`}
            </strong>
          </p>
          <EvidenceTargetTags targets={item.targets ?? []} number={index + 1} />
        </div>
      ))}
    </div>
  );
}
