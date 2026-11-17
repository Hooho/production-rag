import type { EvalRelationTarget } from "./api";
import "./RelationEvidenceCards.css";

export function RelationEvidenceCards({
  relations,
  selected,
  onToggle,
}: {
  relations: EvalRelationTarget[];
  selected?: Set<string>;
  onToggle?: (relation: EvalRelationTarget, checked: boolean) => void;
}) {
  return (
    <div className="relation-evidence-cards">
      {relations.map((relation) => {
        const checked = selected?.has(relation.relation_id) ?? false;
        const content = (
          <span>
            <strong>
              {relation.source} → {relation.category} → {relation.target}
            </strong>
            {relation.description && (
              <span className="relation-evidence-description">
                {relation.description}
              </span>
            )}
            {relation.evidence && (
              <span className="relation-evidence-quote">
                「{relation.evidence}」
              </span>
            )}
          </span>
        );
        return onToggle ? (
          <label
            key={relation.relation_id}
            className={`relation-evidence-card${checked ? " is-selected" : ""}`}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => onToggle(relation, event.target.checked)}
            />
            {content}
          </label>
        ) : (
          <div key={relation.relation_id} className="relation-evidence-card">
            {content}
          </div>
        );
      })}
    </div>
  );
}
