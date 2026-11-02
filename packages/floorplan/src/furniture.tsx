import type { CwCategory } from "@gcf/shared";
import type { ReactNode } from "react";

/** Geometry of one placed resource in SVG units, before its rotation (the caller's group rotates everything). */
export interface FurnitureBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  round: boolean;
}

/** Where the code label goes and how large it may be, so it sits on a flat surface (desk or table top). */
export interface LabelSpot {
  x: number;
  y: number;
  maxSize: number;
}

/** Below this size (SVG units) the drawing would be noise: the shape keeps only its code. */
const MIN_DETAIL = 16;
/** Chairs drawn around a table: beyond this the table is crowded and the chairs unreadable. */
const MAX_CHAIRS = { meeting_room: 14, event_space: 24 } as const;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function Desk({ box, dedicated }: { box: FurnitureBox; dedicated: boolean }) {
  const { cx, cy, w, h } = box;
  const pad = Math.min(w, h) * 0.08;
  const deskW = w - 2 * pad;
  const deskH = (h - 2 * pad) * 0.56;
  const top = cy - h / 2 + pad;
  const chair = clamp(Math.min((h - 2 * pad) * 0.2, deskW * 0.2), 2, 14);
  const chairY = cy + h / 2 - pad - chair;
  return (
    <>
      <rect className="fp-furn fp-furn-top" x={cx - deskW / 2} y={top} width={deskW} height={deskH} rx={2} />
      {dedicated ? <line className="fp-furn fp-furn-bold" x1={cx - deskW * 0.22} y1={top + deskH * 0.2} x2={cx + deskW * 0.22} y2={top + deskH * 0.2} /> : null}
      <circle className="fp-furn" cx={cx} cy={chairY} r={chair} />
      <line className="fp-furn fp-furn-bold" x1={cx - chair * 0.8} y1={chairY + chair * 0.95} x2={cx + chair * 0.8} y2={chairY + chair * 0.95} />
    </>
  );
}

/** Chair positions around a rectangular table: long sides first, one at each end from six seats. */
function rectChairs(n: number, left: number, top: number, tw: number, th: number, r: number, gap: number) {
  const ends = n >= 6 ? 2 : 0;
  const above = Math.ceil((n - ends) / 2);
  const below = n - ends - above;
  const chairs: { x: number; y: number }[] = [];
  for (let i = 0; i < above; i += 1) chairs.push({ x: left + (tw * (i + 0.5)) / above, y: top - r - gap });
  for (let i = 0; i < below; i += 1) chairs.push({ x: left + (tw * (i + 0.5)) / below, y: top + th + r + gap });
  if (ends) {
    chairs.push({ x: left - r - gap, y: top + th / 2 });
    chairs.push({ x: left + tw + r + gap, y: top + th / 2 });
  }
  return chairs;
}

function Table({ box, seats }: { box: FurnitureBox; seats: number }) {
  const { cx, cy, w, h, round } = box;
  const tw = w * 0.6;
  const th = h * 0.46;
  const left = cx - tw / 2;
  const top = cy - th / 2;
  const n = Math.max(1, seats);
  const perSide = Math.max(1, Math.ceil((n >= 6 ? n - 2 : n) / 2));
  const r = clamp(Math.min(tw / perSide / 2.8, (h - th) / 7, w * 0.05), 2, 10);
  const gap = r * 0.5;
  const chairs = round
    ? Array.from({ length: n }, (_, i) => {
        const angle = (2 * Math.PI * i) / n - Math.PI / 2;
        return { x: cx + (tw / 2 + r + gap) * Math.cos(angle), y: cy + (th / 2 + r + gap) * Math.sin(angle) };
      })
    : rectChairs(n, left, top, tw, th, r, gap);
  return (
    <>
      {chairs.map((c, i) => (
        <circle key={i} className="fp-furn" cx={c.x} cy={c.y} r={r} />
      ))}
      {round ? (
        <ellipse className="fp-furn fp-furn-top" cx={cx} cy={cy} rx={tw / 2} ry={th / 2} />
      ) : (
        <rect className="fp-furn fp-furn-top" x={left} y={top} width={tw} height={th} rx={Math.min(th, tw) * 0.12} />
      )}
    </>
  );
}

/** Inner walls with a door opening on the bottom side, drawn as on an architect's plan (leaf and swing). */
function Walls({ box, inset, door }: { box: FurnitureBox; inset: number; door: number }) {
  const { cx, cy, w, h } = box;
  const left = cx - w / 2 + inset;
  const right = cx + w / 2 - inset;
  const top = cy - h / 2 + inset;
  const bottom = cy + h / 2 - inset;
  const hinge = right - inset;
  const open = hinge - door;
  return (
    <>
      <path
        className="fp-furn fp-furn-wall"
        d={`M ${open} ${bottom} L ${left} ${bottom} L ${left} ${top} L ${right} ${top} L ${right} ${bottom} L ${hinge} ${bottom}`}
      />
      <path className="fp-furn" d={`M ${hinge} ${bottom} L ${hinge} ${bottom - door} A ${door} ${door} 0 0 0 ${open} ${bottom}`} />
    </>
  );
}

function Office({ box }: { box: FurnitureBox }) {
  const { cx, cy, w, h } = box;
  const s = Math.min(w, h);
  const inset = s * 0.07;
  const deskW = w * 0.42;
  const deskH = h * 0.2;
  const deskX = cx - w / 2 + inset * 2.2;
  const deskY = cy - h / 2 + inset * 2.2;
  const chair = clamp(Math.min(deskH * 0.55, deskW * 0.2), 2, 12);
  return (
    <>
      <Walls box={box} inset={inset} door={clamp(s * 0.3, 6, w * 0.4)} />
      <rect className="fp-furn fp-furn-top" x={deskX} y={deskY} width={deskW} height={deskH} rx={2} />
      <circle className="fp-furn" cx={deskX + deskW / 2} cy={deskY + deskH + chair * 1.3} r={chair} />
    </>
  );
}

function Booth({ box }: { box: FurnitureBox }) {
  const { cx, cy, w, h, round } = box;
  const s = Math.min(w, h);
  const inset = s * 0.1;
  const seat = clamp(s * 0.13, 2, 10);
  return (
    <>
      {round ? null : <Walls box={box} inset={inset} door={s * 0.36} />}
      <circle className="fp-furn" cx={cx} cy={cy + h * 0.2} r={seat} />
    </>
  );
}

/**
 * Top-down drawing of the furniture of a resource (desk and chair, table and chairs, walls and door) and the spot
 * where its code reads best. Lines take the state colour through `currentColor`, so the state stays readable.
 */
export function furniture(category: CwCategory | undefined, capacity: number | undefined, box: FurnitureBox): { drawing: ReactNode; label: LabelSpot | null } {
  const { cx, cy, w, h } = box;
  if (!category || Math.min(w, h) < MIN_DETAIL) return { drawing: null, label: null };
  if (category === "hot_desk" || category === "dedicated_desk") {
    const pad = Math.min(w, h) * 0.08;
    const deskH = (h - 2 * pad) * 0.56;
    return {
      drawing: <Desk box={box} dedicated={category === "dedicated_desk"} />,
      label: { x: cx, y: cy - h / 2 + pad + deskH * (category === "dedicated_desk" ? 0.62 : 0.5), maxSize: deskH * 0.62 },
    };
  }
  if (category === "meeting_room" || category === "event_space") {
    const seats = Math.min(capacity ?? 1, MAX_CHAIRS[category]);
    return { drawing: <Table box={box} seats={seats} />, label: { x: cx, y: cy, maxSize: h * 0.3 } };
  }
  if (category === "private_office") return { drawing: <Office box={box} />, label: { x: cx + w * 0.08, y: cy + h * 0.12, maxSize: h * 0.3 } };
  return { drawing: <Booth box={box} />, label: { x: cx, y: cy - h * 0.1, maxSize: h * 0.3 } };
}
