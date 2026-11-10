import type { ActionNotice } from "./action-queue";

export type NoticeSnapshot = Record<string, Pick<ActionNotice, "count" | "priority">>;
export const snapshotOf = (items: ActionNotice[]): NoticeSnapshot => Object.fromEntries(items.map((i) => [i.id, { count: i.count, priority: i.priority }]));

/** First load establishes a baseline. Only arrivals, increases or escalations deserve another interruption. */
export function newActionNotices(previous: NoticeSnapshot | null, current: ActionNotice[]): ActionNotice[] {
  if (previous === null) return [];
  const rank = { urgent: 0, attention: 1, info: 2 };
  return current
    .filter((item) => {
      const old = previous[item.id];
      return item.count > 0 && (!old || item.count > old.count || rank[item.priority] < rank[old.priority]);
    })
    .sort((a, b) => rank[a.priority] - rank[b.priority]);
}
