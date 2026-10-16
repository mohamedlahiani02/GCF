import type { FloorLayout, PlanItem, PlanState } from "@gcf/shared";
import type { KeyboardEvent, ReactNode } from "react";

/** How one placed resource looks: its plan state (or a heat value for occupancy maps) and its accessible name. */
export interface ResourceAppearance {
  label: string;
  title: string;
  state?: PlanState | undefined;
  /** 0 to 1: occupancy rate drawn as a colour ramp instead of a state. */
  heat?: number | undefined;
  disabled?: boolean | undefined;
}

export interface FloorPlanViewProps {
  layout: FloorLayout;
  /** Plan image and its pixel size; without it the drawing area keeps layout.aspect. */
  image?: { url: string; width: number; height: number } | null | undefined;
  appearance: (resourceId: string) => ResourceAppearance | undefined;
  zones?: { id: string; name: string; color: string }[] | undefined;
  selectedId?: string | null | undefined;
  onSelect?: ((resourceId: string) => void) | undefined;
  /** Accessible name of the whole plan. */
  title: string;
  /** Extra SVG drawn above the plan (selection handles of the editor). */
  overlay?: ReactNode;
  className?: string | undefined;
}

/** Width of the SVG coordinate space; the height follows the plan's aspect ratio. */
export const PLAN_WIDTH = 1000;

export function planHeight(layout: FloorLayout, image?: { width: number; height: number } | null): number {
  const aspect = image ? image.width / image.height : layout.aspect;
  return Math.round(PLAN_WIDTH / aspect);
}

function itemBox(item: PlanItem, height: number) {
  const w = item.w * PLAN_WIDTH;
  const h = item.h * height;
  return { cx: item.x * PLAN_WIDTH, cy: item.y * height, w, h };
}

const LABEL_SIZE = { s: 14, m: 20, l: 30 } as const;

/**
 * Read-only rendering of a floor: plan image, zones, labels and resources coloured by state. Resources are
 * buttons (click, Enter or Space) when onSelect is given. Colours come from the host stylesheet through the
 * fp-state-* classes so the back-office and the portal keep their own palette.
 */
export function FloorPlanView({ layout, image, appearance, zones, selectedId, onSelect, title, overlay, className }: FloorPlanViewProps) {
  const height = planHeight(layout, image);
  const zoneColor = new Map((zones ?? []).map((z) => [z.id, z.color]));
  const zoneName = new Map((zones ?? []).map((z) => [z.id, z.name]));
  const activate = (resourceId: string, disabled: boolean | undefined) => {
    if (onSelect && !disabled) onSelect(resourceId);
  };
  const onKey = (event: KeyboardEvent, resourceId: string, disabled: boolean | undefined) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(resourceId, disabled);
    }
  };
  return (
    <svg
      className={`fp${className ? ` ${className}` : ""}`}
      viewBox={`0 0 ${PLAN_WIDTH} ${height}`}
      role="group"
      aria-label={title}
      preserveAspectRatio="xMidYMid meet"
    >
      {image ? (
        <image href={image.url} x={0} y={0} width={PLAN_WIDTH} height={height} preserveAspectRatio="none" />
      ) : (
        <rect className="fp-background" x={0} y={0} width={PLAN_WIDTH} height={height} />
      )}
      {layout.areas.map((area, index) => (
        <polygon
          key={`area-${index}`}
          className="fp-area"
          points={area.points.map(([x, y]) => `${x * PLAN_WIDTH},${y * height}`).join(" ")}
          style={{ fill: zoneColor.get(area.zoneId) ?? "#94a3b8", stroke: zoneColor.get(area.zoneId) ?? "#94a3b8" }}
        >
          <title>{zoneName.get(area.zoneId) ?? ""}</title>
        </polygon>
      ))}
      {layout.labels.map((label, index) => (
        <text
          key={`label-${index}`}
          className="fp-label"
          x={label.x * PLAN_WIDTH}
          y={label.y * height}
          fontSize={LABEL_SIZE[label.size]}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {label.text}
        </text>
      ))}
      {layout.items.map((item) => {
        const look = appearance(item.resourceId);
        if (!look) return null;
        const { cx, cy, w, h } = itemBox(item, height);
        const selected = selectedId === item.resourceId;
        const interactive = !!onSelect && !look.disabled;
        const stateClass = look.heat !== undefined ? "fp-heat" : `fp-state-${look.state ?? "free"}`;
        const heatStyle = look.heat !== undefined ? { fillOpacity: 0.15 + 0.85 * Math.min(1, Math.max(0, look.heat)) } : undefined;
        const fontSize = Math.max(10, Math.min(22, Math.min(w, h) * 0.38));
        return (
          <g
            key={item.resourceId}
            className={`fp-res ${stateClass}${selected ? " fp-selected" : ""}${interactive ? " fp-interactive" : ""}`}
            transform={`rotate(${item.rotation} ${cx} ${cy})`}
            {...(interactive
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-pressed": selected,
                  onClick: () => activate(item.resourceId, look.disabled),
                  onKeyDown: (e: KeyboardEvent) => onKey(e, item.resourceId, look.disabled),
                }
              : {})}
            aria-label={look.title}
          >
            <title>{look.title}</title>
            {item.shape === "ellipse" ? (
              <ellipse className="fp-shape" cx={cx} cy={cy} rx={w / 2} ry={h / 2} style={heatStyle} />
            ) : (
              <rect className="fp-shape" x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={4} style={heatStyle} />
            )}
            <text
              className="fp-code"
              x={cx}
              y={cy}
              fontSize={fontSize}
              textAnchor="middle"
              dominantBaseline="central"
              transform={`rotate(${-item.rotation} ${cx} ${cy})`}
            >
              {look.label}
            </text>
          </g>
        );
      })}
      {overlay}
    </svg>
  );
}
