import type { GraphRelationRow } from "./api";

export function matchesEntityName(name: string, query: string) {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .includes(query.normalize("NFKC").trim().toLowerCase());
}

export function filterRelatedEntities(
  rows: GraphRelationRow[],
  entityId: string,
  query: string,
) {
  return rows.filter((row) =>
    matchesEntityName(
      row.source_id === entityId ? row.target_entity : row.source_entity,
      query,
    ),
  );
}
