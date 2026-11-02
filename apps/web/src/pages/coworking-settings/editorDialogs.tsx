import { type CwCategory, type FloorLayout, type PlanLabel } from "@gcf/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { ErrorBanner, Field, Modal, Segmented } from "../../components/ui";
import { CW_KEYS, type FloorDetail, type ResourceType, type Zone } from "./api";
import { IMAGE_TYPES, uploadImage } from "./helpers";

/** Plan images are decoded in the browser before being scaled down; beyond this size the tab may run out of memory. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

function Footer({
  onClose,
  label,
  disabled,
  onConfirm,
  danger,
  note,
}: {
  onClose: () => void;
  label: string;
  disabled: boolean;
  onConfirm: () => void;
  danger?: boolean;
  note?: string;
}) {
  return (
    <>
      {note ? <span className="cap">{note}</span> : <span />}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn" onClick={onClose}>
          Retour
        </button>
        <button type="button" className={danger ? "btn btn-d" : "btn btn-p"} disabled={disabled} onClick={onConfirm}>
          {label}
        </button>
      </div>
    </>
  );
}

/** Asks for the words of a text placed on the plan (room name, exit, kitchen). */
export function LabelDialog({ onAdd, onClose }: { onAdd: (text: string, size: PlanLabel["size"]) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [size, setSize] = useState<PlanLabel["size"]>("m");
  const confirm = () => {
    if (!text.trim()) return;
    onAdd(text.trim(), size);
    onClose();
  };
  return (
    <Modal title="Ajouter un texte" onClose={onClose} footer={<Footer onClose={onClose} label="Ajouter" disabled={!text.trim()} onConfirm={confirm} />}>
      <Field label="Texte" hint="Par exemple : Accueil, Cuisine, Sortie de secours. 60 caractères au plus.">
        <input
          className="input"
          value={text}
          maxLength={60}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
          }}
        />
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

/** Chooses the zone of an area just added on the plan; a new zone of the floor can be created on the spot. */
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
      title="Quelle zone ?"
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
      <span className="cap">Une zone regroupe des places sur le plan, par exemple « Open space » ou « Espace calme ».</span>
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
        <span className="cap">Cet étage n'a pas encore de zone : donnez-lui un nom.</span>
      )}
      {creating ? (
        <div className="grid2">
          <Field label="Nom de la zone">
            <input className="input" value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} />
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

/**
 * The type of the new places when the tile matches several types (choose one, remembered for the session), or none
 * (create it here with a name; prices and booking formats are set later in their own tabs).
 */
export function TypeDialog({
  category,
  word,
  types,
  onChoose,
  onClose,
}: {
  category: CwCategory;
  word: string;
  types: ResourceType[];
  onChoose: (type: ResourceType) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [name, setName] = useState(word);
  const create = useMutation({
    mutationFn: () => api.post<ResourceType>("/coworking/resource-types", { name: name.trim(), category }),
    onSuccess: async (type) => {
      await client.invalidateQueries({ queryKey: CW_KEYS.types });
      onChoose(type);
    },
  });
  if (!types.length) {
    return (
      <Modal
        title={`Pas encore de type « ${word} »`}
        onClose={onClose}
        footer={<Footer onClose={onClose} label="Créer ce type" disabled={!name.trim() || create.isPending} onConfirm={() => create.mutate()} />}
      >
        <p>Pour ajouter cet élément, il faut d'abord un type d'espace de ce genre. Donnez-lui un nom : il sera créé tout de suite.</p>
        <Field label="Nom du type" hint="Les tarifs et les horaires de réservation se règlent ensuite dans l'onglet « Formules et tarifs ».">
          <input className="input" value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorBanner error={create.error} />
      </Modal>
    );
  }
  const chosen = types.find((t) => t.id === typeId);
  return (
    <Modal
      title={`Quel type de « ${word} » ?`}
      onClose={onClose}
      footer={<Footer onClose={onClose} label="Utiliser ce type" disabled={!chosen} onConfirm={() => chosen && onChoose(chosen)} />}
    >
      <p>Plusieurs types existent pour cet élément. Choisissez celui des nouvelles places ; ce choix est gardé jusqu'à la sortie de l'éditeur.</p>
      <div className="stack fpe-choices" role="radiogroup" aria-label="Type d'espace">
        {types.map((t) => (
          <label key={t.id} className={`fpe-choice${t.id === typeId ? " on" : ""}`}>
            <input type="radio" name="type" className="chk" checked={t.id === typeId} onChange={() => setTypeId(t.id)} />
            <span className="stack" style={{ gap: 2 }}>
              <strong>{t.name}</strong>
              {t.description ? <span className="cap">{t.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

/** Confirms the publication: from now on the front desk and the clients see this plan. */
export function PublishDialog({
  layout,
  unplaced,
  pending,
  error,
  onPublish,
  onClose,
}: {
  layout: FloorLayout;
  unplaced: number;
  pending: boolean;
  error: unknown;
  onPublish: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Publier le plan ?"
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          label={pending ? "Publication…" : "Publier"}
          disabled={pending}
          onConfirm={onPublish}
          note="Action tracée au journal d'audit"
        />
      }
    >
      <p>Une fois publié, ce plan remplace l'ancien : l'accueil le voit sur le plan en direct et les clients le voient en réservant en ligne.</p>
      <ul className="fpe-facts">
        <li>{layout.items.length} place(s) sur le plan</li>
        {unplaced ? <li>{unplaced} place(s) pas encore sur le plan : les clients ne les verront pas sur le plan</li> : null}
        <li>
          {layout.areas.length} zone(s) dessinée(s), {layout.labels.length} texte(s)
        </li>
      </ul>
      <ErrorBanner error={error} />
    </Modal>
  );
}

/** Confirms that the draft is dropped; the editor starts again from the published plan. */
export function DiscardDialog({ pending, error, onDiscard, onClose }: { pending: boolean; error: unknown; onDiscard: () => void; onClose: () => void }) {
  return (
    <Modal
      title="Abandonner le brouillon ?"
      onClose={onClose}
      footer={<Footer onClose={onClose} label="Abandonner" danger disabled={pending} onConfirm={onDiscard} />}
    >
      <p>Toutes les modifications faites depuis la dernière publication sont retirées. L'éditeur repart du plan publié.</p>
      <span className="cap">Les places créées entre-temps restent dans la liste « À placer ».</span>
      <ErrorBanner error={error} />
    </Modal>
  );
}

/** Plan image (architect's plan or evacuation plan) and, without an image, the proportions of the drawing area. */
export function PlanSettingsDialog({
  floor,
  aspect,
  onAspect,
  onClose,
}: {
  floor: FloorDetail;
  aspect: number | null;
  onAspect: (value: number) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const [ratio, setRatio] = useState(aspect === null ? "" : String(aspect).replace(".", ","));
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
  const ratioValue = Number(ratio.replace(",", "."));
  const ratioValid = ratio.trim() !== "" && ratioValue >= 0.25 && ratioValue <= 4;
  return (
    <Modal
      title="Image du plan et proportions"
      onClose={onClose}
      footer={
        <>
          <span />
          <button type="button" className="btn btn-p" onClick={onClose}>
            Fermer
          </button>
        </>
      }
    >
      <span className="cap">
        Plan d'architecte ou photo du plan d'évacuation. L'image est réduite avant l'envoi. Elle s'affiche aussitôt sur le plan publié ; les places restent à
        leur position sur l'image.
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
          <button type="button" className="btn btn-d" disabled={setPlan.isPending} onClick={() => setPlan.mutate(null)}>
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
      {aspect !== null ? (
        <Field
          label="Proportions du plan sans image (largeur divisée par la hauteur)"
          hint="1,6 donne un plan plus large que haut ; 1 un plan carré. De 0,25 à 4."
          error={ratio.trim() && !ratioValid ? "Entre 0,25 et 4." : null}
        >
          <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <input className="input num" inputMode="decimal" value={ratio} onChange={(e) => setRatio(e.target.value)} />
            <button type="button" className="btn" disabled={!ratioValid || ratioValue === aspect} onClick={() => onAspect(ratioValue)}>
              Appliquer
            </button>
          </div>
        </Field>
      ) : null}
    </Modal>
  );
}
