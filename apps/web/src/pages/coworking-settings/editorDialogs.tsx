import { CW_CATEGORY_LABELS, type PlanLabel } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { ErrorBanner, Field, Modal, Segmented } from "../../components/ui";
import { CW_KEYS, type FloorDetail, type FloorResource, type Resource, type ResourceType, type Zone } from "./api";
import { parseInteger } from "./helpers";

function Footer({ onClose, label, disabled, onConfirm }: { onClose: () => void; label: string; disabled: boolean; onConfirm: () => void }) {
  return (
    <>
      <span />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="btn btn-p" disabled={disabled} onClick={onConfirm}>
          {label}
        </button>
      </div>
    </>
  );
}

/** Places several unplaced resources of one type in a straight row, in code order. */
export function RowDialog({
  unplaced,
  onPlace,
  onClose,
}: {
  unplaced: FloorResource[];
  onPlace: (resourceIds: string[], direction: "horizontal" | "vertical", gap: number) => void;
  onClose: () => void;
}) {
  const types = [...new Map(unplaced.map((r) => [r.typeId, r.typeName])).entries()];
  const [typeId, setTypeId] = useState(types[0]?.[0] ?? "");
  const candidates = unplaced.filter((r) => r.typeId === typeId);
  const [count, setCount] = useState(String(Math.min(4, candidates.length || 1)));
  const [direction, setDirection] = useState<"horizontal" | "vertical">("horizontal");
  const [gap, setGap] = useState("8");
  const n = parseInteger(count, 1, candidates.length);
  const gapValue = parseInteger(gap, 0, 200);
  const chosen = n === null ? [] : candidates.slice(0, n);
  return (
    <Modal
      title="Placer une rangée"
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          label="Placer la rangée"
          disabled={n === null || gapValue === null}
          onConfirm={() => {
            onPlace(
              chosen.map((r) => r.id),
              direction,
              gapValue!,
            );
            onClose();
          }}
        />
      }
    >
      <Field label="Type de ressource">
        <select
          className="input"
          value={typeId}
          onChange={(e) => {
            setTypeId(e.target.value);
            setCount(String(Math.min(4, unplaced.filter((r) => r.typeId === e.target.value).length)));
          }}
        >
          {types.map(([id, name]) => (
            <option key={id} value={id}>
              {name} ({unplaced.filter((r) => r.typeId === id).length} à placer)
            </option>
          ))}
        </select>
      </Field>
      <div className="grid2">
        <Field label="Nombre de ressources" error={n === null ? `Entre 1 et ${candidates.length}.` : null}>
          <input className="input num" type="number" min={1} max={candidates.length} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Espacement" hint="En points du plan (le plan fait 1000 points de large)." error={gapValue === null ? "Entre 0 et 200." : null}>
          <input className="input num" type="number" min={0} max={200} value={gap} onChange={(e) => setGap(e.target.value)} />
        </Field>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Orientation</span>
        <Segmented
          label="Orientation de la rangée"
          value={direction}
          onChange={setDirection}
          options={[
            { value: "horizontal", label: "Horizontale" },
            { value: "vertical", label: "Verticale" },
          ]}
        />
      </div>
      {chosen.length ? (
        <span className="cap">
          Ressources placées : {chosen.map((r) => r.code).join(", ")}. La rangée apparaît au centre du plan, sélectionnée : faites-la glisser à sa place.
        </span>
      ) : null}
    </Modal>
  );
}

/** Adds a text label (room name, exit, kitchen) at the centre of the plan. */
export function LabelDialog({ onAdd, onClose }: { onAdd: (text: string, size: PlanLabel["size"]) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [size, setSize] = useState<PlanLabel["size"]>("m");
  return (
    <Modal
      title="Ajouter un texte"
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          label="Ajouter"
          disabled={!text.trim()}
          onConfirm={() => {
            onAdd(text.trim(), size);
            onClose();
          }}
        />
      }
    >
      <Field label="Texte *" hint="60 caractères au plus. Par exemple : Accueil, Cuisine, Sortie de secours.">
        <input className="input" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Taille</span>
        <Segmented
          label="Taille du texte"
          value={size}
          onChange={setSize}
          options={[
            { value: "s", label: "Petit" },
            { value: "m", label: "Moyen" },
            { value: "l", label: "Grand" },
          ]}
        />
      </div>
    </Modal>
  );
}

/** Chooses the zone of an area just drawn; a new zone of the floor can be created on the spot. */
export function ZoneChoiceDialog({ floor, onChoose, onClose }: { floor: FloorDetail; onChoose: (zoneId: string) => void; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [zoneId, setZoneId] = useState(floor.zones[0]?.id ?? "");
  const [creating, setCreating] = useState(floor.zones.length === 0);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#64748b");
  const create = useMutation({
    mutationFn: () => api.post<Zone>("/coworking/zones", { floorId: floor.id, name: name.trim(), color }),
    onSuccess: async (zone) => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast(`Zone ${zone.name} créée.`);
      onChoose(zone.id);
      onClose();
    },
  });
  return (
    <Modal
      title="Zone de la surface tracée"
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          label={creating ? "Créer la zone" : "Valider"}
          disabled={creating ? !name.trim() || create.isPending : !zoneId}
          onConfirm={() => {
            if (creating) create.mutate();
            else {
              onChoose(zoneId);
              onClose();
            }
          }}
        />
      }
    >
      {floor.zones.length ? (
        <Segmented
          label="Zone existante ou nouvelle"
          value={creating ? "new" : "existing"}
          onChange={(v) => setCreating(v === "new")}
          options={[
            { value: "existing", label: "Zone existante" },
            { value: "new", label: "Nouvelle zone" },
          ]}
        />
      ) : (
        <span className="cap">Cet étage n'a pas encore de zone : créez-la.</span>
      )}
      {creating ? (
        <div className="grid2">
          <Field label="Nom de la zone *">
            <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Couleur">
            <input className="input" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </Field>
        </div>
      ) : (
        <Field label="Zone">
          <select className="input" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            {floor.zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <ErrorBanner error={create.error} />
    </Modal>
  );
}

/** Creates a resource on this floor from the editor; the editor then places it on the plan. */
export function NewResourceDialog({ floor, onCreated, onClose }: { floor: FloorDetail; onCreated: (resource: Resource) => void; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const types = useQuery({ queryKey: CW_KEYS.types, queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [capacity, setCapacity] = useState("1");
  const capacityValue = parseInteger(capacity, 1, 500);
  const effectiveType = typeId || types.data?.[0]?.id || "";
  const create = useMutation({
    mutationFn: () =>
      api.post<Resource>("/coworking/resources", {
        code: code.trim(),
        name: name.trim(),
        typeId: effectiveType,
        floorId: floor.id,
        zoneId: zoneId || null,
        capacity: capacityValue,
      }),
    onSuccess: async (resource) => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast(`Ressource ${resource.code} créée et placée au centre du plan.`);
      onCreated(resource);
      onClose();
    },
  });
  return (
    <Modal
      title="Nouvelle ressource sur cet étage"
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          label="Créer et placer"
          disabled={!code.trim() || !effectiveType || capacityValue === null || create.isPending}
          onConfirm={() => create.mutate()}
        />
      }
    >
      <ErrorBanner error={types.error} />
      {types.data && types.data.length === 0 ? <div className="ban ban-amber">Créez d'abord un type d'espace dans l'onglet « Types d'espaces ».</div> : null}
      <div className="grid2">
        <Field label="Code *" hint="Affiché sur le plan, par exemple A-12. 20 caractères au plus.">
          <input className="input" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Nom">
          <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <Field label="Type *">
        <select className="input" value={effectiveType} onChange={(e) => setTypeId(e.target.value)}>
          {(types.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({CW_CATEGORY_LABELS.fr[t.category]})
            </option>
          ))}
        </select>
      </Field>
      <div className="grid2">
        <Field label="Zone">
          <select className="input" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">Aucune</option>
            {floor.zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Capacité (personnes)" error={capacityValue === null ? "Entre 1 et 500." : null}>
          <input className="input num" type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
      </div>
      <ErrorBanner error={create.error} />
    </Modal>
  );
}
