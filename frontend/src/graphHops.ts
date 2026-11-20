import type { GraphNetwork } from "./api";

export type GraphHopInfo = {
  rootId: string;
  rootName: string;
  distances: Map<string, number>;
};

// Hop counts describe the currently visible graph, ignoring arrow direction.
export function graphHops(
  network: GraphNetwork | undefined,
  rootId: string | null,
): GraphHopInfo | null {
  const root = network?.nodes.find((node) => node.id === rootId);
  if (!network || !root) return null;
  const neighbors = new Map(
    network.nodes.map((node) => [node.id, new Set<string>()]),
  );
  for (const edge of network.edges) {
    if (!neighbors.has(edge.source) || !neighbors.has(edge.target)) continue;
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
  }
  const distances = new Map([[root.id, 0]]);
  const queue = [root.id];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const next of neighbors.get(current)!) {
      if (distances.has(next)) continue;
      distances.set(next, distances.get(current)! + 1);
      queue.push(next);
    }
  }
  return { rootId: root.id, rootName: root.name, distances };
}
