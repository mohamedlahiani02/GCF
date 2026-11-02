import { FloorPlanView, PLAN_WIDTH, planHeight, type ResourceAppearance } from "@gcf/floorplan";
import { floorLayoutSchema, PLAN_LIMITS, type CwCategory, type FloorLayout, type PlanArea, type PlanItem, type PlanLabel } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../../api/client";
import { useFullScreenPage, usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, ErrorBanner, Loading, Modal } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { CW_KEYS, type FloorDetail, type FloorResource, type Resource, type ResourceType } from "./api";
import { DiscardDialog, LabelDialog, PlanSettingsDialog, PublishDialog, TypeDialog, ZoneChoiceDialog } from "./editorDialogs";
import { ContextMenu, MOD_KEY, ShortcutsDialog, Tour, tourWanted, type MenuEntry, type TourStep } from "./editorHelp";
import { EmptyPlanCard, Palette, TILE_DRAG_TYPE, TILES, tileOf, type Template, type TileKind } from "./editorPalette";
import { categoryWord, SelectionPanel } from "./editorPanel";
import { createResources, type ResourceSpec } from "./editorResources";
import { mediaUrl } from "./helpers";
import {
  addItems,
  alignSelection,
  areaBounds,
  areaPoints,
  defaultSize,
  distributeSelection,
  footprint,
  gridSlots,
  hitArea,
  hitItem,
  hitLabel,
  itemBounds,
  itemBox,
  labelBox,
  moveAreaPoint,
  moveSelection,
  NO_SELECTION,
  otherBoxes,
  pasteOffset,
  rectBetween,
  rectPoints,
  removeSelection,
  resizeItem,
  roomFor,
  rotateSelection,
  selectAll,
  selectInRect,
  selectionBoxes,
  selectionCount,
  shiftArea,
  shiftItem,
  shiftLabel,
  slotAt,
  snapMove,
  snapTo,
  toFractionPoint,
  toggleInSelection,
  unionBox,
  type AlignMode,
  type Box,
  type Guide,
  type Point,
  type Selection,
  type Slot,
} from "./layoutOps";

const FLOORS_TAB = "/coworking/parametres?onglet=etages";
const HISTORY_LIMIT = 100;
/** The draft is saved this long after the last change: one request per pause, not one per mouse move. */
const AUTOSAVE_DELAY_MS = 1500;
/** Step of the magnetic grid, in SVG units (the plan is 1000 units wide). */
const GRID = 10;
/** Space left between pasted copies and their model, in SVG units. */
const PASTE_GAP = 10;
/** Screen distances: a press that moves less is a click; guides attract within this distance. */
const DRAG_START_PX = 4;
const SNAP_PX = 7;
const HANDLE_PX = 14;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
const VIEWPORT_PADDING = 24;
const ZONE_SIZE = { w: 220, h: 150 };

interface History {
  past: FloorLayout[];
  present: FloorLayout;
  future: FloorLayout[];
  /** Consecutive edits with the same key (typing a label, nudging with the arrows) make one undo step. */
  key: string | null;
}

type Drag =
  | { kind: "move"; start: Point; startClient: Point; moved: boolean; before: FloorLayout; selection: Selection; bounds: Box; others: Box[] }
  | { kind: "resize"; id: string; corner: { sx: number; sy: number }; before: FloorLayout }
  | { kind: "vertex"; index: number; pointIndex: number; before: FloorLayout }
  | { kind: "marquee"; start: Point; startClient: Point; moved: boolean; base: Selection; area: number | null; additive: boolean }
  | { kind: "pan"; startClient: Point; scroll: Point };

type Dialog =
  | { kind: "label"; at: Point }
  | { kind: "zone"; points: [number, number][] }
  | { kind: "type"; category: CwCategory; types: ResourceType[]; resolve: (type: ResourceType | null) => void }
  | { kind: "publish" | "discard" | "settings" | "help" }
  | null;

/** Copied elements; resources carry what a new place made from them copies (type, seats, zone, equipment). */
interface Clip {
  items: { item: PlanItem; spec: ResourceSpec }[];
  labels: PlanLabel[];
  areas: PlanArea[];
  /** Cut resources are off the plan: the first paste puts the same places back instead of creating new ones. */
  cut: boolean;
}

const CORNERS = [
  { sx: -1, sy: -1, name: "nw" },
  { sx: 1, sy: -1, name: "ne" },
  { sx: 1, sy: 1, name: "se" },
  { sx: -1, sy: 1, name: "sw" },
] as const;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const canonical = (layout: FloorLayout | null) => {
  if (!layout) return "";
  const parsed = floorLayoutSchema.safeParse(layout);
  return JSON.stringify(parsed.success ? parsed.data : layout);
};

/** Keys typed in a field or a list belong to that field, never to the editor's shortcuts. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
/** Space activates a focused button; it pans the plan only when the plan (or nothing in particular) has the focus. */
const pressable = (target: EventTarget | null) => target instanceof Element && !!target.closest("button, a, [role='button'], label");

/** French reasons why the layout cannot be saved yet; the API checks the same rules again. */
function layoutIssues(layout: FloorLayout, floor: FloorDetail): string[] {
  const issues: string[] = [];
  const known = new Set(floor.resources.map((r) => r.id));
  const zones = new Set(floor.zones.map((z) => z.id));
  const unknown = layout.items.filter((i) => !known.has(i.resourceId)).length;
  if (unknown) issues.push(`${unknown} élément(s) du plan désignent une place archivée ou déplacée sur un autre étage : supprimez-les du plan.`);
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

const ICONS = {
  quit: "M15 18l-6-6 6-6",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  check: "M20 6 9 17l-5-5",
  fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Editor header kept while the floor loads or cannot be opened, so the way out is always visible. */
function BareEditor({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fpe-root">
      <header className="fpe-head">
        <Link className="btn" to={FLOORS_TAB}>
          <Icon name="quit" />
          Quitter
        </Link>
        <h1 className="h1">{title}</h1>
      </header>
      <div className="fpe-message">{children}</div>
    </div>
  );
}

/** Full-screen editor of one floor: changes are saved as the draft automatically, then published on demand. */
export function FloorEditorPage() {
  useFullScreenPage();
  const { id = "" } = useParams();
  const floor = useQuery({ queryKey: CW_KEYS.floor(id), queryFn: () => api.get<FloorDetail>(`/coworking/floors/${id}`) });
  usePage(["Coworking", "Paramètres coworking", floor.data ? `Plan : ${floor.data.name}` : "Plan"]);
  if (floor.error)
    return (
      <BareEditor title="Plan">
        <ErrorBanner error={floor.error} retry={() => floor.refetch()} />
      </BareEditor>
    );
  if (floor.isPending)
    return (
      <BareEditor title="Plan">
        <Loading />
      </BareEditor>
    );
  if (floor.data.status !== "active")
    return (
      <BareEditor title={floor.data.name}>
        <p>Cet étage est archivé : son plan ne peut plus être modifié.</p>
      </BareEditor>
    );
  return <Editor key={floor.data.id} floor={floor.data} />;
}

function Editor({ floor }: { floor: FloorDetail }) {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const initial = floor.draftLayout ?? floor.layout;
  const [history, setHistory] = useState<History>({ past: [], present: initial, future: [], key: null });
  const layout = history.present;
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [drawing, setDrawing] = useState<[number, number][] | null>(null);
  const [snap, setSnap] = useState(true);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [zoom, setZoom] = useState(1);
  const [stageWidth, setStageWidth] = useState(PLAN_WIDTH);
  const [working, setWorking] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [panReady, setPanReady] = useState(false);
  const [tour, setTour] = useState(tourWanted);
  const [savedKey, setSavedKey] = useState(() => canonical(initial));
  const [hasDraft, setHasDraft] = useState(floor.draftLayout !== null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLElement>(null);
  const publishRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const clipRef = useRef<Clip | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const suppressClick = useRef(false);
  const zoomAnchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const chosenTypes = useRef(new Map<CwCategory, string>());
  const leaving = useRef(false);

  const image =
    floor.planMediaId && floor.planWidth && floor.planHeight ? { url: mediaUrl(floor.planMediaId), width: floor.planWidth, height: floor.planHeight } : null;
  const height = planHeight(layout, image);
  const resources = useMemo(() => new Map(floor.resources.map((r) => [r.id, r])), [floor.resources]);
  const placed = useMemo(() => new Set(layout.items.map((i) => i.resourceId)), [layout.items]);
  const unplaced = floor.resources.filter((r) => !placed.has(r.id));
  const detail = useQuery({
    queryKey: CW_KEYS.floorResources(floor.id),
    queryFn: () => api.get<Resource[]>("/coworking/resources", { floorId: floor.id }),
  });
  const layoutKey = useMemo(() => canonical(layout), [layout]);
  const publishedKey = useMemo(() => canonical(floor.layout), [floor.layout]);
  const issues = useMemo(() => layoutIssues(layout, floor), [layout, floor]);
  const pending = layoutKey !== savedKey;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const unpublished = layoutKey !== publishedKey;
  const count = selectionCount(selection);
  const unitsPerPx = PLAN_WIDTH / Math.max(1, stageWidth);

  /* History */

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
  const stepBack = (h: History): History =>
    h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future], key: null } : h;
  const undo = () => {
    setHistory(stepBack);
    setSelection(NO_SELECTION);
  };
  const redo = () => {
    setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1), key: null } : h));
    setSelection(NO_SELECTION);
  };
  /** The "Annuler" of a toast only undoes its own action, not a later one. */
  const undoIf = (expected: FloorLayout) => setHistory((h) => (h.present === expected ? stepBack(h) : h));

  /* Draft saving, publication, discarding */

  const save = useMutation({
    mutationFn: (snapshot: FloorLayout) => api.put(`/coworking/floors/${floor.id}/draft-layout`, snapshot),
    onSuccess: (_, snapshot) => {
      setSavedKey(canonical(snapshot));
      setHasDraft(true);
      setFailedKey(null);
      void client.invalidateQueries({ queryKey: CW_KEYS.floors });
    },
    onError: (_, snapshot) => setFailedKey(canonical(snapshot)),
  });
  const publish = useMutation({
    mutationFn: async ({ snapshot, mustSave }: { snapshot: FloorLayout; mustSave: boolean }) => {
      if (mustSave) await api.put(`/coworking/floors/${floor.id}/draft-layout`, snapshot);
      return api.post(`/coworking/floors/${floor.id}/publish`);
    },
    onSuccess: async (_, { snapshot }) => {
      setSavedKey(canonical(snapshot));
      setHasDraft(false);
      setFailedKey(null);
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      setDialog(null);
      toast("Plan publié : l'accueil et les clients voient maintenant ce plan.");
    },
  });
  const discard = useMutation({
    mutationFn: async () => {
      if (hasDraft) await api.del(`/coworking/floors/${floor.id}/draft-layout`);
    },
    onSuccess: async () => {
      const previous = layoutRef.current;
      setHistory({ past: [], present: floor.layout, future: [], key: null });
      setSelection(NO_SELECTION);
      setDrawing(null);
      setSavedKey(publishedKey);
      setHasDraft(false);
      setFailedKey(null);
      setDialog(null);
      await client.invalidateQueries({ queryKey: CW_KEYS.floors });
      toast("Brouillon abandonné : l'éditeur repart du plan publié.", "success", { label: "Annuler", run: () => commit(previous) });
    },
  });

  useEffect(() => {
    if (!pending || issues.length || save.isPending || publish.isPending || discard.isPending || layoutKey === failedKey) return;
    const timer = window.setTimeout(() => save.mutate(layoutRef.current), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [layoutKey, pending, issues.length, save.isPending, publish.isPending, discard.isPending, failedKey]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => !leaving.current && pendingRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const quit = async () => {
    if (pending && !issues.length) {
      try {
        await save.mutateAsync(layoutRef.current);
      } catch {
        return;
      }
      leaving.current = true;
    }
    navigate(FLOORS_TAB);
  };

  const failed = save.isError && failedKey === layoutKey;
  const apiError = (failed ? save.error : null) ?? publish.error;
  const apiDetails = apiLayoutDetails(apiError, floor);

  /* Coordinates and zoom */

  const svg = () => stageRef.current?.querySelector<SVGSVGElement>("svg.fp") ?? null;
  const toPlan = (clientX: number, clientY: number): Point | null => {
    const matrix = svg()?.getScreenCTM();
    if (!matrix) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  };
  const insidePlan = (p: Point): Point => ({ x: clamp(p.x, 0, PLAN_WIDTH), y: clamp(p.y, 0, height) });
  /** Middle of the part of the plan on screen: where a clicked tile lands. */
  const viewCentre = (): Point => {
    const box = viewportRef.current?.getBoundingClientRect();
    const p = box ? toPlan(box.left + box.width / 2, box.top + box.height / 2) : null;
    return p ? insidePlan(p) : { x: PLAN_WIDTH / 2, y: height / 2 };
  };
  const snapped = (v: number) => (snap ? snapTo(v, GRID) : v);
  const snapPoint = (p: Point): Point => ({ x: snapped(p.x), y: snapped(p.y) });

  const fitZoom = () => {
    const viewport = viewportRef.current;
    if (!viewport) return 1;
    const width = viewport.clientWidth - 2 * VIEWPORT_PADDING;
    const tall = viewport.clientHeight - 2 * VIEWPORT_PADDING;
    return clamp(Math.min(1, (tall * PLAN_WIDTH) / (width * height)), ZOOM_MIN, 1);
  };
  const zoomTo = (value: number, around?: Point) => {
    const next = clamp(value, ZOOM_MIN, ZOOM_MAX);
    const stage = stageRef.current?.getBoundingClientRect();
    const view = viewportRef.current?.getBoundingClientRect();
    if (stage && view) {
      const c = around ?? { x: view.left + view.width / 2, y: view.top + view.height / 2 };
      zoomAnchor.current = { fx: (c.x - stage.left) / stage.width, fy: (c.y - stage.top) / stage.height, cx: c.x, cy: c.y };
    }
    setZoom(next);
  };
  const fitView = () => {
    zoomAnchor.current = null;
    setZoom(fitZoom());
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
  };
  // The plan is fitted to the screen once, when the editor opens; afterwards the zoom is the user's.
  useLayoutEffect(() => {
    setZoom(fitZoom());
  }, []);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const stage = stageRef.current;
    const viewport = viewportRef.current;
    if (!anchor || !stage || !viewport) return;
    zoomAnchor.current = null;
    const box = stage.getBoundingClientRect();
    viewport.scrollLeft += box.left + anchor.fx * box.width - anchor.cx;
    viewport.scrollTop += box.top + anchor.fy * box.height - anchor.cy;
  }, [zoom]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => entry && setStageWidth(entry.contentRect.width));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  /* Selection helpers */

  const selectOnly = (kind: keyof Selection, key: string | number): Selection => ({ ...NO_SELECTION, [kind]: [key] });
  const hitAt = (p: Point): [keyof Selection, string | number] | null => {
    const item = hitItem(layout, height, p);
    if (item) return ["items", item.resourceId];
    const label = hitLabel(layout, height, p);
    if (label !== null) return ["labels", label];
    const area = hitArea(layout, height, p);
    return area !== null ? ["areas", area] : null;
  };
  const includes = (s: Selection, kind: keyof Selection, key: string | number) => (s[kind] as (string | number)[]).includes(key);
  const zoneAt = (p: Point) => {
    const area = hitArea(layout, height, p);
    const zoneId = area === null ? null : layout.areas[area]!.zoneId;
    return zoneId && floor.zones.some((z) => z.id === zoneId) ? zoneId : null;
  };

  /* Adding places: existing unplaced ones first, otherwise new resources through the API */

  const resolveType = async (category: CwCategory): Promise<ResourceType | null> => {
    let types: ResourceType[];
    try {
      types = await client.fetchQuery({ queryKey: CW_KEYS.types, queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
    } catch (error) {
      toast(errorMessage(error), "error");
      return null;
    }
    const matching = types.filter((t) => t.category === category && t.status === "active");
    const remembered = matching.find((t) => t.id === chosenTypes.current.get(category));
    if (remembered) return remembered;
    if (matching.length === 1) return matching[0]!;
    return new Promise((resolve) => setDialog({ kind: "type", category, types: matching, resolve }));
  };

  const placeSlots = (items: PlanItem[]) => {
    commit(addItems(layoutRef.current, items));
    setSelection({ ...NO_SELECTION, items: items.map((i) => i.resourceId) });
  };

  const createAndPlace = async (category: CwCategory, slots: Slot[], capacity: number, zoneId: string | null) => {
    const type = await resolveType(category);
    if (!type) return;
    setWorking(slots.length > 1 ? `Création de ${slots.length} places…` : "Création de la place…");
    const { created, error } = await createResources(
      floor.id,
      slots.map(() => ({ typeId: type.id, category, capacity, zoneId, attributeIds: [] })),
    );
    if (created.length) await client.invalidateQueries({ queryKey: CW_KEYS.all });
    setWorking(null);
    if (created.length) {
      placeSlots(created.map((r, i) => ({ ...slots[i]!, resourceId: r.id })));
      toast(
        created.length === 1
          ? `${categoryWord(category)} ${created[0]!.code} ajouté au plan.`
          : `${created.length} places ajoutées : ${created.map((r) => r.code).join(", ")}.`,
      );
    }
    if (error) toast(errorMessage(error), "error");
  };

  /** A new place takes the size of a place of the same kind already drawn, so a row of desks stays even. */
  const sizeFor = (category: CwCategory) => {
    const model = layout.items.find((i) => resources.get(i.resourceId)?.category === category);
    return model ? { w: model.w, h: model.h } : defaultSize(category, height);
  };

  const placeExisting = (resource: FloorResource, at: Point) => {
    placeSlots([{ ...slotAt(at, height, sizeFor(resource.category)), resourceId: resource.id }]);
    toast(`${resource.code} placé : c'était une place de l'étage qui n'était pas encore sur le plan.`);
  };

  const addTile = (kind: TileKind, dropAt?: Point) => {
    if (working || drawing) return;
    const at = snapPoint(dropAt ?? viewCentre());
    if (kind === "text") {
      if (roomFor(layout, 1, 0)) setDialog({ kind: "label", at });
      else toast(`Un plan compte au plus ${PLAN_LIMITS.labels} textes.`, "error");
      return;
    }
    if (kind === "zone") {
      if (roomFor(layout, 0, 1)) setDialog({ kind: "zone", points: rectPoints(at, height, ZONE_SIZE) });
      else toast(`Un plan compte au plus ${PLAN_LIMITS.areas} surfaces de zone.`, "error");
      return;
    }
    const candidate = unplaced.find((r) => r.category === kind);
    if (candidate) placeExisting(candidate, at);
    else void createAndPlace(kind, [slotAt(at, height, sizeFor(kind))], tileOf(kind).capacity, zoneAt(at));
  };

  const applyTemplate = (template: Template) => {
    if (working) return;
    void createAndPlace(template.category, template.slots(viewCentre(), height), template.capacity, null);
  };

  const placeAll = (group: FloorResource[]) => {
    const category = group[0]!.category;
    const slots = gridSlots(viewCentre(), height, footprint(category), group.length, 6, 8);
    placeSlots(group.map((r, i) => ({ ...slots[i]!, resourceId: r.id })));
  };

  /* Clipboard and actions on the selection */

  const clipOf = (s: Selection, cut: boolean): Clip | null => {
    if (!selectionCount(s)) return null;
    const attributes = new Map((detail.data ?? []).map((r) => [r.id, r.attributeIds]));
    return {
      items: layout.items
        .filter((i) => s.items.includes(i.resourceId) && resources.has(i.resourceId))
        .map((item) => {
          const r = resources.get(item.resourceId)!;
          return { item, spec: { typeId: r.typeId, category: r.category, capacity: r.capacity, zoneId: r.zoneId, attributeIds: attributes.get(r.id) ?? [] } };
        }),
      labels: s.labels.flatMap((i) => (layout.labels[i] ? [layout.labels[i]] : [])),
      areas: s.areas.flatMap((i) => (layout.areas[i] ? [layout.areas[i]] : [])),
      cut,
    };
  };

  const remove = (s: Selection = selection, message?: string) => {
    if (!selectionCount(s)) return;
    const next = removeSelection(layout, s);
    commit(next);
    setSelection(NO_SELECTION);
    const n = selectionCount(s);
    toast(message ?? (n === 1 ? "Élément supprimé du plan." : `${n} éléments supprimés du plan.`), "success", { label: "Annuler", run: () => undoIf(next) });
  };

  const copy = (s: Selection = selection) => {
    const clip = clipOf(s, false);
    if (!clip) return;
    clipRef.current = clip;
    toast(selectionCount(s) === 1 ? "Élément copié. Collez-le avec Coller." : `${selectionCount(s)} éléments copiés. Collez-les avec Coller.`);
  };

  const cut = (s: Selection = selection) => {
    const clip = clipOf(s, true);
    if (!clip) return;
    clipRef.current = clip;
    remove(s, "Coupé : collez pour le remettre ailleurs.");
  };

  const pasteClip = async (clip: Clip, at?: Point) => {
    const current = layoutRef.current;
    if (!roomFor(current, clip.labels.length, clip.areas.length) || current.items.length + clip.items.length > PLAN_LIMITS.items) {
      toast("Le plan est plein : retirez des éléments avant de coller.", "error");
      return;
    }
    const boxes = [
      ...clip.items.map((c) => itemBounds(c.item, height)),
      ...clip.labels.map((l) => labelBox(l, height)),
      ...clip.areas.map((a) => areaBounds(a, height)),
    ];
    const all = unionBox(boxes);
    if (!all) return;
    const offset = at
      ? { x: at.x - (all.x + all.w / 2), y: at.y - (all.y + all.h / 2) }
      : pasteOffset(boxes, otherBoxes(current, height, NO_SELECTION), height, PASTE_GAP, clip.cut);
    const onPlan = new Set(current.items.map((i) => i.resourceId));
    const back = clip.cut ? clip.items.filter((c) => resources.has(c.item.resourceId) && !onPlan.has(c.item.resourceId)) : [];
    const copies = clip.items.filter((c) => !back.includes(c));
    clip.cut = false;
    let created: Resource[] = [];
    if (copies.length) {
      setWorking(copies.length > 1 ? `Création de ${copies.length} places…` : "Création de la place…");
      const result = await createResources(
        floor.id,
        copies.map((c) => c.spec),
      );
      created = result.created;
      if (created.length) await client.invalidateQueries({ queryKey: CW_KEYS.all });
      setWorking(null);
      if (result.error) toast(errorMessage(result.error), "error");
    }
    const items = [
      ...back.map((c) => shiftItem(c.item, height, offset.x, offset.y)),
      ...created.map((r, i) => ({ ...shiftItem(copies[i]!.item, height, offset.x, offset.y), resourceId: r.id })),
    ];
    const latest = layoutRef.current;
    const labels = clip.labels.map((l) => shiftLabel(l, height, offset.x, offset.y));
    const areas = clip.areas.map((a) => shiftArea(a, height, offset.x, offset.y));
    if (!items.length && !labels.length && !areas.length) return;
    commit({ ...addItems(latest, items), labels: [...latest.labels, ...labels], areas: [...latest.areas, ...areas] });
    setSelection({
      items: items.map((i) => i.resourceId),
      labels: labels.map((_, i) => latest.labels.length + i),
      areas: areas.map((_, i) => latest.areas.length + i),
    });
    if (created.length)
      toast(created.length === 1 ? `Nouvelle place ${created[0]!.code} créée.` : `Nouvelles places : ${created.map((r) => r.code).join(", ")}.`);
  };

  const paste = (at?: Point) => {
    if (clipRef.current && !working) void pasteClip(clipRef.current, at);
  };
  const duplicate = (s: Selection = selection) => {
    const clip = clipOf(s, false);
    if (clip && !working) void pasteClip(clip);
  };
  const rotate = (degrees: number, s: Selection = selection) => {
    if (s.items.length) commit(rotateSelection(layout, s, degrees));
  };
  const nudge = (dx: number, dy: number) => commit(moveSelection(layout, height, selection, dx, dy), "nudge");
  const align = (mode: AlignMode) => commit(alignSelection(layout, height, selection, mode));
  const distribute = (axis: "horizontal" | "vertical") => commit(distributeSelection(layout, height, selection, axis));
  const canRename = (s: Selection) => selectionCount(s) === 1 && (s.items.length === 1 || s.labels.length === 1);

  const startDrawing = () => {
    if (layout.areas.length >= PLAN_LIMITS.areas) return toast(`Un plan compte au plus ${PLAN_LIMITS.areas} surfaces de zone.`, "error");
    setSelection(NO_SELECTION);
    setDrawing([]);
  };
  const finishDrawing = () => {
    if (!drawing || drawing.length < 3) return;
    setDialog({ kind: "zone", points: drawing });
    setDrawing(null);
  };

  /* Keyboard */

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || typing(event.target) || menu || tour || document.querySelector(".overlay")) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const handled = () => event.preventDefault();
    if (event.key === "?") return (handled(), setDialog({ kind: "help" }));
    if (event.key === " " && !pressable(event.target)) return (handled(), setPanReady(true));
    if (drawing) {
      if (event.key === "Escape") setDrawing(null);
      else if (event.key === "Enter") finishDrawing();
      else if (event.key === "Backspace" || event.key === "Delete") setDrawing(drawing.slice(0, -1));
      else return;
      return handled();
    }
    if (mod) {
      const actions: Record<string, () => void> = {
        c: () => copy(),
        x: () => cut(),
        v: () => paste(),
        d: () => duplicate(),
        a: () => setSelection(selectAll(layout)),
        z: () => (event.shiftKey ? redo() : undo()),
        y: redo,
      };
      const action = actions[key];
      if (action) {
        handled();
        action();
      }
      return;
    }
    if (event.key === "+" || event.key === "=") return (handled(), zoomTo(zoom * ZOOM_STEP));
    if (event.key === "-") return (handled(), zoomTo(zoom / ZOOM_STEP));
    if (event.key === "Escape") return setSelection(NO_SELECTION);
    if (!count) return;
    const step = (snap ? GRID : 2) * (event.shiftKey ? 5 : 1);
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (move) return (handled(), nudge(move[0], move[1]));
    if (event.key === "Delete" || event.key === "Backspace") return (handled(), remove());
    if (key === "r") return (handled(), rotate(event.shiftKey ? 90 : 15));
  };
  const latest = useRef({ onKey, zoomTo, zoom });
  latest.current = { onKey, zoomTo, zoom };
  useEffect(() => {
    const down = (event: KeyboardEvent) => latest.current.onKey(event);
    const up = (event: KeyboardEvent) => {
      if (event.key === " ") setPanReady(false);
    };
    const blur = () => setPanReady(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      latest.current.zoomTo(latest.current.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), { x: event.clientX, y: event.clientY });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, []);

  /* Pointer */

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || menu) return;
    const client0 = { x: event.clientX, y: event.clientY };
    if (event.button === 1 || (event.button === 0 && panReady)) {
      event.preventDefault();
      dragRef.current = { kind: "pan", startClient: client0, scroll: { x: viewport.scrollLeft, y: viewport.scrollTop } };
      viewport.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const p = toPlan(event.clientX, event.clientY);
    if (!p) return;
    if (drawing) {
      if (drawing.length < PLAN_LIMITS.areaPoints) setDrawing([...drawing, toFractionPoint(snapPoint(insidePlan(p)), height)]);
      return;
    }
    const target = event.target as Element;
    const handle = target.closest("[data-handle]");
    const vertex = target.closest("[data-vertex]");
    let drag: Drag | null = null;
    if (handle && count === 1 && selection.items.length === 1) {
      const corner = CORNERS.find((c) => c.name === handle.getAttribute("data-handle"))!;
      drag = { kind: "resize", id: selection.items[0]!, corner, before: layout };
    } else if (vertex && count === 1 && selection.areas.length === 1) {
      drag = { kind: "vertex", index: selection.areas[0]!, pointIndex: Number(vertex.getAttribute("data-vertex")), before: layout };
    } else {
      const hit = hitAt(p);
      // A zone area is a large background: pressing inside an unselected one starts a rectangle selection, a click selects it.
      if (hit && !(hit[0] === "areas" && !includes(selection, "areas", hit[1]))) {
        const [kind, key] = hit;
        const next = event.shiftKey ? toggleInSelection(selection, kind, key) : includes(selection, kind, key) ? selection : selectOnly(kind, key);
        setSelection(next);
        if (includes(next, kind, key)) {
          drag = {
            kind: "move",
            start: p,
            startClient: client0,
            moved: false,
            before: layout,
            selection: next,
            bounds: unionBox(selectionBoxes(layout, height, next))!,
            others: otherBoxes(layout, height, next),
          };
        }
      } else {
        drag = {
          kind: "marquee",
          start: p,
          startClient: client0,
          moved: false,
          base: event.shiftKey ? selection : NO_SELECTION,
          area: hit ? (hit[1] as number) : null,
          additive: event.shiftKey,
        };
      }
    }
    if (drag) {
      dragRef.current = drag;
      viewport.focus({ preventScroll: true });
      viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "pan") {
      const viewport = viewportRef.current!;
      viewport.scrollLeft = drag.scroll.x - (event.clientX - drag.startClient.x);
      viewport.scrollTop = drag.scroll.y - (event.clientY - drag.startClient.y);
      return;
    }
    const p = toPlan(event.clientX, event.clientY);
    if (!p) return;
    if ((drag.kind === "move" || drag.kind === "marquee") && !drag.moved) {
      if (Math.hypot(event.clientX - drag.startClient.x, event.clientY - drag.startClient.y) < DRAG_START_PX) return;
      drag.moved = true;
    }
    if (drag.kind === "move") {
      const raw = { x: p.x - drag.start.x, y: p.y - drag.start.y };
      const moving = { ...drag.bounds, x: drag.bounds.x + raw.x, y: drag.bounds.y + raw.y };
      const snap0 = event.altKey ? { dx: 0, dy: 0, guides: [] } : snapMove(moving, drag.others, SNAP_PX * unitsPerPx);
      let dx = raw.x + snap0.dx;
      let dy = raw.y + snap0.dy;
      const snappedX = snap0.guides.some((g) => g.axis === "x");
      const snappedY = snap0.guides.some((g) => g.axis === "y");
      if (snap && !snappedX) dx = snapTo(drag.bounds.x + dx, GRID) - drag.bounds.x;
      if (snap && !snappedY) dy = snapTo(drag.bounds.y + dy, GRID) - drag.bounds.y;
      setGuides(snap0.guides);
      preview(moveSelection(drag.before, height, drag.selection, dx, dy));
    } else if (drag.kind === "marquee") {
      const rect = rectBetween(drag.start, p);
      setMarquee(rect);
      const inside = selectInRect(layout, height, rect);
      setSelection(
        drag.additive
          ? {
              items: [...new Set([...drag.base.items, ...inside.items])],
              labels: [...new Set([...drag.base.labels, ...inside.labels])],
              areas: [...new Set([...drag.base.areas, ...inside.areas])],
            }
          : inside,
      );
    } else if (drag.kind === "resize") {
      preview(resizeItem(drag.before, height, drag.id, drag.corner, snapPoint(insidePlan(p))));
    } else {
      preview(moveAreaPoint(drag.before, height, drag.index, drag.pointIndex, snapPoint(insidePlan(p))));
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (drag.kind === "marquee") {
      setMarquee(null);
      if (!drag.moved) {
        if (drag.area !== null) setSelection(drag.additive ? toggleInSelection(selection, "areas", drag.area) : selectOnly("areas", drag.area));
        else if (!drag.additive) setSelection(NO_SELECTION);
      }
      return;
    }
    setGuides([]);
    if (drag.kind !== "pan") finishDrag(drag.before);
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const p = toPlan(event.clientX, event.clientY);
    const hit = p ? hitAt(p) : null;
    if (!hit || hit[0] === "areas") return;
    setSelection(selectOnly(hit[0], hit[1]));
    setRenaming(true);
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (drawing) return;
    const p = toPlan(event.clientX, event.clientY);
    if (!p) return;
    const hit = hitAt(p);
    const s = hit && !includes(selection, hit[0], hit[1]) ? selectOnly(hit[0], hit[1]) : hit || count ? selection : NO_SELECTION;
    setSelection(s);
    const has = selectionCount(s) > 0;
    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { label: "Copier", keys: [MOD_KEY, "C"], disabled: !has, run: () => copy(s) },
        { label: "Couper", keys: [MOD_KEY, "X"], disabled: !has, run: () => cut(s) },
        { label: "Coller ici", keys: [MOD_KEY, "V"], disabled: !clipRef.current || !!working, run: () => paste(insidePlan(p)) },
        { label: "Dupliquer", keys: [MOD_KEY, "D"], disabled: !has || !!working, run: () => duplicate(s) },
        { label: "Pivoter d'un quart de tour", keys: ["Maj", "R"], disabled: !s.items.length, run: () => rotate(90, s) },
        { label: "Renommer", disabled: !canRename(s), run: () => setRenaming(true) },
        { label: "Supprimer du plan", keys: ["Suppr"], danger: true, disabled: !has, run: () => remove(s) },
      ],
    });
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(TILE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const kind = event.dataTransfer.getData(TILE_DRAG_TYPE) as TileKind;
    if (!TILES.some((t) => t.kind === kind)) return;
    event.preventDefault();
    const p = toPlan(event.clientX, event.clientY);
    addTile(kind, p ? insidePlan(p) : undefined);
  };

  /* Drawing */

  const appearance = (resourceId: string): ResourceAppearance => {
    const r = resources.get(resourceId);
    if (!r) return { label: "?", title: "Place archivée ou d'un autre étage", state: "blocked" };
    return {
      label: r.code,
      title: `${r.code}${r.name ? ` ${r.name}` : ""}, ${r.typeName}${r.status === "out_of_service" ? ", hors service" : ""}`,
      state: r.status === "out_of_service" ? "blocked" : "free",
      category: r.category,
      capacity: r.capacity,
    };
  };

  const pad = 4 * unitsPerPx;
  const handle = HANDLE_PX * unitsPerPx;
  const selectedItems = layout.items.filter((i) => selection.items.includes(i.resourceId));
  const singleArea = count === 1 && selection.areas.length === 1 ? layout.areas[selection.areas[0]!] : undefined;
  const overlay = (
    <>
      {snap ? (
        <>
          <defs>
            <pattern id="fpe-grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
              <path d={`M ${GRID} 0 L 0 0 0 ${GRID}`} className="fpe-grid" />
            </pattern>
          </defs>
          <rect x={0} y={0} width={PLAN_WIDTH} height={height} fill="url(#fpe-grid)" pointerEvents="none" />
        </>
      ) : null}
      {selection.areas.map((index) => {
        const area = layout.areas[index];
        return area ? (
          <polygon
            key={`a-${index}`}
            className="fpe-outline"
            points={areaPoints(area, height)
              .map((pt) => `${pt.x},${pt.y}`)
              .join(" ")}
          />
        ) : null;
      })}
      {selectedItems.map((item) => {
        const { cx, cy, w, h } = itemBox(item, height);
        return (
          <g key={item.resourceId} transform={`rotate(${item.rotation} ${cx} ${cy})`}>
            <rect className="fpe-outline" x={cx - w / 2 - pad} y={cy - h / 2 - pad} width={w + 2 * pad} height={h + 2 * pad} />
            {count === 1
              ? CORNERS.map((c) => (
                  <rect
                    key={c.name}
                    data-handle={c.name}
                    className="fpe-handle"
                    x={cx + (c.sx * w) / 2 - handle / 2}
                    y={cy + (c.sy * h) / 2 - handle / 2}
                    width={handle}
                    height={handle}
                    rx={handle / 4}
                  />
                ))
              : null}
          </g>
        );
      })}
      {selection.labels.map((index) => {
        const label = layout.labels[index];
        if (!label) return null;
        const b = labelBox(label, height);
        return <rect key={`l-${index}`} className="fpe-outline" x={b.x - pad} y={b.y - pad} width={b.w + 2 * pad} height={b.h + 2 * pad} />;
      })}
      {singleArea
        ? areaPoints(singleArea, height).map((pt, i) => <circle key={i} data-vertex={i} className="fpe-handle fpe-vertex" cx={pt.x} cy={pt.y} r={handle / 2} />)
        : null}
      {guides.map((g, i) =>
        g.axis === "x" ? (
          <line key={i} className="fpe-guide" x1={g.at} x2={g.at} y1={g.from - 20} y2={g.to + 20} />
        ) : (
          <line key={i} className="fpe-guide" y1={g.at} y2={g.at} x1={g.from - 20} x2={g.to + 20} />
        ),
      )}
      {marquee ? <rect className="fpe-marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} /> : null}
      {drawing ? (
        <g pointerEvents="none">
          <polyline className="fpe-draft" points={drawing.map(([x, y]) => `${x * PLAN_WIDTH},${y * height}`).join(" ")} />
          {drawing.map(([x, y], i) => (
            <circle key={i} className="fpe-handle" cx={x * PLAN_WIDTH} cy={y * height} r={(i === 0 ? 8 : 5) * unitsPerPx} />
          ))}
        </g>
      ) : null}
    </>
  );

  const saveStatus = failed ? (
    <span className="fpe-status err" role="status">
      L'enregistrement a échoué
      <button type="button" className="btn" onClick={() => save.mutate(layoutRef.current)}>
        Réessayer
      </button>
    </span>
  ) : pending && issues.length ? (
    <span className="fpe-status warn" role="status">
      Non enregistré : un point est à corriger
    </span>
  ) : pending || save.isPending ? (
    <span className="fpe-status" role="status">
      <span className="spinner" aria-hidden="true" />
      Enregistrement…
    </span>
  ) : (
    <span className="fpe-status ok" role="status">
      <Icon name="check" />
      Modifications enregistrées
    </span>
  );

  const tourSteps: TourStep[] = [
    {
      target: () => paletteRef.current,
      title: "1. Ajoutez des éléments",
      text: "Faites glisser un poste, une salle ou un bureau de cette colonne jusque sur le plan. Un simple clic le pose au milieu du plan.",
    },
    {
      target: () => viewportRef.current,
      title: "2. Arrangez le plan",
      text: "Déplacez les éléments à la souris. Cliquez sur un élément pour voir et modifier ses informations à droite. Le bouton « Aide » liste les raccourcis.",
    },
    {
      target: () => publishRef.current,
      title: "3. Publiez quand c'est prêt",
      text: "Vos changements sont enregistrés tout seuls. Les clients ne voient le nouveau plan qu'après avoir cliqué sur « Publier ».",
    },
  ];

  const busy = !!working || !!drawing;
  const empty = !layout.items.length && !layout.labels.length && !layout.areas.length;

  return (
    <div className="fpe-root">
      <header className="fpe-head">
        <button type="button" className="btn" onClick={() => void quit()}>
          <Icon name="quit" />
          Quitter
        </button>
        <div className="fpe-title">
          <h1 className="h1">{floor.name}</h1>
          <span className="cap">Plan de l'étage</span>
        </div>
        {saveStatus}
        {unpublished ? <Badge tone="amber">Non publié</Badge> : floor.layoutPublishedAt ? <Badge tone="green">Publié</Badge> : null}
        <span className="fpe-grow" />
        <button type="button" className="btn fpe-help-btn" onClick={() => setDialog({ kind: "help" })}>
          <span className="fpe-round" aria-hidden="true">
            ?
          </span>
          Aide
        </button>
        <button
          ref={moreRef}
          type="button"
          className="btn"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={() => {
            const box = moreRef.current!.getBoundingClientRect();
            setMenu({
              x: box.right - 280,
              y: box.bottom + 6,
              entries: [
                { label: "Image du plan et proportions", run: () => setDialog({ kind: "settings" }) },
                {
                  label: "Abandonner le brouillon",
                  danger: true,
                  disabled: (!hasDraft && !unpublished) || save.isPending,
                  run: () => setDialog({ kind: "discard" }),
                },
              ],
            });
          }}
        >
          <Icon name="more" />
          Plus
        </button>
        <button
          ref={publishRef}
          type="button"
          className="btn btn-p fpe-publish"
          disabled={!unpublished || issues.length > 0 || publish.isPending}
          title={unpublished ? undefined : "Le plan publié est déjà à jour."}
          onClick={() => setDialog({ kind: "publish" })}
        >
          Publier
        </button>
      </header>
      <div className="fpe-body">
        <aside ref={paletteRef} className="fpe-left" aria-label="Éléments à ajouter">
          <Palette
            unplaced={unplaced}
            disabled={busy}
            onTile={(kind) => addTile(kind)}
            onPlace={(r) => placeExisting(r, snapPoint(viewCentre()))}
            onPlaceAll={placeAll}
            onDrawZone={startDrawing}
          />
        </aside>
        <section className="fpe-main" aria-label="Plan">
          <div className="fpe-toolbar">
            <button type="button" className="btn" disabled={!history.past.length} onClick={undo}>
              <Icon name="undo" />
              Annuler
            </button>
            <button type="button" className="btn" disabled={!history.future.length} onClick={redo}>
              <Icon name="redo" />
              Rétablir
            </button>
            <span className="fpe-sep" />
            <button type="button" className="btn" aria-label="Réduire le zoom" onClick={() => zoomTo(zoom / ZOOM_STEP)}>
              Zoom −
            </button>
            <span className="fpe-zoom">{Math.round(zoom * 100)} %</span>
            <button type="button" className="btn" aria-label="Agrandir le zoom" onClick={() => zoomTo(zoom * ZOOM_STEP)}>
              Zoom +
            </button>
            <button type="button" className="btn" onClick={fitView}>
              <Icon name="fit" />
              Ajuster
            </button>
            <span className="fpe-sep" />
            <label className="fpe-toggle">
              <input type="checkbox" className="chk" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
              Grille magnétique
            </label>
            {working ? (
              <span className="fpe-working" role="status">
                <span className="spinner" aria-hidden="true" />
                {working}
              </span>
            ) : null}
          </div>
          {issues.length ? (
            <div className="ban ban-amber fpe-ban" role="alert">
              <strong>À corriger avant l'enregistrement</strong>
              <ul>
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              {layout.items.some((i) => !resources.has(i.resourceId)) ? (
                <button type="button" className="btn" onClick={() => commit({ ...layout, items: layout.items.filter((i) => resources.has(i.resourceId)) })}>
                  Supprimer ces places du plan
                </button>
              ) : null}
            </div>
          ) : null}
          {apiError ? (
            <div className="fpe-ban stack" style={{ gap: 8 }}>
              <ErrorBanner error={apiError} {...(failed ? { retry: () => save.mutate(layoutRef.current) } : {})} />
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
          {drawing ? (
            <div className="ban ban-blue fpe-ban">
              <span>
                Cliquez sur le plan pour poser les coins de la zone ({drawing.length} posé{drawing.length > 1 ? "s" : ""}, 3 au minimum).
              </span>
              <button type="button" className="btn" disabled={!drawing.length} onClick={() => setDrawing(drawing.slice(0, -1))}>
                Retirer le dernier point
              </button>
              <button type="button" className="btn" onClick={() => setDrawing(null)}>
                Abandonner
              </button>
              <button type="button" className="btn btn-p" disabled={drawing.length < 3} onClick={finishDrawing}>
                Terminer la zone
              </button>
            </div>
          ) : null}
          <div className="fpe-canvas" onDragOver={onDragOver} onDrop={onDrop}>
            <div
              ref={viewportRef}
              className={`fpe-viewport${drawing ? " drawing" : ""}${panReady ? " panning" : ""}`}
              tabIndex={0}
              role="application"
              aria-label={`Plan de ${floor.name} en cours de modification. Appuyez sur ? pour la liste des raccourcis.`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
            >
              <div ref={stageRef} className="fpe-stage" style={{ width: `${zoom * 100}%` }}>
                <FloorPlanView
                  layout={layout}
                  image={image}
                  appearance={appearance}
                  zones={floor.zones}
                  selectedId={count === 1 && selection.items.length === 1 ? selection.items[0] : null}
                  onSelect={(resourceId) => {
                    if (!suppressClick.current) setSelection(selectOnly("items", resourceId));
                  }}
                  title={`Plan de ${floor.name}`}
                  overlay={overlay}
                />
              </div>
            </div>
            {empty && !drawing ? <EmptyPlanCard disabled={!!working} onTemplate={applyTemplate} /> : null}
          </div>
        </section>
        <aside className="fpe-right" aria-label="Élément sélectionné">
          <SelectionPanel
            floor={floor}
            layout={layout}
            selection={selection}
            resources={resources}
            unplaced={unplaced.length}
            renaming={renaming}
            onRenamed={() => setRenaming(false)}
            canDuplicate={!working}
            actions={{ rotate: () => rotate(90), duplicate: () => duplicate(), copy: () => copy(), remove: () => remove(), align, distribute }}
            onLayout={commit}
          />
        </aside>
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} /> : null}
      {dialog?.kind === "label" ? (
        <LabelDialog
          onClose={() => setDialog(null)}
          onAdd={(text, size) => {
            const current = layoutRef.current;
            commit({ ...current, labels: [...current.labels, { text, size, x: dialog.at.x / PLAN_WIDTH, y: dialog.at.y / height }] });
            setSelection(selectOnly("labels", current.labels.length));
          }}
        />
      ) : null}
      {dialog?.kind === "zone" ? (
        <ZoneChoiceDialog
          floor={floor}
          onClose={() => setDialog(null)}
          onChoose={(zoneId) => {
            const current = layoutRef.current;
            commit({ ...current, areas: [...current.areas, { zoneId, points: dialog.points }] });
            setSelection(selectOnly("areas", current.areas.length));
          }}
        />
      ) : null}
      {dialog?.kind === "type" ? (
        <TypeDialog
          category={dialog.category}
          word={categoryWord(dialog.category)}
          types={dialog.types}
          onChoose={(type) => {
            chosenTypes.current.set(dialog.category, type.id);
            setDialog(null);
            dialog.resolve(type);
          }}
          onClose={() => {
            setDialog(null);
            dialog.resolve(null);
          }}
        />
      ) : null}
      {dialog?.kind === "publish" ? (
        <PublishDialog
          layout={layout}
          unplaced={unplaced.length}
          pending={publish.isPending}
          error={publish.error}
          onPublish={() => publish.mutate({ snapshot: layoutRef.current, mustSave: pending || !hasDraft })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "discard" ? (
        <DiscardDialog pending={discard.isPending} error={discard.error} onDiscard={() => discard.mutate()} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "settings" ? (
        <PlanSettingsDialog
          floor={floor}
          aspect={image ? null : layout.aspect}
          onAspect={(value) => commit({ ...layout, aspect: value })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "help" ? <ShortcutsDialog onClose={() => setDialog(null)} /> : null}
      {tour && !dialog ? <Tour steps={tourSteps} onDone={() => setTour(false)} /> : null}
      {blocker.state === "blocked" ? (
        <Modal
          title="Des changements ne sont pas enregistrés"
          onClose={() => blocker.reset()}
          footer={
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-p" onClick={() => blocker.reset()}>
                  Rester sur le plan
                </button>
                <button type="button" className="btn btn-d" onClick={() => blocker.proceed()}>
                  Quitter quand même
                </button>
              </div>
            </>
          }
        >
          <p>
            {failed || issues.length
              ? "Les dernières modifications n'ont pas pu être enregistrées. Si vous quittez maintenant, elles seront perdues."
              : "L'enregistrement des dernières modifications est en cours. Patientez une seconde avant de quitter."}
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
