import { PLAN_LIMITS, type CwCategory, type FloorLayout, type PlanArea, type PlanItem, type PlanLabel } from "@gcf/shared";
import { PLAN_WIDTH } from "@gcf/floorplan";

/**
 * Pure editing operations of the floor plan editor. Geometry is computed in SVG units (PLAN_WIDTH wide, `height`
 * high, the same space FloorPlanView draws in) and stored as fractions of the plan, as the layout schema requires.
 */

/** What is selected: placed resources by id, labels and zone areas by their index in the layout. */
export interface Selection {
  items: string[];
  labels: number[];
  areas: number[];
}
export type Point = { x: number; y: number };
/** Axis-aligned box in SVG units, from its top-left corner. */
export type Box = { x: number; y: number; w: number; h: number };
/** A placed resource without its resource: a spot computed before the resource exists. */
export type Slot = Omit<PlanItem, "resourceId">;
/** A light line drawn while dragging when an edge or a centre lines up with a neighbour. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}
export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";

export const NO_SELECTION: Selection = { items: [], labels: [], areas: [] };
export const selectionCount = (s: Selection) => s.items.length + s.labels.length + s.areas.length;

/** Smallest width or height of a placed resource, as a fraction of the plan (strictly positive in the schema). */
const MIN_EXTENT = 0.004;
/** Font sizes of the labels in SVG units, as drawn by FloorPlanView. */
const LABEL_FONT = { s: 14, m: 20, l: 30 } as const;
/** Two boxes that only touch (desks of a bench) do not overlap. */
const TOUCH = 1;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** Fractions are kept to 5 decimals: far below a pixel, and the stored JSON stays compact. */
const round = (v: number) => Math.round(v * 100_000) / 100_000;
const fraction = (v: number) => round(clamp(v, 0, 1));
const extent = (v: number) => round(clamp(v, MIN_EXTENT, 1));

export const snapTo = (value: number, grid: number) => Math.round(value / grid) * grid;
const normaliseRotation = (degrees: number) => ((Math.round(degrees) % 360) + 360) % 360;

/** Default footprint of a newly placed resource, in SVG units, by category. */
const DEFAULT_SIZE: Record<CwCategory, { w: number; h: number }> = {
  hot_desk: { w: 70, h: 56 },
  dedicated_desk: { w: 74, h: 60 },
  private_office: { w: 160, h: 120 },
  meeting_room: { w: 170, h: 110 },
  phone_booth: { w: 56, h: 56 },
  event_space: { w: 240, h: 160 },
};

/** Default footprint in SVG units. */
export const footprint = (category: CwCategory | undefined) => DEFAULT_SIZE[category ?? "hot_desk"];

/** Default footprint as fractions of the plan. */
export function defaultSize(category: CwCategory | undefined, height: number): { w: number; h: number } {
  const size = footprint(category);
  return { w: extent(size.w / PLAN_WIDTH), h: extent(size.h / height) };
}

function rotate(p: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
}

/** Item geometry in SVG units: centre and unrotated size. */
export function itemBox(item: Pick<PlanItem, "x" | "y" | "w" | "h">, height: number) {
  return { cx: item.x * PLAN_WIDTH, cy: item.y * height, w: item.w * PLAN_WIDTH, h: item.h * height };
}

/** Box around a placed resource, rotation included. */
export function itemBounds(item: PlanItem, height: number): Box {
  const { cx, cy, w, h } = itemBox(item, height);
  const r = (item.rotation * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r));
  const bh = Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r));
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
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
export function labelBox(label: PlanLabel, height: number): Box {
  const size = LABEL_FONT[label.size];
  const w = Math.max(size, label.text.trim().length * size * 0.6);
  const h = size * 1.3;
  return { x: label.x * PLAN_WIDTH - w / 2, y: label.y * height - h / 2, w, h };
}

const inside = (p: Point, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

export function hitLabel(layout: FloorLayout, height: number, p: Point): number | null {
  for (let i = layout.labels.length - 1; i >= 0; i -= 1) {
    if (inside(p, labelBox(layout.labels[i]!, height))) return i;
  }
  return null;
}

export function areaPoints(area: PlanArea, height: number): Point[] {
  return area.points.map(([x, y]) => ({ x: x * PLAN_WIDTH, y: y * height }));
}

export function areaBounds(area: PlanArea, height: number): Box {
  const points = areaPoints(area, height);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function insidePolygon(p: Point, polygon: Point[]): boolean {
  let within = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) within = !within;
  }
  return within;
}

export function hitArea(layout: FloorLayout, height: number, p: Point): number | null {
  for (let i = layout.areas.length - 1; i >= 0; i -= 1) {
    if (insidePolygon(p, areaPoints(layout.areas[i]!, height))) return i;
  }
  return null;
}

/** A placed resource centred on a point (SVG units). */
export function slotAt(at: Point, height: number, size: { w: number; h: number }, rotation = 0): Slot {
  return { x: fraction(at.x / PLAN_WIDTH), y: fraction(at.y / height), w: size.w, h: size.h, rotation: normaliseRotation(rotation), shape: "rect" };
}

/** Adds placed resources; a resource already on the plan moves to its new spot (a resource is placed once per floor). */
export function addItems(layout: FloorLayout, items: PlanItem[]): FloorLayout {
  const ids = new Set(items.map((i) => i.resourceId));
  return { ...layout, items: [...layout.items.filter((i) => !ids.has(i.resourceId)), ...items] };
}

/** Moves resources by a delta in SVG units from their positions in `from`, keeping their centres on the plan. */
function moveItems(from: FloorLayout, height: number, ids: string[], dx: number, dy: number): FloorLayout {
  const set = new Set(ids);
  return { ...from, items: from.items.map((i) => (set.has(i.resourceId) ? shiftItem(i, height, dx, dy) : i)) };
}

export function shiftItem<T extends Slot>(item: T, height: number, dx: number, dy: number): T {
  return { ...item, x: fraction(item.x + dx / PLAN_WIDTH), y: fraction(item.y + dy / height) };
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

function updateItems(layout: FloorLayout, ids: string[], change: (item: PlanItem) => Partial<PlanItem>): FloorLayout {
  const set = new Set(ids);
  return { ...layout, items: layout.items.map((i) => (set.has(i.resourceId) ? { ...i, ...change(i) } : i)) };
}

function moveLabel(from: FloorLayout, height: number, index: number, dx: number, dy: number): FloorLayout {
  return { ...from, labels: from.labels.map((l, i) => (i === index ? shiftLabel(l, height, dx, dy) : l)) };
}

export function shiftLabel(label: PlanLabel, height: number, dx: number, dy: number): PlanLabel {
  return { ...label, x: fraction(label.x + dx / PLAN_WIDTH), y: fraction(label.y + dy / height) };
}

/** Moves a whole area; the move stops at the plan edges so the shape is never distorted. */
export function shiftArea(area: PlanArea, height: number, dx: number, dy: number): PlanArea {
  const xs = area.points.map(([x]) => x);
  const ys = area.points.map(([, y]) => y);
  const fx = clamp(dx / PLAN_WIDTH, -Math.min(...xs), 1 - Math.max(...xs));
  const fy = clamp(dy / height, -Math.min(...ys), 1 - Math.max(...ys));
  return { ...area, points: area.points.map(([x, y]) => [fraction(x + fx), fraction(y + fy)]) };
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

/** Corners of a rectangular zone area centred on a point, kept inside the plan. */
export function rectPoints(centre: Point, height: number, size: { w: number; h: number }): [number, number][] {
  const x = clamp(centre.x - size.w / 2, 0, Math.max(0, PLAN_WIDTH - size.w));
  const y = clamp(centre.y - size.h / 2, 0, Math.max(0, height - size.h));
  return [
    toFractionPoint({ x, y }, height),
    toFractionPoint({ x: x + size.w, y }, height),
    toFractionPoint({ x: x + size.w, y: y + size.h }, height),
    toFractionPoint({ x, y: y + size.h }, height),
  ];
}

/* Selections */

/** Moves everything selected by the same delta (SVG units). */
export function moveSelection(from: FloorLayout, height: number, selection: Selection, dx: number, dy: number): FloorLayout {
  const labels = new Set(selection.labels);
  const areas = new Set(selection.areas);
  return {
    ...moveItems(from, height, selection.items, dx, dy),
    labels: from.labels.map((l, i) => (labels.has(i) ? shiftLabel(l, height, dx, dy) : l)),
    areas: from.areas.map((a, i) => (areas.has(i) ? shiftArea(a, height, dx, dy) : a)),
  };
}

export function removeSelection(layout: FloorLayout, selection: Selection): FloorLayout {
  const items = new Set(selection.items);
  const labels = new Set(selection.labels);
  const areas = new Set(selection.areas);
  return {
    ...layout,
    items: layout.items.filter((i) => !items.has(i.resourceId)),
    labels: layout.labels.filter((_, i) => !labels.has(i)),
    areas: layout.areas.filter((_, i) => !areas.has(i)),
  };
}

/** Turns the selected resources around their own centre; texts and zones keep their orientation. */
export function rotateSelection(layout: FloorLayout, selection: Selection, degrees: number): FloorLayout {
  return updateItems(layout, selection.items, (i) => ({ rotation: normaliseRotation(i.rotation + degrees) }));
}

export function selectAll(layout: FloorLayout): Selection {
  return { items: layout.items.map((i) => i.resourceId), labels: layout.labels.map((_, i) => i), areas: layout.areas.map((_, i) => i) };
}

/** Adds an element to the selection, or takes it out when it is already in (Shift + click). */
export function toggleInSelection(selection: Selection, kind: keyof Selection, key: string | number): Selection {
  const list = selection[kind] as (string | number)[];
  const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  return { ...selection, [kind]: next };
}

type ElementRef = { kind: "items"; id: string } | { kind: "labels" | "areas"; index: number };

function elements(layout: FloorLayout, height: number, selection: Selection): { ref: ElementRef; box: Box }[] {
  const items = new Map(layout.items.map((i) => [i.resourceId, i]));
  return [
    ...selection.items.flatMap((id) => {
      const item = items.get(id);
      return item ? [{ ref: { kind: "items" as const, id }, box: itemBounds(item, height) }] : [];
    }),
    ...selection.labels.flatMap((index) => {
      const label = layout.labels[index];
      return label ? [{ ref: { kind: "labels" as const, index }, box: labelBox(label, height) }] : [];
    }),
    ...selection.areas.flatMap((index) => {
      const area = layout.areas[index];
      return area ? [{ ref: { kind: "areas" as const, index }, box: areaBounds(area, height) }] : [];
    }),
  ];
}

function moveElement(layout: FloorLayout, height: number, ref: ElementRef, dx: number, dy: number): FloorLayout {
  if (ref.kind === "items") return moveItems(layout, height, [ref.id], dx, dy);
  if (ref.kind === "labels") return moveLabel(layout, height, ref.index, dx, dy);
  return { ...layout, areas: layout.areas.map((a, i) => (i === ref.index ? shiftArea(a, height, dx, dy) : a)) };
}

export function selectionBoxes(layout: FloorLayout, height: number, selection: Selection): Box[] {
  return elements(layout, height, selection).map((e) => e.box);
}

/** Boxes of everything that is not selected: the neighbours the alignment guides snap to. */
export function otherBoxes(layout: FloorLayout, height: number, selection: Selection): Box[] {
  const items = new Set(selection.items);
  const labels = new Set(selection.labels);
  const areas = new Set(selection.areas);
  return selectionBoxes(layout, height, {
    items: layout.items.filter((i) => !items.has(i.resourceId)).map((i) => i.resourceId),
    labels: layout.labels.map((_, i) => i).filter((i) => !labels.has(i)),
    areas: layout.areas.map((_, i) => i).filter((i) => !areas.has(i)),
  });
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w - TOUCH && b.x < a.x + a.w - TOUCH && a.y < b.y + b.h - TOUCH && b.y < a.y + a.h - TOUCH;
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** Rectangle selection: resources and texts it touches, zone areas it fully contains (they are large backgrounds). */
export function selectInRect(layout: FloorLayout, height: number, rect: Box): Selection {
  return {
    items: layout.items.filter((i) => overlaps(itemBounds(i, height), rect)).map((i) => i.resourceId),
    labels: layout.labels
      .map((l, i) => ({ i, box: labelBox(l, height) }))
      .filter((l) => overlaps(l.box, rect))
      .map((l) => l.i),
    areas: layout.areas
      .map((a, i) => ({ i, box: areaBounds(a, height) }))
      .filter((a) => contains(rect, a.box))
      .map((a) => a.i),
  };
}

/** Normalised rectangle between two corners. */
export function rectBetween(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Lines the selected elements up on one side (or the middle) of the box around them. */
export function alignSelection(layout: FloorLayout, height: number, selection: Selection, mode: AlignMode): FloorLayout {
  const list = elements(layout, height, selection);
  const all = unionBox(list.map((e) => e.box));
  if (!all || list.length < 2) return layout;
  return list.reduce((acc, { ref, box }) => {
    const dx =
      mode === "left" ? all.x - box.x : mode === "right" ? all.x + all.w - (box.x + box.w) : mode === "center" ? all.x + all.w / 2 - (box.x + box.w / 2) : 0;
    const dy =
      mode === "top" ? all.y - box.y : mode === "bottom" ? all.y + all.h - (box.y + box.h) : mode === "middle" ? all.y + all.h / 2 - (box.y + box.h / 2) : 0;
    return dx || dy ? moveElement(acc, height, ref, dx, dy) : acc;
  }, layout);
}

/** Spreads three or more elements so the gaps between them are equal; the first and the last stay in place. */
export function distributeSelection(layout: FloorLayout, height: number, selection: Selection, axis: "horizontal" | "vertical"): FloorLayout {
  const horizontal = axis === "horizontal";
  const start = (b: Box) => (horizontal ? b.x : b.y);
  const size = (b: Box) => (horizontal ? b.w : b.h);
  const list = elements(layout, height, selection).sort((a, b) => start(a.box) + size(a.box) / 2 - (start(b.box) + size(b.box) / 2));
  if (list.length < 3) return layout;
  const first = list[0]!.box;
  const last = list[list.length - 1]!.box;
  const span = start(last) + size(last) - start(first);
  const gap = (span - list.reduce((sum, e) => sum + size(e.box), 0)) / (list.length - 1);
  let cursor = start(first) + size(first) + gap;
  return list.slice(1, -1).reduce((acc, { ref, box }) => {
    const delta = cursor - start(box);
    cursor += size(box) + gap;
    return moveElement(acc, height, ref, horizontal ? delta : 0, horizontal ? 0 : delta);
  }, layout);
}

const anchors = (start: number, length: number) => [start, start + length / 2, start + length];

/**
 * Snapping while dragging: when an edge or the centre of the moving box comes within `threshold` of an edge or
 * centre of a neighbour, the move is corrected to line them up and a guide is returned for each axis that snapped.
 */
export function snapMove(moving: Box, others: Box[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const best = (axis: "x" | "y") => {
    let found: { delta: number; at: number } | null = null;
    const mine = axis === "x" ? anchors(moving.x, moving.w) : anchors(moving.y, moving.h);
    for (const other of others) {
      for (const theirs of axis === "x" ? anchors(other.x, other.w) : anchors(other.y, other.h)) {
        for (const own of mine) {
          const delta = theirs - own;
          if (Math.abs(delta) <= threshold && (!found || Math.abs(delta) < Math.abs(found.delta))) found = { delta, at: theirs };
        }
      }
    }
    return found;
  };
  const x = best("x");
  const y = best("y");
  const dx = x?.delta ?? 0;
  const dy = y?.delta ?? 0;
  const moved = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  if (x) {
    const aligned = others.filter((o) => anchors(o.x, o.w).some((a) => Math.abs(a - x.at) < 0.5));
    guides.push({
      axis: "x",
      at: x.at,
      from: Math.min(moved.y, ...aligned.map((o) => o.y)),
      to: Math.max(moved.y + moved.h, ...aligned.map((o) => o.y + o.h)),
    });
  }
  if (y) {
    const aligned = others.filter((o) => anchors(o.y, o.h).some((a) => Math.abs(a - y.at) < 0.5));
    guides.push({
      axis: "y",
      at: y.at,
      from: Math.min(moved.x, ...aligned.map((o) => o.x)),
      to: Math.max(moved.x + moved.w, ...aligned.map((o) => o.x + o.w)),
    });
  }
  return { dx, dy, guides };
}

/**
 * Where pasted copies go: beside their model (to the right, then below, then further away) at the first spot where
 * they stay on the plan without covering anything already there. `allowInPlace` tries the original position first
 * (pasting what was cut).
 */
export function pasteOffset(copies: Box[], others: Box[], height: number, gap: number, allowInPlace: boolean): Point {
  const all = unionBox(copies);
  if (!all) return { x: 0, y: 0 };
  const candidates: Point[] = allowInPlace ? [{ x: 0, y: 0 }] : [];
  for (let k = 1; k <= 20; k += 1) {
    candidates.push({ x: k * (all.w + gap), y: 0 }, { x: 0, y: k * (all.h + gap) }, { x: -k * (all.w + gap), y: 0 }, { x: 0, y: -k * (all.h + gap) });
  }
  const free = candidates.find(
    (d) =>
      all.x + d.x >= 0 &&
      all.y + d.y >= 0 &&
      all.x + all.w + d.x <= PLAN_WIDTH &&
      all.y + all.h + d.y <= height &&
      !copies.some((c) => others.some((o) => overlaps({ ...c, x: c.x + d.x, y: c.y + d.y }, o))),
  );
  return free ?? { x: gap, y: gap };
}

/* Groups of resources (starter templates, placing several unplaced resources at once) */

/**
 * Spots for `count` resources in rows of `perRow` around a centre, `gap` apart (SVG units). The group shrinks to
 * fit 95 % of the plan when it would be larger.
 */
export function gridSlots(centre: Point, height: number, size: { w: number; h: number }, count: number, perRow: number, gap: number): Slot[] {
  const columns = Math.max(1, Math.min(perRow, count));
  const rows = Math.ceil(count / columns);
  const width = columns * size.w + (columns - 1) * gap;
  const tall = rows * size.h + (rows - 1) * gap;
  const fit = Math.min(1, (PLAN_WIDTH * 0.95) / width, (height * 0.95) / tall);
  const w = size.w * fit;
  const h = size.h * fit;
  const g = gap * fit;
  const left = clamp(centre.x - (width * fit) / 2, 0, PLAN_WIDTH - width * fit);
  const top = clamp(centre.y - (tall * fit) / 2, 0, height - tall * fit);
  return Array.from({ length: count }, (_, i) => {
    const column = i % columns;
    const row = Math.floor(i / columns);
    return slotAt({ x: left + column * (w + g) + w / 2, y: top + row * (h + g) + h / 2 }, height, { w: extent(w / PLAN_WIDTH), h: extent(h / height) });
  });
}

/** Two rows of desks back to back (a bench): people of the first row face those of the second. */
export function benchSlots(centre: Point, height: number, size: { w: number; h: number }, perRow: number): Slot[] {
  const rows = gridSlots(centre, height, size, perRow * 2, perRow, 0);
  return rows.map((slot, i) => (i < perRow ? { ...slot, rotation: 180 } : slot));
}

/** True when that many more texts and zone areas still fit within the plan limits. */
export const roomFor = (layout: FloorLayout, labels: number, areas: number) =>
  layout.labels.length + labels <= PLAN_LIMITS.labels && layout.areas.length + areas <= PLAN_LIMITS.areas;
