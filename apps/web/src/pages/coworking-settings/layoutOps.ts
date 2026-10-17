import { PLAN_LIMITS, type CwCategory, type FloorLayout, type PlanArea, type PlanItem, type PlanLabel } from "@gcf/shared";
import { PLAN_WIDTH } from "@gcf/floorplan";

/**
 * Pure editing operations of the floor plan editor. Geometry is computed in SVG units (PLAN_WIDTH wide, `height`
 * high, the same space FloorPlanView draws in) and stored as fractions of the plan, as the layout schema requires.
 */

export type Selection = { kind: "items"; ids: string[] } | { kind: "label"; index: number } | { kind: "area"; index: number } | null;
export type Point = { x: number; y: number };

/** Smallest width or height of a placed resource, as a fraction of the plan (strictly positive in the schema). */
const MIN_EXTENT = 0.004;
/** Font sizes of the labels in SVG units, as drawn by FloorPlanView. */
export const LABEL_FONT = { s: 14, m: 20, l: 30 } as const;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** Fractions are kept to 5 decimals: far below a pixel, and the stored JSON stays compact. */
const round = (v: number) => Math.round(v * 100_000) / 100_000;
const fraction = (v: number) => round(clamp(v, 0, 1));
const extent = (v: number) => round(clamp(v, MIN_EXTENT, 1));

export const snapTo = (value: number, grid: number) => Math.round(value / grid) * grid;
export const normaliseRotation = (degrees: number) => ((Math.round(degrees) % 360) + 360) % 360;

/** Default footprint of a newly placed resource, in SVG units, by category. */
const DEFAULT_SIZE: Record<CwCategory, { w: number; h: number }> = {
  hot_desk: { w: 50, h: 34 },
  dedicated_desk: { w: 56, h: 38 },
  private_office: { w: 140, h: 100 },
  meeting_room: { w: 150, h: 100 },
  phone_booth: { w: 40, h: 40 },
  event_space: { w: 220, h: 150 },
};

export function defaultSize(category: CwCategory | undefined, height: number): { w: number; h: number } {
  const size = DEFAULT_SIZE[category ?? "hot_desk"];
  return { w: extent(size.w / PLAN_WIDTH), h: extent(size.h / height) };
}

function rotate(p: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
}

/** Item geometry in SVG units. */
export function itemBox(item: PlanItem, height: number) {
  return { cx: item.x * PLAN_WIDTH, cy: item.y * height, w: item.w * PLAN_WIDTH, h: item.h * height };
}

/** Topmost placed resource under a point, taking its rotation and shape into account. */
export function hitItem(layout: FloorLayout, height: number, p: Point): PlanItem | null {
  for (let i = layout.items.length - 1; i >= 0; i -= 1) {
    const item = layout.items[i]!;
    const { cx, cy, w, h } = itemBox(item, height);
    const local = rotate({ x: p.x - cx, y: p.y - cy }, -item.rotation);
    const inside =
      item.shape === "ellipse" ? (local.x / (w / 2)) ** 2 + (local.y / (h / 2)) ** 2 <= 1 : Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= h / 2;
    if (inside) return item;
  }
  return null;
}

/** Approximate box of a label, centred on its anchor like the SVG text. */
export function labelBox(label: PlanLabel, height: number) {
  const size = LABEL_FONT[label.size];
  const w = Math.max(size, label.text.trim().length * size * 0.6);
  const h = size * 1.3;
  return { x: label.x * PLAN_WIDTH - w / 2, y: label.y * height - h / 2, w, h };
}

export function hitLabel(layout: FloorLayout, height: number, p: Point): number | null {
  for (let i = layout.labels.length - 1; i >= 0; i -= 1) {
    const b = labelBox(layout.labels[i]!, height);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return i;
  }
  return null;
}

export function areaPoints(area: PlanArea, height: number): Point[] {
  return area.points.map(([x, y]) => ({ x: x * PLAN_WIDTH, y: y * height }));
}

function insidePolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function hitArea(layout: FloorLayout, height: number, p: Point): number | null {
  for (let i = layout.areas.length - 1; i >= 0; i -= 1) {
    if (insidePolygon(p, areaPoints(layout.areas[i]!, height))) return i;
  }
  return null;
}

/** Places a resource centred on a point (SVG units), or moves it there when it is already placed. */
export function placeItem(layout: FloorLayout, height: number, resourceId: string, at: Point, size: { w: number; h: number }): FloorLayout {
  const item: PlanItem = { resourceId, x: fraction(at.x / PLAN_WIDTH), y: fraction(at.y / height), w: size.w, h: size.h, rotation: 0, shape: "rect" };
  return { ...layout, items: [...layout.items.filter((i) => i.resourceId !== resourceId), item] };
}

/**
 * A straight row of resources centred on a point, with a gap between them (SVG units). The row shrinks to fit the
 * plan when it would be wider (or taller) than 95 % of it.
 */
export function placeRow(
  layout: FloorLayout,
  height: number,
  resourceIds: string[],
  centre: Point,
  size: { w: number; h: number },
  direction: "horizontal" | "vertical",
  gap: number,
): FloorLayout {
  const horizontal = direction === "horizontal";
  const span = horizontal ? PLAN_WIDTH : height;
  let step = horizontal ? size.w * PLAN_WIDTH : size.h * height;
  let space = gap;
  const length = (s: number, g: number) => resourceIds.length * s + (resourceIds.length - 1) * g;
  const fit = Math.min(1, (span * 0.95) / length(step, space));
  step *= fit;
  space *= fit;
  const w = horizontal ? extent(size.w * fit) : size.w;
  const h = horizontal ? size.h : extent(size.h * fit);
  const start = (horizontal ? centre.x : centre.y) - length(step, space) / 2 + step / 2;
  const placed = resourceIds.map<PlanItem>((resourceId, index) => {
    const along = start + index * (step + space);
    return {
      resourceId,
      x: fraction((horizontal ? along : centre.x) / PLAN_WIDTH),
      y: fraction((horizontal ? centre.y : along) / height),
      w,
      h,
      rotation: 0,
      shape: "rect",
    };
  });
  const ids = new Set(resourceIds);
  return { ...layout, items: [...layout.items.filter((i) => !ids.has(i.resourceId)), ...placed] };
}

/** Moves resources by a delta in SVG units from their positions in `from`, keeping their centres on the plan. */
export function moveItems(from: FloorLayout, height: number, ids: string[], dx: number, dy: number): FloorLayout {
  const set = new Set(ids);
  return {
    ...from,
    items: from.items.map((i) => (set.has(i.resourceId) ? { ...i, x: fraction(i.x + dx / PLAN_WIDTH), y: fraction(i.y + dy / height) } : i)),
  };
}

/**
 * Resizes a resource by dragging one corner: the opposite corner stays where it is, in the item's rotated frame.
 * `corner` gives the signs of the dragged corner (-1 or 1 on each axis); `pointer` is in SVG units.
 */
export function resizeItem(from: FloorLayout, height: number, id: string, corner: { sx: number; sy: number }, pointer: Point): FloorLayout {
  return {
    ...from,
    items: from.items.map((item) => {
      if (item.resourceId !== id) return item;
      const { cx, cy, w, h } = itemBox(item, height);
      const anchor = { x: (-corner.sx * w) / 2, y: (-corner.sy * h) / 2 };
      const local = rotate({ x: pointer.x - cx, y: pointer.y - cy }, -item.rotation);
      const newW = Math.max(MIN_EXTENT * PLAN_WIDTH, Math.abs(local.x - anchor.x));
      const newH = Math.max(MIN_EXTENT * height, Math.abs(local.y - anchor.y));
      const localCentre = { x: anchor.x + (corner.sx * newW) / 2, y: anchor.y + (corner.sy * newH) / 2 };
      const shift = rotate(localCentre, item.rotation);
      return {
        ...item,
        x: fraction((cx + shift.x) / PLAN_WIDTH),
        y: fraction((cy + shift.y) / height),
        w: extent(newW / PLAN_WIDTH),
        h: extent(newH / height),
      };
    }),
  };
}

export function updateItems(layout: FloorLayout, ids: string[], change: (item: PlanItem) => Partial<PlanItem>): FloorLayout {
  const set = new Set(ids);
  return { ...layout, items: layout.items.map((i) => (set.has(i.resourceId) ? { ...i, ...change(i) } : i)) };
}

export function removeItems(layout: FloorLayout, ids: string[]): FloorLayout {
  const set = new Set(ids);
  return { ...layout, items: layout.items.filter((i) => !set.has(i.resourceId)) };
}

export function moveLabel(from: FloorLayout, height: number, index: number, dx: number, dy: number): FloorLayout {
  return {
    ...from,
    labels: from.labels.map((l, i) => (i === index ? { ...l, x: fraction(l.x + dx / PLAN_WIDTH), y: fraction(l.y + dy / height) } : l)),
  };
}

/** Moves a whole area; the move stops at the plan edges so the shape is never distorted. */
export function moveArea(from: FloorLayout, height: number, index: number, dx: number, dy: number): FloorLayout {
  const area = from.areas[index];
  if (!area) return from;
  const xs = area.points.map(([x]) => x);
  const ys = area.points.map(([, y]) => y);
  const fx = clamp(dx / PLAN_WIDTH, -Math.min(...xs), 1 - Math.max(...xs));
  const fy = clamp(dy / height, -Math.min(...ys), 1 - Math.max(...ys));
  const moved: PlanArea = { ...area, points: area.points.map(([x, y]) => [fraction(x + fx), fraction(y + fy)]) };
  return { ...from, areas: from.areas.map((a, i) => (i === index ? moved : a)) };
}

export function moveAreaPoint(from: FloorLayout, height: number, index: number, pointIndex: number, to: Point): FloorLayout {
  return {
    ...from,
    areas: from.areas.map((a, i) =>
      i === index ? { ...a, points: a.points.map((pt, j) => (j === pointIndex ? [fraction(to.x / PLAN_WIDTH), fraction(to.y / height)] : pt)) } : a,
    ),
  };
}

export function toFractionPoint(p: Point, height: number): [number, number] {
  return [fraction(p.x / PLAN_WIDTH), fraction(p.y / height)];
}

/** Copy of a label or an area shifted down and right; resources are duplicated by placing another one (see the editor). */
export function duplicateLabel(layout: FloorLayout, index: number): FloorLayout {
  const label = layout.labels[index];
  if (!label || layout.labels.length >= PLAN_LIMITS.labels) return layout;
  return { ...layout, labels: [...layout.labels, { ...label, x: fraction(label.x + 0.03), y: fraction(label.y + 0.03) }] };
}

export function duplicateArea(layout: FloorLayout, height: number, index: number): FloorLayout {
  const area = layout.areas[index];
  if (!area || layout.areas.length >= PLAN_LIMITS.areas) return layout;
  const copy = moveArea({ ...layout, areas: [area] }, height, 0, 30, 30).areas[0]!;
  return { ...layout, areas: [...layout.areas, copy] };
}
