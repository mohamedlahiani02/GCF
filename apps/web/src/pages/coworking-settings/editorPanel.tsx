import { CW_CATEGORIES, type FloorLayout, type PlanItem, type PlanLabel } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, ErrorBanner, Field, Segmented } from "../../components/ui";
import { CW_KEYS, type Attribute, type FloorDetail, type FloorResource, type Resource, type ResourceType } from "./api";
import { TILES } from "./editorPalette";
import { parseInteger } from "./helpers";
import type { AlignMode, Selection } from "./layoutOps";

export interface PanelActions {
  rotate: () => void;
  duplicate: () => void;
  copy: () => void;
  remove: () => void;
  align: (mode: AlignMode) => void;
  distribute: (axis: "horizontal" | "vertical") => void;
}

const ICON_PATHS = {
  rotate: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  duplicate: "M8 8h12v12H8zM4 16V4h12",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  remove: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  left: "M4 3v18M8 7h12v4H8zM8 14h7v4H8z",
  center: "M12 3v18M6 7h12v4H6zM8.5 14h7v4h-7z",
  right: "M20 3v18M4 7h12v4H4zM9 14h7v4H9z",
  top: "M3 4h18M7 8h4v12H7zM14 8h4v7h-4z",
  middle: "M3 12h18M7 6h4v12H7zM14 8.5h4v7h-4z",
  bottom: "M3 20h18M7 4h4v12H7zM14 9h4v7h-4z",
  horizontal: "M3 4v16M21 4v16M8 8h3v8H8zM13 8h3v8h-3z",
  vertical: "M4 3h16M4 21h16M8 8h8v3H8zM8 13h8v3H8z",
};

function ActionIcon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: keyof typeof ICON_PATHS;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button type="button" className={`btn fpe-action${danger ? " btn-d" : ""}`} disabled={disabled} onClick={onClick}>
      <ActionIcon name={icon} />
      {label}
    </button>
  );
}

const ALIGN: { mode: AlignMode; label: string }[] = [
  { mode: "left", label: "À gauche" },
  { mode: "center", label: "Au centre" },
  { mode: "right", label: "À droite" },
  { mode: "top", label: "En haut" },
  { mode: "middle", label: "Au milieu" },
  { mode: "bottom", label: "En bas" },
];

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** The plain word of a category, as on the palette tiles. */
export const categoryWord = (category: FloorResource["category"]) => TILES.find((t) => t.kind === category)!.word;

/** Code, name, type, seats, zone and equipment of one place, saved together with one button. */
function ResourceForm({ resource, floor, renaming, onRenamed }: { resource: FloorResource; floor: FloorDetail; renaming: boolean; onRenamed: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const codeRef = useRef<HTMLInputElement>(null);
  const types = useQuery({ queryKey: CW_KEYS.types, queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
  const attributes = useQuery({ queryKey: CW_KEYS.attributes, queryFn: () => api.get<Attribute[]>("/coworking/attributes") });
  const detail = useQuery({
    queryKey: CW_KEYS.floorResources(floor.id),
    queryFn: () => api.get<Resource[]>("/coworking/resources", { floorId: floor.id }),
  });
  const savedAttributes = detail.data?.find((r) => r.id === resource.id)?.attributeIds ?? [];
  const [code, setCode] = useState(resource.code);
  const [name, setName] = useState(resource.name ?? "");
  const [capacity, setCapacity] = useState(String(resource.capacity));
  const [typeId, setTypeId] = useState(resource.typeId);
  const [zoneId, setZoneId] = useState(resource.zoneId ?? "");
  const [attributeIds, setAttributeIds] = useState<string[] | null>(null);
  const chosenAttributes = attributeIds ?? savedAttributes;
  const capacityValue = parseInteger(capacity, 1, 500);
  const changed =
    code.trim() !== resource.code ||
    name.trim() !== (resource.name ?? "") ||
    capacityValue !== resource.capacity ||
    typeId !== resource.typeId ||
    zoneId !== (resource.zoneId ?? "") ||
    (attributeIds !== null && [...attributeIds].sort().join() !== [...savedAttributes].sort().join());
  useEffect(() => {
    if (!renaming) return;
    codeRef.current?.focus();
    codeRef.current?.select();
    onRenamed();
  }, [renaming, onRenamed]);
  const save = useMutation({
    mutationFn: () =>
      api.patch<Resource>(`/coworking/resources/${resource.id}`, {
        code: code.trim(),
        name: name.trim(),
        capacity: capacityValue,
        zoneId: zoneId || null,
        ...(typeId !== resource.typeId ? { typeId } : {}),
        ...(attributeIds !== null ? { attributeIds } : {}),
      }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      setAttributeIds(null);
      toast(`${saved.code} enregistré.`);
    },
  });
  const sameCategory = (types.data ?? []).filter((t) => t.category === resource.category || t.id === resource.typeId);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && code.trim() && capacityValue !== null) save.mutate();
      }}
    >
      <div className="grid2">
        <Field label="Code sur le plan">
          <input ref={codeRef} className="input" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Places assises" error={capacityValue === null ? "De 1 à 500." : null}>
          <input className="input num" type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
      </div>
      <Field label="Nom (facultatif)" hint="Par exemple : Salle Carthage.">
        <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type" hint={typeId !== resource.typeId ? "Possible seulement sans réservation à venir ni abonnement en cours." : undefined}>
        <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {sameCategory.length ? null : <option value={resource.typeId}>{resource.typeName}</option>}
          {sameCategory.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Zone">
        <select className="input" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
          <option value="">Aucune zone</option>
          {floor.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="fpe-fieldset">
        <legend className="lab">Équipements</legend>
        {attributes.data?.length ? (
          <div className="stack" style={{ gap: 4 }}>
            {attributes.data.map((a) => (
              <label key={a.id} className="fpe-check">
                <input
                  type="checkbox"
                  className="chk"
                  checked={chosenAttributes.includes(a.id)}
                  onChange={(e) => setAttributeIds(e.target.checked ? [...chosenAttributes, a.id] : chosenAttributes.filter((x) => x !== a.id))}
                />
                {a.name}
              </label>
            ))}
          </div>
        ) : (
          <span className="cap">Aucun équipement défini (onglet « Attributs »).</span>
        )}
      </fieldset>
      <button type="submit" className="btn btn-p" disabled={!changed || !code.trim() || capacityValue === null || save.isPending}>
        {save.isPending ? "Enregistrement…" : "Enregistrer ces informations"}
      </button>
      <ErrorBanner error={save.error ?? types.error ?? attributes.error ?? detail.error} />
    </form>
  );
}

function Actions({ actions, canRotate, canDuplicate }: { actions: PanelActions; canRotate: boolean; canDuplicate: boolean }) {
  return (
    <div className="fpe-actions">
      <ActionButton icon="rotate" label="Pivoter" disabled={!canRotate} onClick={actions.rotate} />
      <ActionButton icon="duplicate" label="Dupliquer" disabled={!canDuplicate} onClick={actions.duplicate} />
      <ActionButton icon="copy" label="Copier" onClick={actions.copy} />
      <ActionButton icon="remove" label="Supprimer du plan" danger onClick={actions.remove} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fpe-section">
      <h2 className="h2">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Right column: only what is selected, in plain words, with large buttons. Nothing selected: a short help and a
 * summary of the floor.
 */
export function SelectionPanel({
  floor,
  layout,
  selection,
  resources,
  unplaced,
  renaming,
  onRenamed,
  canDuplicate,
  actions,
  onLayout,
}: {
  floor: FloorDetail;
  layout: FloorLayout;
  selection: Selection;
  resources: Map<string, FloorResource>;
  unplaced: number;
  /** Set by a double-click or the Renommer menu entry: the name field takes the focus, then the flag is cleared. */
  renaming: boolean;
  onRenamed: () => void;
  canDuplicate: boolean;
  actions: PanelActions;
  onLayout: (next: FloorLayout, key?: string) => void;
}) {
  const count = selection.items.length + selection.labels.length + selection.areas.length;
  const items = layout.items.filter((i) => selection.items.includes(i.resourceId));
  const textRef = useRef<HTMLInputElement>(null);
  const labelSelected = count === 1 && selection.labels.length === 1;
  useEffect(() => {
    if (!renaming || !labelSelected) return;
    textRef.current?.focus();
    textRef.current?.select();
    onRenamed();
  }, [renaming, labelSelected, onRenamed]);

  if (count === 0) {
    const placed = layout.items.map((i) => resources.get(i.resourceId)).filter((r): r is FloorResource => !!r);
    return (
      <>
        <Section title="Comment faire">
          <ul className="fpe-steps">
            <li>Faites glisser un élément de la colonne de gauche sur le plan.</li>
            <li>Cliquez sur un élément du plan pour le modifier ici.</li>
            <li>Vos changements sont enregistrés tout seuls. Cliquez sur « Publier » quand le plan est prêt pour les clients.</li>
          </ul>
        </Section>
        <Section title={`Étage ${floor.name}`}>
          <ul className="fpe-facts">
            {CW_CATEGORIES.map((category) => {
              const n = placed.filter((r) => r.category === category).length;
              return n ? (
                <li key={category}>
                  {categoryWord(category)} : {n}
                </li>
              ) : null;
            })}
            <li>{plural(layout.items.length, "place sur le plan", "places sur le plan")}</li>
            {unplaced ? <li>{plural(unplaced, "place à placer", "places à placer")}</li> : null}
            <li>
              {plural(layout.areas.length, "zone dessinée", "zones dessinées")}, {plural(layout.labels.length, "texte", "textes")}
            </li>
          </ul>
        </Section>
      </>
    );
  }

  if (count === 1 && items.length === 1) {
    const item = items[0]!;
    const resource = resources.get(item.resourceId);
    return (
      <>
        <Section title={resource ? `${categoryWord(resource.category)} ${resource.code}` : "Place inconnue"}>
          {resource ? (
            <div className="row center" style={{ gap: 8 }}>
              <span className="cap">{resource.typeName}</span>
              {resource.status === "out_of_service" ? <Badge tone="gray">Hors service</Badge> : null}
            </div>
          ) : (
            <span className="err-text">Cette place est archivée ou rattachée à un autre étage : supprimez-la du plan.</span>
          )}
          <Actions actions={actions} canRotate canDuplicate={canDuplicate && !!resource} />
          <ItemShape item={item} onLayout={(next) => onLayout(next)} layout={layout} />
        </Section>
        {resource ? (
          <Section title="Informations">
            <ResourceForm key={resource.id} resource={resource} floor={floor} renaming={renaming} onRenamed={onRenamed} />
          </Section>
        ) : null}
      </>
    );
  }

  if (count === 1 && selection.labels.length === 1) {
    const index = selection.labels[0]!;
    const label = layout.labels[index]!;
    const setLabel = (change: Partial<PlanLabel>, key?: string) =>
      onLayout({ ...layout, labels: layout.labels.map((l, i) => (i === index ? { ...l, ...change } : l)) }, key);
    return (
      <Section title="Texte">
        <Field label="Texte affiché" error={label.text.trim() ? null : "Écrivez au moins un caractère."}>
          <input ref={textRef} className="input" value={label.text} maxLength={60} onChange={(e) => setLabel({ text: e.target.value }, `label-${index}`)} />
        </Field>
        <div className="stack" style={{ gap: 6 }}>
          <span className="lab">Taille</span>
          <Segmented<PlanLabel["size"]>
            label="Taille du texte"
            value={label.size}
            onChange={(size) => setLabel({ size })}
            options={[
              { value: "s", label: "Petit" },
              { value: "m", label: "Moyen" },
              { value: "l", label: "Grand" },
            ]}
          />
        </div>
        <Actions actions={actions} canRotate={false} canDuplicate={canDuplicate} />
      </Section>
    );
  }

  if (count === 1 && selection.areas.length === 1) {
    const index = selection.areas[0]!;
    const area = layout.areas[index]!;
    return (
      <Section title="Zone">
        <Field label="Cette surface appartient à la zone">
          <select
            className="input"
            value={area.zoneId}
            onChange={(e) => onLayout({ ...layout, areas: layout.areas.map((a, i) => (i === index ? { ...a, zoneId: e.target.value } : a)) })}
          >
            {floor.zones.some((z) => z.id === area.zoneId) ? null : <option value={area.zoneId}>Zone archivée</option>}
            {floor.zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="cap">Faites glisser les ronds aux coins pour changer la forme, ou la surface entière pour la déplacer.</p>
        <Actions actions={actions} canRotate={false} canDuplicate={canDuplicate} />
      </Section>
    );
  }

  const parts = [
    selection.items.length ? plural(selection.items.length, "place", "places") : null,
    selection.labels.length ? plural(selection.labels.length, "texte", "textes") : null,
    selection.areas.length ? plural(selection.areas.length, "zone", "zones") : null,
  ].filter(Boolean);
  return (
    <>
      <Section title={`${count} éléments sélectionnés`}>
        <p className="cap">{parts.join(", ")}. Maj + clic ajoute ou retire un élément.</p>
        <Actions actions={actions} canRotate={selection.items.length > 0} canDuplicate={canDuplicate} />
      </Section>
      <Section title="Aligner">
        <div className="fpe-align">
          {ALIGN.map((a) => (
            <button key={a.mode} type="button" className="btn fpe-action" onClick={() => actions.align(a.mode)}>
              <ActionIcon name={a.mode} />
              {a.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Répartir à égale distance">
        <div className="fpe-align fpe-align-2">
          <button type="button" className="btn fpe-action" disabled={count < 3} onClick={() => actions.distribute("horizontal")}>
            <ActionIcon name="horizontal" />
            De gauche à droite
          </button>
          <button type="button" className="btn fpe-action" disabled={count < 3} onClick={() => actions.distribute("vertical")}>
            <ActionIcon name="vertical" />
            De haut en bas
          </button>
        </div>
        {count < 3 ? <p className="cap">Sélectionnez au moins 3 éléments pour les répartir.</p> : null}
      </Section>
    </>
  );
}

/** Shape and orientation of one placed resource. */
function ItemShape({ item, layout, onLayout }: { item: PlanItem; layout: FloorLayout; onLayout: (next: FloorLayout) => void }) {
  const set = (change: Partial<PlanItem>) =>
    onLayout({ ...layout, items: layout.items.map((i) => (i.resourceId === item.resourceId ? { ...i, ...change } : i)) });
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="lab">Forme</span>
      <Segmented<PlanItem["shape"]>
        label="Forme"
        value={item.shape}
        onChange={(shape) => set({ shape })}
        options={[
          { value: "rect", label: "Rectangle" },
          { value: "ellipse", label: "Arrondie" },
        ]}
      />
      <div className="row center between" style={{ gap: 8 }}>
        <span className="cap">Orientation : {item.rotation}°</span>
        {item.rotation ? (
          <button type="button" className="btn btn-g" onClick={() => set({ rotation: 0 })}>
            Remettre droit
          </button>
        ) : null}
      </div>
    </div>
  );
}
