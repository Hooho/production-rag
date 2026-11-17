import { errorText, useToast } from "./Toast";
import { useEffect, useState } from "react";
import { listEvalTargetChunks, type EvalScoringTarget } from "./api";
import { RelationEvidenceList } from "./RelationEvidenceCards";
import type { EvalRelationTarget } from "./api";
import { EvidenceTargetTags, type EvidenceTarget } from "./EvidenceTargetTags";
import "./ScoringItems.css";

export function ScoringItems({
  items,
}: {
  items: {
    label?: string;
    targets?: EvidenceTarget[];
    relations?: EvalRelationTarget[];
  }[];
}) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<EvalScoringTarget[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (items.some((item) => item.relations?.length)) {
      listEvalTargetChunks()
        .then((data) => {
          if (!cancelled) setCatalog(data.items);
        })
        .catch((reason) => {
          if (!cancelled) toast("error", errorText(reason));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [items, toast]);
  return (
    <div className="ag-evidence-list ag-scoring-items">
      {items.map((item, index) => (
        <div className="ag-evidence" key={index}>
          <p>
            <strong>
              计分项 {index + 1}：{item.label || `要点 ${index + 1}`}
            </strong>
          </p>
          <EvidenceTargetTags targets={item.targets ?? []} number={index + 1} />
          <RelationEvidenceList
            relations={item.relations ?? []}
            catalog={catalog}
          />
        </div>
      ))}
    </div>
  );
}
