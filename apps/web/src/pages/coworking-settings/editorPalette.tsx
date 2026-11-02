import type { CwCategory } from "@gcf/shared";
import type { DragEvent } from "react";
import type { FloorResource } from "./api";
import { benchSlots, footprint, gridSlots, type Point, type Slot } from "./layoutOps";

export type TileKind = CwCategory | "zone" | "text";

interface Tile {
  kind: TileKind;
  word: string;
  /** Seats of a new place created from the tile; the office manager changes it in the right panel. */
  capacity: number;
}

/** The palette, in the order an office manager thinks about a floor: places to work, rooms, then drawing aids. */
export const TILES: Tile[] = [
  { kind: "hot_desk", word: "Poste", capacity: 1 },
  { kind: "dedicated_desk", word: "Poste attitré", capacity: 1 },
  { kind: "meeting_room", word: "Salle de réunion", capacity: 6 },
  { kind: "private_office", word: "Bureau fermé", capacity: 2 },
  { kind: "phone_booth", word: "Cabine", capacity: 1 },
  { kind: "event_space", word: "Espace événement", capacity: 30 },
  { kind: "zone", word: "Zone", capacity: 0 },
  { kind: "text", word: "Texte", capacity: 0 },
];

export const tileOf = (kind: TileKind) => TILES.find((t) => t.kind === kind)!;

/** Data type of a palette tile dragged onto the plan. */
export const TILE_DRAG_TYPE = "application/x-gcf-plan-tile";

export interface Template {
  id: string;
  word: string;
  category: CwCategory;
  capacity: number;
  slots: (centre: Point, height: number) => Slot[];
}

/** Starter layouts offered on an empty floor; each one creates its places through the API. */
const TEMPLATES: Template[] = [
  {
    id: "open-space",
    word: "Open space 2 rangées de 6",
    category: "hot_desk",
    capacity: 1,
    slots: (centre, height) => benchSlots(centre, height, footprint("hot_desk"), 6),
  },
  {
    id: "meeting",
    word: "Salle de réunion 8 places",
    category: "meeting_room",
    capacity: 8,
    slots: (centre, height) => gridSlots(centre, height, { w: 200, h: 130 }, 1, 1, 0),
  },
  {
    id: "offices",
    word: "4 bureaux fermés",
    category: "private_office",
    capacity: 2,
    slots: (centre, height) => gridSlots(centre, height, footprint("private_office"), 4, 4, 0),
  },
];

/** Small top-down drawing of each tile, in the style of the plan's furniture. */
function TileIcon({ kind }: { kind: TileKind | "template-open-space" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const top = { ...common, fill: "currentColor", fillOpacity: 0.12 };
  const drawing = (() => {
    switch (kind) {
      case "hot_desk":
        return (
          <>
            <rect x={12} y={6} width={32} height={18} rx={2} {...top} />
            <circle cx={28} cy={33} r={6} {...common} />
          </>
        );
      case "dedicated_desk":
        return (
          <>
            <rect x={12} y={6} width={32} height={18} rx={2} {...top} />
            <line x1={21} y1={11} x2={35} y2={11} {...common} strokeWidth={3} />
            <circle cx={28} cy={33} r={6} {...common} />
          </>
        );
      case "meeting_room":
        return (
          <>
            <rect x={14} y={14} width={28} height={16} rx={3} {...top} />
            {[19, 28, 37].map((x) => (
              <g key={x}>
                <circle cx={x} cy={8} r={3.5} {...common} />
                <circle cx={x} cy={36} r={3.5} {...common} />
              </g>
            ))}
          </>
        );
      case "private_office":
        return (
          <>
            <path d="M 32 40 L 6 40 L 6 4 L 50 4 L 50 40 L 46 40" {...common} strokeWidth={2.5} />
            <path d="M 46 40 L 46 26 A 14 14 0 0 0 32 40" {...common} strokeWidth={1.5} />
            <rect x={11} y={9} width={18} height={9} rx={1.5} {...top} />
            <circle cx={20} cy={24} r={4} {...common} />
          </>
        );
      case "phone_booth":
        return (
          <>
            <path d="M 24 40 L 14 40 L 14 4 L 42 4 L 42 40 L 38 40" {...common} strokeWidth={2.5} />
            <line x1={20} y1={10} x2={36} y2={10} {...common} strokeWidth={3} />
            <circle cx={28} cy={22} r={5} {...common} />
          </>
        );
      case "event_space":
        return (
          <>
            <rect x={4} y={4} width={48} height={10} rx={2} {...top} />
            {[0, 1, 2].map((row) => [10, 19, 28, 37, 46].map((x) => <circle key={`${row}-${x}`} cx={x} cy={22 + row * 8} r={2.8} {...common} />))}
          </>
        );
      case "zone":
        return <path d="M 6 8 L 44 4 L 50 30 L 30 40 L 8 34 Z" {...common} fill="currentColor" fillOpacity={0.08} strokeDasharray="5 4" />;
      case "text":
        return (
          <text x={28} y={30} textAnchor="middle" fontSize={24} fontWeight={600} fill="currentColor">
            Aa
          </text>
        );
      default:
        return (
          <>
            {[8, 20, 32, 44].map((x) => (
              <g key={x}>
                <rect x={x - 5} y={10} width={10} height={10} rx={1} {...top} />
                <rect x={x - 5} y={22} width={10} height={10} rx={1} {...top} />
              </g>
            ))}
          </>
        );
    }
  })();
  return (
    <svg width="56" height="44" viewBox="0 0 56 44" aria-hidden="true" className="fpe-tile-icon">
      {drawing}
    </svg>
  );
}

/**
 * Left column: large illustrated tiles to drag onto the plan (or click to drop at the centre of the view), then
 * the places of the floor not yet on the plan.
 */
export function Palette({
  unplaced,
  disabled,
  onTile,
  onPlace,
  onPlaceAll,
  onDrawZone,
}: {
  unplaced: FloorResource[];
  disabled: boolean;
  onTile: (kind: TileKind) => void;
  onPlace: (resource: FloorResource) => void;
  onPlaceAll: (resources: FloorResource[]) => void;
  onDrawZone: () => void;
}) {
  const groups = new Map<string, FloorResource[]>();
  for (const r of unplaced) groups.set(r.typeId, [...(groups.get(r.typeId) ?? []), r]);
  const byType = [...groups.values()];
  const start = (event: DragEvent, kind: TileKind) => {
    event.dataTransfer.setData(TILE_DRAG_TYPE, kind);
    event.dataTransfer.effectAllowed = "copy";
  };
  return (
    <>
      <div className="fpe-section">
        <h2 className="h2">Ajouter</h2>
        <p className="cap">Faites glisser un élément sur le plan, ou cliquez dessus pour le poser au milieu.</p>
        <div className="fpe-tiles">
          {TILES.map((tile) => (
            <button
              key={tile.kind}
              type="button"
              className="fpe-tile"
              draggable={!disabled}
              disabled={disabled}
              onDragStart={(e) => start(e, tile.kind)}
              onClick={() => onTile(tile.kind)}
            >
              <TileIcon kind={tile.kind} />
              <span>{tile.word}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-g fpe-link" disabled={disabled} onClick={onDrawZone}>
          Dessiner une zone point par point
        </button>
      </div>
      <div className="fpe-section">
        <h2 className="h2">À placer ({unplaced.length})</h2>
        {unplaced.length ? (
          <>
            <p className="cap">Places de cet étage qui ne sont pas encore sur le plan.</p>
            {byType.map((group) => (
              <div key={group[0]!.typeId} className="stack" style={{ gap: 4 }}>
                <div className="row between center" style={{ gap: 8 }}>
                  <span className="lab">{group[0]!.typeName}</span>
                  {group.length > 1 ? (
                    <button type="button" className="btn btn-g fpe-link" disabled={disabled} onClick={() => onPlaceAll(group)}>
                      Placer les {group.length}
                    </button>
                  ) : null}
                </div>
                <ul className="fpe-unplaced">
                  {group.map((r) => (
                    <li key={r.id}>
                      <span>
                        <strong>{r.code}</strong>
                        {r.name ? <span className="cap"> {r.name}</span> : null}
                      </span>
                      <button type="button" className="btn" disabled={disabled} aria-label={`Placer ${r.code} sur le plan`} onClick={() => onPlace(r)}>
                        Placer
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        ) : (
          <p className="cap">Toutes les places de l'étage sont sur le plan.</p>
        )}
      </div>
    </>
  );
}

/** Shown over an empty plan: the three starter layouts agreed with the client. */
export function EmptyPlanCard({ disabled, onTemplate }: { disabled: boolean; onTemplate: (template: Template) => void }) {
  return (
    <div className="fpe-empty card" role="region" aria-label="Plan vide">
      <h2 className="h2">Ce plan est vide</h2>
      <p>Faites glisser un élément depuis la gauche, ou partez d'un modèle :</p>
      <div className="fpe-templates">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" className="btn fpe-template" disabled={disabled} onClick={() => onTemplate(t)}>
            <TileIcon kind={t.id === "open-space" ? "template-open-space" : t.category} />
            <span>{t.word}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
