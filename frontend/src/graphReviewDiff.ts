// 第 4 步「确认」：把现在要写入的合并和上次已写入的合并逐条对比。
// 按实体是否重叠来对应，而不是要求实体完全相同：
// 扩大、缩小、几个接成一个、一个断成几个，都算同一条结果的变化，不再显示成「撤掉 + 新增」。

export type Naming = { name: string; type: string };

export type PlanChange =
  | { kind: "new" } // 和上次写入的都不重叠
  | { kind: "same" } // 实体完全一样
  | { kind: "grow"; added: string[] } // 只多了实体
  | { kind: "shrink"; removed: string[] } // 只少了实体，少的那些拆出来
  | { kind: "adjust"; added: string[]; removed: string[] } // 同一条结果有增有减
  | { kind: "join"; sources: string[][]; added: string[] } // 由几条已写入的结果接成
  | { kind: "split"; source: string[] }; // 从一条已写入的结果断出来

export type PlanDiff = {
  change: PlanChange;
  // 实体对应上一条旧结果、而最终名字或类型变了时才有。
  rename?: { from: Naming; to: Naming };
};

type NewGroup = { entityIds: string[]; naming?: Naming };
type OldGroup = Naming & { ids: string[] };

export function diffPlan<T extends OldGroup>(groups: NewGroup[], applied: T[]) {
  const overlaps = (a: string[], b: string[]) => a.some((id) => b.includes(id));
  const sourcesOf = groups.map((group) =>
    applied.filter((old) => overlaps(old.ids, group.entityIds)),
  );
  const diffs: PlanDiff[] = groups.map((group, index) => {
    const sources = sourcesOf[index];
    const ids = group.entityIds;
    if (sources.length === 0) return { change: { kind: "new" } };
    if (sources.length > 1) {
      const known = sources.flatMap((old) => old.ids);
      return {
        change: {
          kind: "join",
          sources: sources.map((old) => old.ids),
          added: ids.filter((id) => !known.includes(id)),
        },
      };
    }
    const source = sources[0];
    const siblings = groups.filter((other) =>
      overlaps(other.entityIds, source.ids),
    );
    if (siblings.length > 1)
      return { change: { kind: "split", source: source.ids } };
    const added = ids.filter((id) => !source.ids.includes(id));
    const removed = source.ids.filter((id) => !ids.includes(id));
    const change: PlanChange =
      added.length && removed.length
        ? { kind: "adjust", added, removed }
        : added.length
          ? { kind: "grow", added }
          : removed.length
            ? { kind: "shrink", removed }
            : { kind: "same" };
    const to = group.naming;
    const renamed = to && (to.name !== source.name || to.type !== source.type);
    return renamed
      ? {
          change,
          rename: { from: { name: source.name, type: source.type }, to },
        }
      : { change };
  });
  // 和现在任何一条都不重叠的旧结果，写入后整条拆开。
  const dropped = applied.filter(
    (old) => !groups.some((group) => overlaps(old.ids, group.entityIds)),
  );
  return { diffs, dropped };
}
