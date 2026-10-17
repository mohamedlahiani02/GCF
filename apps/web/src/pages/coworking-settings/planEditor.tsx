import { FloorPlanView, PLAN_WIDTH, planHeight, type ResourceAppearance } from "@gcf/floorplan";
import { CW_CATEGORY_LABELS, floorLayoutSchema, PLAN_LIMITS, type FloorLayout, type PlanItem, type PlanLabel } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useBlocker, useParams } from "react-router";
import { api, ApiError } from "../../api/client";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Segmented } from "../../components/ui";
import { frDateTime } from "../../lib/format";
import { CW_KEYS, type FloorDetail, type FloorResource } from "./api";
import { LabelDialog, NewResourceDialog, RowDialog, ZoneChoiceDialog } from "./editorDialogs";
import { IMAGE_TYPES, mediaUrl, uploadImage } from "./helpers";
import {
  areaPoints,
  defaultSize,
  duplicateArea,
  duplicateLabel,
  hitArea,
  hitItem,
  hitLabel,
  itemBox,
  labelBox,
  moveArea,
  moveAreaPoint,
  moveItems,
  moveLabel,
  normaliseRotation,
  placeItem,
  placeRow,
  removeItems,
  resizeItem,
  snapTo,
  toFractionPoint,
  updateItems,
  type Point,
  type Selection,
} from "./layoutOps";

const HISTORY_LIMIT = 100;
const GRID_SIZES = [5, 10, 20, 40];
/** Plan images are decoded in the browser before being scaled down; beyond this size the tab may run out of memory. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

interface History {
  past: FloorLayout[];
  present: FloorLayout;
  future: FloorLayout[];
  /** Consecutive edits with the same key (typing a label, nudging with the arrows) make one undo step. */
  key: string | null;
}

type Drag =
  | { kind: "items"; ids: string[]; anchor: PlanItem; start: Point; before: FloorLayout }
  | { kind: "resize"; id: string; corner: { sx: number; sy: number }; before: FloorLayout }
  | { kind: "label"; index: number; start: Point; before: FloorLayout }
  | { kind: "area"; index: number; start: Point; before: FloorLayout }
  | { kind: "vertex"; index: number; pointIndex: number; before: FloorLayout };

type Dialog = "row" | "label" | "resource" | "zone" | "publish" | "discard" | null;

const CORNERS = [
  { sx: -1, sy: -1, name: "nw" },
  { sx: 1, sy: -1, name: "ne" },
  { sx: 1, sy: 1, name: "se" },
  { sx: -1, sy: 1, name: "sw" },
] as const;

const canonical = (layout: FloorLayout | null) => {
  if (!layout) return "";
  const parsed = floorLayoutSchema.safeParse(layout);
  return JSON.stringify(parsed.success ? parsed.data : layout);
};

/** French reasons why the layout cannot be saved yet; the API checks the same rules again. */
function layoutIssues(layout: FloorLayout, floor: FloorDetail): string[] {
  const issues: string[] = [];
  const known = new Set(floor.resources.map((r) => r.id));
  const zones = new Set(floor.zones.map((z) => z.id));
  const unknown = layout.items.filter((i) => !known.has(i.resourceId)).length;
  if (unknown) issues.push(`${unknown} élément(s) du plan désignent une ressource archivée ou déplacée sur un autre étage : retirez-les.`);
  const lostZones = layout.areas.filter((a) => !zones.has(a.zoneId)).length;
  if (lostZones) issues.push(`${lostZones} surface(s) appartiennent à une zone archivée : supprimez-les ou choisissez une autre zone.`);
  layout.labels.forEach((l, i) => {
    const length = l.text.trim().length;
    if (length === 0 || length > 60) issues.push(`Le texte n° ${i + 1} doit contenir de 1 à 60 caractères.`);
  });
  if (layout.labels.length > PLAN_LIMITS.labels) issues.push(`Un plan compte au plus ${PLAN_LIMITS.labels} textes.`);
  if (layout.areas.length > PLAN_LIMITS.areas) issues.push(`Un plan compte au plus ${PLAN_LIMITS.areas} surfaces de zone.`);
  if (!issues.length && !floorLayoutSchema.safeParse(layout).success) issues.push("Le plan contient des éléments invalides.");
  return issues;
}

/** Details of a layout error from the API: the resources or zones it names, or the fields the schema rejected. */
function apiLayoutDetails(error: unknown, floor: FloorDetail): { text: string[]; resourceIds: string[]; zoneIds: string[] } {
  const empty = { text: [], resourceIds: [], zoneIds: [] };
  if (!(error instanceof ApiError)) return empty;
  const details = error.details as { resourceIds?: string[]; zoneIds?: string[] } | { path?: string; message?: string }[] | undefined;
  if (error.code === "invalid_layout" && Array.isArray(details)) return { ...empty, text: details.map((d) => `${d.path ?? ""} : ${d.message ?? ""}`) };
  if (error.code === "unknown_plan_resource" && details && !Array.isArray(details)) return { ...empty, resourceIds: details.resourceIds ?? [] };
  if (error.code === "unknown_plan_zone" && details && !Array.isArray(details)) {
    const names = new Map(floor.zones.map((z) => [z.id, z.name]));
    return { ...empty, zoneIds: details.zoneIds ?? [], text: (details.zoneIds ?? []).map((id) => names.get(id) ?? "Zone archivée") };
  }
  return empty;
}

function PlanImageCard({ floor }: { floor: FloorDetail }) {
  const client = useQueryClient();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const setPlan = useMutation({
    mutationFn: async (file: File | null) => {
      const media = file ? await uploadImage(file, `Plan ${floor.name}`, "plans") : null;
      return api.put(`/coworking/floors/${floor.id}/plan`, { mediaId: media?.id ?? null });
    },
    onSuccess: async (_, file) => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast(file ? "Image du plan enregistrée." : "Image du plan retirée.");
    },
  });
  const pick = (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) return setProblem("Choisissez une image PNG, JPEG ou WebP.");
    if (file.size > MAX_SOURCE_BYTES) return setProblem("Cette image est trop lourde (40 Mo au plus avant réduction).");
    setPlan.mutate(file);
  };
  return (
    <Card title="Image du plan">
      <div className="card-b stack">
        <span className="cap">
          Plan d'architecte ou photo du plan d'évacuation. L'image est réduite à 2560 pixels et convertie en WebP avant l'envoi. Elle s'affiche aussitôt sur
          le plan publié ; les positions des ressources restent relatives à l'image.
        </span>
        <div className="row" style={{ gap: 8 }}>
          <label className={`btn${setPlan.isPending ? " disabled" : ""}`}>
            {setPlan.isPending ? <span className="spinner" aria-label="Envoi en cours" /> : null}
            {floor.planMediaId ? "Remplacer l'image" : "Choisir une image"}
            <input
              type="file"
              accept={IMAGE_TYPES.join(",")}
              className="visually-hidden"
              aria-label="Image du plan"
              disabled={setPlan.isPending}
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {floor.planMediaId ? (
            <button type="button" className="btn btn-g" disabled={setPlan.isPending} onClick={() => setPlan.mutate(null)}>
              Retirer l'image
            </button>
          ) : null}
        </div>
        {floor.planWidth && floor.planHeight ? (
          <span className="cap">
            Image actuelle : {floor.planWidth} × {floor.planHeight} pixels.
          </span>
        ) : null}
        {problem ? <span className="err-text">{problem}</span> : null}
        <ErrorBanner error={setPlan.error} />
      </div>
    </Card>
  );
}

/** Interactive editor of one floor: works on a local copy of the draft, saved as the draft, then published. */
export function FloorEditorPage() {
  const { id = "" } = useParams();
  const floor = useQuery({ queryKey: CW_KEYS.floor(id), queryFn: () => api.get<FloorDetail>(`/coworking/floors/${id}`) });
  usePage(["Coworking", "Paramètres coworking", floor.data ? `Plan : ${floor.data.name}` : "Plan"]);
  if (floor.error) return <ErrorBanner error={floor.error} retry={() => floor.refetch()} />;
  if (floor.isPending) return <Loading />;
  if (floor.data.status !== "active") {
    return (
      <Card>
        <Empty
          title="Cet étage est archivé"
          action={
            <Link className="btn" to="/coworking/parametres?onglet=etages">
              Retour aux étages
            </Link>
          }
        />
      </Card>
    );
  }
  return <Editor key={floor.data.id} floor={floor.data} />;
}

function Editor({ floor }: { floor: FloorDetail }) {
  const client = useQueryClient();
  const toast = useToast();
  const saved = floor.draftLayout ?? floor.layout;
  const [history, setHistory] = useState<History>({ past: [], present: saved, future: [], key: null });
  const layout = history.present;
  const [selection, setSelection] = useState<Selection>(null);
  const [drawing, setDrawing] = useState<[number, number][] | null>(null);
  const [pendingArea, setPendingArea] = useState<[number, number][] | null>(null);
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(10);
  const [dialog, setDialog] = useState<Dialog>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);

  const image = floor.planMediaId && floor.planWidth && floor.planHeight ? { url: mediaUrl(floor.planMediaId), width: floor.planWidth, height: floor.planHeight } : null;
  const height = planHeight(layout, image);
  const resources = useMemo(() => new Map(floor.resources.map((r) => [r.id, r])), [floor.resources]);
  const placed = useMemo(() => new Set(layout.items.map((i) => i.resourceId)), [layout.items]);
  const unplaced = floor.resources.filter((r) => !placed.has(r.id));
  const dirty = useMemo(() => canonical(layout) !== canonical(saved), [layout, saved]);
  const issues = useMemo(() => layoutIssues(layout, floor), [layout, floor]);
  const hasDraft = floor.draftLayout !== null;

  const commit = useCallback((next: FloorLayout, key: string | null = null) => {
    setHistory((h) => {
      if (next === h.present) return h;
      if (key !== null && key === h.key) return { ...h, present: next };
      return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [], key };
    });
  }, []);
  const preview = (next: FloorLayout) => setHistory((h) => ({ ...h, present: next }));
  const finishDrag = (before: FloorLayout) =>
    setHistory((h) => (h.present === before ? h : { past: [...h.past, before].slice(-HISTORY_LIMIT), present: h.present, future: [], key: null }));
  const undo = () =>
    setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future], key: null } : h));
  const redo = () => setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1), key: null } : h));
  const reset = (next: FloorLayout) => {
    setHistory({ past: [], present: next, future: [], key: null });
    setSelection(null);
    setDrawing(null);
  };

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const refresh = () => client.invalidateQueries({ queryKey: CW_KEYS.all });
  const saveDraft = useMutation({
    mutationFn: () => api.put(`/coworking/floors/${floor.id}/draft-layout`, layout),
    onSuccess: async () => {
      await refresh();
      toast("Brouillon enregistré. Publiez-le pour que l'accueil et les clients voient le nouveau plan.");
    },
  });
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty || !hasDraft) await api.put(`/coworking/floors/${floor.id}/draft-layout`, layout);
      return api.post(`/coworking/floors/${floor.id}/publish`);
    },
    onSuccess: async () => {
      await refresh();
      setDialog(null);
      toast("Plan publié : l'accueil et les clients voient maintenant ce plan.");
    },
  });
  const discard = useMutation({
    mutationFn: async () => {
      if (hasDraft) await api.del(`/coworking/floors/${floor.id}/draft-layout`);
    },
    onSuccess: async () => {
      reset(floor.layout);
      await refresh();
      setDialog(null);
      toast("Brouillon abandonné : l'éditeur repart du plan publié.");
    },
  });
  const apiError = saveDraft.error ?? publish.error;
  const apiDetails = apiLayoutDetails(apiError, floor);

  const svg = () => wrapRef.current?.querySelector<SVGSVGElement>("svg.fp") ?? null;
  const toPlan = (clientX: number, clientY: number): Point | null => {
    const element = svg();
    const matrix = element?.getScreenCTM();
    if (!matrix) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  };
  const centre: Point = { x: PLAN_WIDTH / 2, y: height / 2 };
  const snapped = (v: number) => (snap ? snapTo(v, grid) : v);

  const placeResource = (resource: Pick<FloorResource, "id" | "category">, at: Point = centre) => {
    const target = { x: snapped(at.x), y: snapped(at.y) };
    commit(placeItem(layout, height, resource.id, target, defaultSize(resource.category, height)));
    setSelection({ kind: "items", ids: [resource.id] });
    wrapRef.current?.focus();
  };

  const selectedItems = selection?.kind === "items" ? layout.items.filter((i) => selection.ids.includes(i.resourceId)) : [];
  const selectedLabel = selection?.kind === "label" ? layout.labels[selection.index] : undefined;
  const selectedArea = selection?.kind === "area" ? layout.areas[selection.index] : undefined;
  const selectedIndex = selection && selection.kind !== "items" ? selection.index : -1;

  const removeSelection = () => {
    if (selection?.kind === "items") commit(removeItems(layout, selection.ids));
    if (selection?.kind === "label") commit({ ...layout, labels: layout.labels.filter((_, i) => i !== selection.index) });
    if (selection?.kind === "area") commit({ ...layout, areas: layout.areas.filter((_, i) => i !== selection.index) });
    setSelection(null);
  };

  /** A resource is placed once per floor: duplicating one places the next unplaced resource of the same type beside it. */
  const nextOfType = (item: PlanItem) => {
    const typeId = resources.get(item.resourceId)?.typeId;
    return unplaced.find((r) => r.typeId === typeId) ?? null;
  };
  const duplicate = () => {
    if (selection?.kind === "label") {
      commit(duplicateLabel(layout, selection.index));
      setSelection({ kind: "label", index: layout.labels.length });
    } else if (selection?.kind === "area") {
      commit(duplicateArea(layout, height, selection.index));
      setSelection({ kind: "area", index: layout.areas.length });
    } else if (selectedItems.length === 1) {
      const item = selectedItems[0]!;
      const next = nextOfType(item);
      if (!next) return;
      const { cx, w } = itemBox(item, height);
      const copy: PlanItem = { ...item, resourceId: next.id };
      const shifted = moveItems({ ...layout, items: [copy] }, height, [next.id], cx + w + 8 <= PLAN_WIDTH ? w + 8 : -(w + 8), 0).items[0]!;
      commit({ ...layout, items: [...layout.items, shifted] });
      setSelection({ kind: "items", ids: [next.id] });
    }
  };
  const canDuplicate =
    selection?.kind === "label" || selection?.kind === "area" || (selectedItems.length === 1 && nextOfType(selectedItems[0]!) !== null);

  const rotateSelection = (delta: number) => {
    if (selection?.kind !== "items") return;
    commit(updateItems(layout, selection.ids, (i) => ({ rotation: normaliseRotation(i.rotation + delta) })));
  };

  const nudge = (dx: number, dy: number) => {
    if (selection?.kind === "items") commit(moveItems(layout, height, selection.ids, dx, dy), "nudge");
    if (selection?.kind === "label") commit(moveLabel(layout, height, selection.index, dx, dy), "nudge");
    if (selection?.kind === "area") commit(moveArea(layout, height, selection.index, dx, dy), "nudge");
  };

  const finishArea = () => {
    if (!drawing || drawing.length < 3) return;
    setPendingArea(drawing);
    setDrawing(null);
    setDialog("zone");
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const p = toPlan(event.clientX, event.clientY);
    if (!p) return;
    wrapRef.current?.focus();
    if (drawing) {
      if (drawing.length < PLAN_LIMITS.areaPoints) setDrawing([...drawing, toFractionPoint({ x: snapped(p.x), y: snapped(p.y) }, height)]);
      return;
    }
    const target = event.target as Element;
    const handle = target.closest("[data-handle]");
    const vertex = target.closest("[data-vertex]");
    let drag: Drag | null = null;
    if (handle && selectedItems.length === 1) {
      const corner = CORNERS.find((c) => c.name === handle.getAttribute("data-handle"))!;
      drag = { kind: "resize", id: selectedItems[0]!.resourceId, corner, before: layout };
    } else if (vertex && selection?.kind === "area") {
      drag = { kind: "vertex", index: selection.index, pointIndex: Number(vertex.getAttribute("data-vertex")), before: layout };
    } else {
      const item = hitItem(layout, height, p);
      const label = item ? null : hitLabel(layout, height, p);
      const area = item || label !== null ? null : hitArea(layout, height, p);
      if (item) {
        const already = selection?.kind === "items" && selection.ids.includes(item.resourceId);
        let ids = [item.resourceId];
        if (event.shiftKey && selection?.kind === "items") {
          ids = already ? selection.ids.filter((x) => x !== item.resourceId) : [...selection.ids, item.resourceId];
        } else if (already && selection?.kind === "items") ids = selection.ids;
        setSelection(ids.length ? { kind: "items", ids } : null);
        if (ids.includes(item.resourceId)) drag = { kind: "items", ids, anchor: item, start: p, before: layout };
      } else if (label !== null) {
        setSelection({ kind: "label", index: label });
        drag = { kind: "label", index: label, start: p, before: layout };
      } else if (area !== null) {
        setSelection({ kind: "area", index: area });
        drag = { kind: "area", index: area, start: p, before: layout };
      } else {
        setSelection(null);
      }
    }
    if (drag) {
      dragRef.current = drag;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toPlan(event.clientX, event.clientY);
    if (!p) return;
    if (drag.kind === "items") {
      const { cx, cy } = itemBox(drag.anchor, height);
      const dx = snapped(cx + p.x - drag.start.x) - cx;
      const dy = snapped(cy + p.y - drag.start.y) - cy;
      preview(moveItems(drag.before, height, drag.ids, dx, dy));
    } else if (drag.kind === "resize") {
      preview(resizeItem(drag.before, height, drag.id, drag.corner, { x: snapped(p.x), y: snapped(p.y) }));
    } else if (drag.kind === "label") {
      const label = drag.before.labels[drag.index]!;
      const dx = snapped(label.x * PLAN_WIDTH + p.x - drag.start.x) - label.x * PLAN_WIDTH;
      const dy = snapped(label.y * height + p.y - drag.start.y) - label.y * height;
      preview(moveLabel(drag.before, height, drag.index, dx, dy));
    } else if (drag.kind === "area") {
      const first = drag.before.areas[drag.index]!.points[0]!;
      const dx = snapped(first[0] * PLAN_WIDTH + p.x - drag.start.x) - first[0] * PLAN_WIDTH;
      const dy = snapped(first[1] * height + p.y - drag.start.y) - first[1] * height;
      preview(moveArea(drag.before, height, drag.index, dx, dy));
    } else {
      preview(moveAreaPoint(drag.before, height, drag.index, drag.pointIndex, { x: snapped(p.x), y: snapped(p.y) }));
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    finishDrag(drag.before);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (mod && key === "d") {
      event.preventDefault();
      duplicate();
      return;
    }
    if (event.key === "Escape") {
      if (drawing) setDrawing(null);
      else setSelection(null);
      return;
    }
    if (event.key === "Enter" && drawing) {
      event.preventDefault();
      finishArea();
      return;
    }
    if (!selection) return;
    const step = (snap ? grid : 1) * (event.shiftKey ? 10 : 1);
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      nudge(move[0], move[1]);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeSelection();
    } else if (key === "r" && selection.kind === "items") {
      event.preventDefault();
      rotateSelection(event.shiftKey ? -15 : 15);
    }
  };

  const appearance = (resourceId: string): ResourceAppearance => {
    const r = resources.get(resourceId);
    if (!r) return { label: "?", title: "Ressource archivée ou d'un autre étage", state: "blocked" };
    return {
      label: r.code,
      title: `${r.code}${r.name ? ` ${r.name}` : ""}, ${r.typeName}${r.status === "out_of_service" ? ", hors service" : ""}`,
      state: r.status === "out_of_service" ? "blocked" : "free",
    };
  };

  const overlay = (
    <>
      {snap ? (
        <>
          <defs>
            <pattern id="fpe-grid" width={grid} height={grid} patternUnits="userSpaceOnUse">
              <path d={`M ${grid} 0 L 0 0 0 ${grid}`} className="fpe-grid" />
            </pattern>
          </defs>
          <rect x={0} y={0} width={PLAN_WIDTH} height={height} fill="url(#fpe-grid)" pointerEvents="none" />
        </>
      ) : null}
      {selectedItems.map((item) => {
        const { cx, cy, w, h } = itemBox(item, height);
        return (
          <g key={item.resourceId} transform={`rotate(${item.rotation} ${cx} ${cy})`}>
            <rect className="fpe-outline" x={cx - w / 2 - 3} y={cy - h / 2 - 3} width={w + 6} height={h + 6} />
            {selectedItems.length === 1
              ? CORNERS.map((c) => (
                  <rect
                    key={c.name}
                    data-handle={c.name}
                    className="fpe-handle"
                    x={cx + (c.sx * w) / 2 - 6}
                    y={cy + (c.sy * h) / 2 - 6}
                    width={12}
                    height={12}
                  />
                ))
              : null}
          </g>
        );
      })}
      {selectedLabel ? (
        (() => {
          const b = labelBox(selectedLabel, height);
          return <rect className="fpe-outline" x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} />;
        })()
      ) : null}
      {selectedArea && selection?.kind === "area"
        ? areaPoints(selectedArea, height).map((pt, i) => <circle key={i} data-vertex={i} className="fpe-handle" cx={pt.x} cy={pt.y} r={7} />)
        : null}
      {drawing ? (
        <g pointerEvents="none">
          <polyline className="fpe-draft" points={drawing.map(([x, y]) => `${x * PLAN_WIDTH},${y * height}`).join(" ")} />
          {drawing.map(([x, y], i) => (
            <circle key={i} className="fpe-handle" cx={x * PLAN_WIDTH} cy={y * height} r={i === 0 ? 8 : 5} />
          ))}
        </g>
      ) : null}
    </>
  );

  const status = dirty ? (
    <Badge tone="amber">Modifications non enregistrées</Badge>
  ) : hasDraft ? (
    <Badge tone="blue">Brouillon enregistré, non publié</Badge>
  ) : (
    <Badge tone="green">À jour avec le plan publié</Badge>
  );
  const busy = saveDraft.isPending || publish.isPending || discard.isPending;

  return (
    <>
      <PageHeader
        title={`Plan : ${floor.name}`}
        subtitle={
          floor.layoutPublishedAt
            ? `Publié le ${frDateTime(floor.layoutPublishedAt)}${floor.layoutPublishedBy ? ` par ${floor.layoutPublishedBy}` : ""}`
            : "Ce plan n'a jamais été publié."
        }
        actions={
          <>
            <Link className="btn btn-g" to="/coworking/parametres?onglet=etages">
              Retour aux étages
            </Link>
            <button type="button" className="btn" disabled={!dirty && !hasDraft} onClick={() => setDialog("discard")}>
              Abandonner le brouillon
            </button>
            <button type="button" className="btn" disabled={!dirty || issues.length > 0 || busy} onClick={() => saveDraft.mutate()}>
              Enregistrer le brouillon
            </button>
            <button type="button" className="btn btn-p" disabled={(!dirty && !hasDraft) || issues.length > 0 || busy} onClick={() => setDialog("publish")}>
              Publier
            </button>
          </>
        }
      />
      {issues.length ? (
        <div className="ban ban-amber" role="alert" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <strong>À corriger avant d'enregistrer</strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          {layout.items.some((i) => !resources.has(i.resourceId)) ? (
            <button type="button" className="btn" onClick={() => commit({ ...layout, items: layout.items.filter((i) => resources.has(i.resourceId)) })}>
              Retirer les ressources inconnues du plan
            </button>
          ) : null}
        </div>
      ) : null}
      {apiError ? (
        <div className="stack" style={{ gap: 8 }}>
          <ErrorBanner error={apiError} />
          {apiDetails.text.length ? (
            <ul className="cap">
              {apiDetails.text.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          ) : null}
          {apiDetails.resourceIds.length || apiDetails.zoneIds.length ? (
            <div>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  commit({
                    ...layout,
                    items: layout.items.filter((i) => !apiDetails.resourceIds.includes(i.resourceId)),
                    areas: layout.areas.filter((a) => !apiDetails.zoneIds.includes(a.zoneId)),
                  })
                }
              >
                Retirer ces éléments du plan
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="fpe">
        <Card
          title={
            <div className="row center" style={{ gap: 10 }}>
              <h2 className="h2">Plan</h2>
              {status}
            </div>
          }
          actions={
            <>
              <button type="button" className="btn btn-g" disabled={!history.past.length} onClick={undo} title="Ctrl+Z">
                Annuler l'action
              </button>
              <button type="button" className="btn btn-g" disabled={!history.future.length} onClick={redo} title="Ctrl+Y">
                Rétablir
              </button>
            </>
          }
        >
          <div className="card-b stack">
            <div className="row center fpe-tools">
              <button type="button" className="btn" disabled={!unplaced.length || !!drawing} onClick={() => setDialog("row")}>
                Rangée de postes
              </button>
              <button type="button" className="btn" disabled={!!drawing} onClick={() => setDialog("resource")}>
                Nouvelle ressource
              </button>
              <button
                type="button"
                className="btn"
                aria-pressed={!!drawing}
                disabled={layout.areas.length >= PLAN_LIMITS.areas}
                onClick={() => {
                  setSelection(null);
                  setDrawing(drawing ? null : []);
                  wrapRef.current?.focus();
                }}
              >
                {drawing ? "Arrêter le tracé" : "Tracer une zone"}
              </button>
              <button type="button" className="btn" disabled={!!drawing || layout.labels.length >= PLAN_LIMITS.labels} onClick={() => setDialog("label")}>
                Ajouter un texte
              </button>
              <label className="row center" style={{ gap: 6 }}>
                <input type="checkbox" className="chk" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
                Grille magnétique
              </label>
              <select className="input fpe-grid-size" aria-label="Pas de la grille" value={grid} disabled={!snap} onChange={(e) => setGrid(Number(e.target.value))}>
                {GRID_SIZES.map((g) => (
                  <option key={g} value={g}>
                    Pas de {g}
                  </option>
                ))}
              </select>
            </div>
            {drawing ? (
              <div className="ban ban-blue">
                <span>
                  Cliquez sur le plan pour poser les sommets de la zone ({drawing.length} posé{drawing.length > 1 ? "s" : ""}, 3 au minimum). Entrée ou « Terminer »
                  ferme la forme, Échap l'abandonne.
                </span>
                <button type="button" className="btn" disabled={drawing.length < 2} onClick={() => setDrawing(drawing.slice(0, -1))}>
                  Retirer le dernier point
                </button>
                <button type="button" className="btn btn-p" disabled={drawing.length < 3} onClick={finishArea}>
                  Terminer
                </button>
              </div>
            ) : null}
            <div
              ref={wrapRef}
              className={`fpe-canvas${drawing ? " drawing" : ""}`}
              tabIndex={0}
              role="application"
              aria-label={`Édition du plan ${floor.name}`}
              aria-describedby="fpe-help"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
            >
              <FloorPlanView
                layout={layout}
                image={image}
                appearance={appearance}
                zones={floor.zones}
                selectedId={selectedItems.length === 1 ? selectedItems[0]!.resourceId : null}
                onSelect={(resourceId) => setSelection({ kind: "items", ids: [resourceId] })}
                title={`Plan de ${floor.name} en cours d'édition`}
                overlay={overlay}
              />
            </div>
            <p id="fpe-help" className="cap">
              Glisser : déplacer. Maj + clic : sélection multiple. Poignées : redimensionner. Flèches : décaler (Maj : ×10). R : pivoter de 15°. Ctrl+D :
              dupliquer. Suppr : retirer du plan. Ctrl+Z / Ctrl+Y : annuler / rétablir.
            </p>
            {!image ? (
              <div className="grid3">
                <Field label="Proportions du plan (largeur / hauteur)" hint="Sans image, la zone de dessin garde ce rapport, de 0,25 à 4.">
                  <input
                    className="input num"
                    type="number"
                    min={0.25}
                    max={4}
                    step={0.05}
                    value={layout.aspect}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (value >= 0.25 && value <= 4) commit({ ...layout, aspect: value }, "aspect");
                    }}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        </Card>
        <div className="stack fpe-side">
          <Card title="Sélection">
            <div className="card-b stack">
              {selectedItems.length === 1 ? (
                <ItemInspector item={selectedItems[0]!} resource={resources.get(selectedItems[0]!.resourceId)} />
              ) : selectedItems.length > 1 ? (
                <strong>{selectedItems.length} ressources sélectionnées</strong>
              ) : selectedLabel ? (
                <>
                  <Field label="Texte">
                    <input
                      className="input"
                      value={selectedLabel.text}
                      maxLength={60}
                      onChange={(e) =>
                        commit(
                          { ...layout, labels: layout.labels.map((l, i) => (i === selectedIndex ? { ...l, text: e.target.value } : l)) },
                          `label-${selectedIndex}`,
                        )
                      }
                    />
                  </Field>
                  <Segmented<PlanLabel["size"]>
                    label="Taille du texte"
                    value={selectedLabel.size}
                    onChange={(size) => commit({ ...layout, labels: layout.labels.map((l, i) => (i === selectedIndex ? { ...l, size } : l)) })}
                    options={[
                      { value: "s", label: "Petit" },
                      { value: "m", label: "Moyen" },
                      { value: "l", label: "Grand" },
                    ]}
                  />
                </>
              ) : selectedArea ? (
                <>
                  <Field label="Zone de la surface">
                    <select
                      className="input"
                      value={selectedArea.zoneId}
                      onChange={(e) => commit({ ...layout, areas: layout.areas.map((a, i) => (i === selectedIndex ? { ...a, zoneId: e.target.value } : a)) })}
                    >
                      {floor.zones.some((z) => z.id === selectedArea.zoneId) ? null : <option value={selectedArea.zoneId}>Zone archivée</option>}
                      {floor.zones.map((z) => (
                        <option key={z.id} value={z.id}>
                          {z.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <span className="cap">{selectedArea.points.length} sommets. Faites glisser un sommet pour modifier la forme.</span>
                </>
              ) : (
                <span className="cap">
                  Cliquez sur une ressource, un texte ou une zone du plan pour le modifier. Les ressources de l'étage qui ne sont pas encore sur le plan sont listées
                  ci-dessous.
                </span>
              )}
              {selectedItems.length ? (
                <>
                  <div className="stack" style={{ gap: 6 }}>
                    <span className="lab">Forme</span>
                    <Segmented<PlanItem["shape"]>
                      label="Forme"
                      value={selectedItems.every((i) => i.shape === "ellipse") ? "ellipse" : "rect"}
                      onChange={(shape) => selection?.kind === "items" && commit(updateItems(layout, selection.ids, () => ({ shape })))}
                      options={[
                        { value: "rect", label: "Rectangle" },
                        { value: "ellipse", label: "Ellipse" },
                      ]}
                    />
                  </div>
                  <div className="stack" style={{ gap: 6 }}>
                    <span className="lab">Rotation{selectedItems.length === 1 ? ` : ${selectedItems[0]!.rotation}°` : ""}</span>
                    <div className="row" style={{ gap: 8 }}>
                      <button type="button" className="btn" aria-label="Pivoter de 15 degrés à gauche" onClick={() => rotateSelection(-15)}>
                        -15°
                      </button>
                      <button type="button" className="btn" aria-label="Pivoter de 15 degrés à droite" onClick={() => rotateSelection(15)}>
                        +15°
                      </button>
                      <button
                        type="button"
                        className="btn btn-g"
                        onClick={() => selection?.kind === "items" && commit(updateItems(layout, selection.ids, () => ({ rotation: 0 })))}
                      >
                        Remettre droit
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
              {selection ? (
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canDuplicate}
                    title={selectedItems.length === 1 && !canDuplicate ? "Toutes les ressources de ce type sont déjà placées." : undefined}
                    onClick={duplicate}
                  >
                    Dupliquer
                  </button>
                  <button type="button" className="btn btn-d" onClick={removeSelection}>
                    {selection.kind === "items" ? "Retirer du plan" : "Supprimer"}
                  </button>
                </div>
              ) : null}
            </div>
          </Card>
          <Card title={`Ressources à placer (${unplaced.length})`}>
            {unplaced.length === 0 ? (
              <Empty title="Toutes les ressources sont placées" text="Créez une ressource pour l'ajouter au plan." />
            ) : (
              <ul className="fpe-palette">
                {unplaced.map((r) => (
                  <li key={r.id}>
                    <span>
                      <strong>{r.code}</strong> <span className="cap">{r.typeName}</span>
                    </span>
                    <button type="button" className="btn btn-g" disabled={!!drawing} aria-label={`Placer ${r.code} au centre du plan`} onClick={() => placeResource(r)}>
                      Placer
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <PlanImageCard floor={floor} />
        </div>
      </div>
      {dialog === "row" ? (
        <RowDialog
          unplaced={unplaced}
          onClose={() => setDialog(null)}
          onPlace={(ids, direction, gap) => {
            const first = resources.get(ids[0]!);
            commit(placeRow(layout, height, ids, { x: snapped(centre.x), y: snapped(centre.y) }, defaultSize(first?.category, height), direction, gap));
            setSelection({ kind: "items", ids });
            wrapRef.current?.focus();
          }}
        />
      ) : null}
      {dialog === "label" ? (
        <LabelDialog
          onClose={() => setDialog(null)}
          onAdd={(text, size) => {
            commit({ ...layout, labels: [...layout.labels, { text, size, x: 0.5, y: 0.5 }] });
            setSelection({ kind: "label", index: layout.labels.length });
          }}
        />
      ) : null}
      {dialog === "zone" && pendingArea ? (
        <ZoneChoiceDialog
          floor={floor}
          onClose={() => {
            setDialog(null);
            setPendingArea(null);
          }}
          onChoose={(zoneId) => {
            commit({ ...layout, areas: [...layout.areas, { zoneId, points: pendingArea }] });
            setSelection({ kind: "area", index: layout.areas.length });
          }}
        />
      ) : null}
      {dialog === "resource" ? (
        <NewResourceDialog
          floor={floor}
          onClose={() => setDialog(null)}
          onCreated={(resource) => placeResource({ id: resource.id, category: resource.category })}
        />
      ) : null}
      {dialog === "publish" ? (
        <Modal
          title="Publier le plan"
          onClose={() => setDialog(null)}
          footer={
            <>
              <span className="cap">Action tracée au journal d'audit</span>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setDialog(null)}>
                  Retour
                </button>
                <button type="button" className="btn btn-p" disabled={publish.isPending} onClick={() => publish.mutate()}>
                  {publish.isPending ? <span className="spinner" aria-label="En cours" /> : "Publier"}
                </button>
              </div>
            </>
          }
        >
          <p>
            Le plan en direct de l'accueil et l'espace client affichent aussitôt cette version{dirty ? ", enregistrée avant la publication" : ""}.
          </p>
          <span className="cap">
            {layout.items.length} ressource(s) placée(s), {unplaced.length} non placée(s) (non visibles sur le plan), {layout.areas.length} zone(s) tracée(s),{" "}
            {layout.labels.length} texte(s).
          </span>
          <ErrorBanner error={publish.error} />
        </Modal>
      ) : null}
      {dialog === "discard" ? (
        <Modal
          title="Abandonner le brouillon"
          onClose={() => setDialog(null)}
          footer={
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setDialog(null)}>
                  Retour
                </button>
                <button type="button" className="btn btn-d" disabled={discard.isPending} onClick={() => discard.mutate()}>
                  Abandonner
                </button>
              </div>
            </>
          }
        >
          <p>Les modifications {hasDraft ? "du brouillon enregistré et celles en cours" : "en cours"} sont perdues ; l'éditeur repart du plan publié.</p>
          <ErrorBanner error={discard.error} />
        </Modal>
      ) : null}
      {blocker.state === "blocked" ? (
        <Modal
          title="Modifications non enregistrées"
          onClose={() => blocker.reset()}
          footer={
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => blocker.reset()}>
                  Rester sur le plan
                </button>
                <button type="button" className="btn btn-d" onClick={() => blocker.proceed()}>
                  Quitter sans enregistrer
                </button>
              </div>
            </>
          }
        >
          <p>Le plan a des modifications qui ne sont pas enregistrées dans le brouillon. Elles seront perdues si vous quittez cette page.</p>
        </Modal>
      ) : null}
    </>
  );
}

function ItemInspector({ item, resource }: { item: PlanItem; resource: FloorResource | undefined }) {
  if (!resource) return <span className="err-text">Cette ressource est archivée ou rattachée à un autre étage : retirez-la du plan.</span>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <strong>
        {resource.code}
        {resource.name ? ` ${resource.name}` : ""}
      </strong>
      <span className="cap">
        {resource.typeName} ({CW_CATEGORY_LABELS.fr[resource.category]}), {resource.capacity} place{resource.capacity > 1 ? "s" : ""}
      </span>
      {resource.status === "out_of_service" ? <Badge tone="gray">Hors service</Badge> : null}
      <span className="cap">
        Position {Math.round(item.x * 100)} % × {Math.round(item.y * 100)} %
      </span>
    </div>
  );
}
