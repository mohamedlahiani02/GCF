import { CW_CATEGORIES, CW_CATEGORY_LABELS, isBookableCategory, type CwCategory } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, ReasonDialog } from "../../components/ui";
import { CW_KEYS, type ResourceType } from "./api";
import { durationLabel, hoursText, IMAGE_TYPES, mediaUrl, parseHours, parseInteger, uploadImage } from "./helpers";

const MAX_PHOTO_SOURCE_BYTES = 40 * 1024 * 1024;

function TypeModal({ type, onClose }: { type: ResourceType | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(type?.name ?? "");
  const [category, setCategory] = useState<CwCategory>(type?.category ?? "hot_desk");
  const [description, setDescription] = useState(type?.description ?? "");
  const [photoMediaId, setPhotoMediaId] = useState<string | null>(type?.photoMediaId ?? null);
  const [requiresApproval, setRequiresApproval] = useState(type?.requiresApproval ?? false);
  const [maxHours, setMaxHours] = useState(type?.maxMinutesPerDay ? hoursText(type.maxMinutesPerDay) : "");
  const [buffer, setBuffer] = useState(String(type?.bufferMinutes ?? 0));
  const [position, setPosition] = useState(String(type?.position ?? 0));
  const [isPublic, setPublic] = useState(type?.public ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const bookable = isBookableCategory(category);
  const maxMinutes = maxHours.trim() === "" ? null : parseHours(maxHours);
  const maxInvalid = maxHours.trim() !== "" && (maxMinutes === null || maxMinutes < 15 || maxMinutes > 1440);
  const bufferValue = parseInteger(buffer, 0, 240);
  const positionValue = parseInteger(position, 0, 10_000);
  const upload = useMutation({
    mutationFn: (file: File) => uploadImage(file, name.trim() || "Type d'espace", "coworking"),
    onSuccess: (media) => setPhotoMediaId(media.id),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        category,
        description: description.trim(),
        photoMediaId,
        public: isPublic,
        position: positionValue,
        ...(bookable ? { requiresApproval, maxMinutesPerDay: maxMinutes, bufferMinutes: bufferValue } : {}),
      };
      return type ? api.patch(`/coworking/resource-types/${type.id}`, body) : api.post("/coworking/resource-types", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast(type ? "Type d'espace modifié." : "Type d'espace créé.");
      onClose();
    },
  });
  const pick = (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) return setProblem("Choisissez une image PNG, JPEG ou WebP.");
    if (file.size > MAX_PHOTO_SOURCE_BYTES) return setProblem("Cette image est trop lourde (40 Mo au plus avant réduction).");
    upload.mutate(file);
  };
  const invalid = !name.trim() || (bookable && (maxInvalid || bufferValue === null)) || positionValue === null;
  return (
    <Modal
      title={type ? `Modifier ${type.name}` : "Nouveau type d'espace"}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="cap">Le tarif se règle dans « Formules et tarifs »</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={invalid || upload.isPending || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Nom *" hint="Nom affiché aux clients, par exemple : Poste en open space.">
          <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Catégorie *"
          hint={
            bookable
              ? "Réservé à l'heure ou à la journée selon les formats de réservation."
              : "Attribué à un abonné pour toute la durée de son abonnement, jamais réservé."
          }
        >
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as CwCategory)}>
            {CW_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CW_CATEGORY_LABELS.fr[c]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description" hint="Présentée aux clients dans l'espace client et sur le site.">
        <textarea className="input" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="logo-setting">
        <span className="logo-preview">
          {photoMediaId ? <img src={mediaUrl(photoMediaId)} alt={`Photo de ${name}`} /> : <span className="cap">Aucune photo</span>}
        </span>
        <div className="stack" style={{ gap: 6 }}>
          <span className="lab">Photo</span>
          <span className="cap">PNG, JPEG ou WebP ; réduite à 2560 pixels et convertie en WebP avant l'envoi.</span>
          <div className="row" style={{ gap: 8 }}>
            <label className={`btn${upload.isPending ? " disabled" : ""}`}>
              {upload.isPending ? <span className="spinner" aria-label="Envoi en cours" /> : null}
              {photoMediaId ? "Remplacer la photo" : "Choisir une photo"}
              <input
                type="file"
                accept={IMAGE_TYPES.join(",")}
                className="visually-hidden"
                aria-label="Photo du type d'espace"
                disabled={upload.isPending}
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            {photoMediaId ? (
              <button type="button" className="btn btn-g" onClick={() => setPhotoMediaId(null)}>
                Retirer
              </button>
            ) : null}
          </div>
          {problem ? <span className="err-text">{problem}</span> : null}
          <ErrorBanner error={upload.error} />
        </div>
      </div>
      {bookable ? (
        <>
          <label className="row center" style={{ gap: 8 }}>
            <input type="checkbox" className="chk" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
            Toute réservation de ce type depuis l'espace client attend la validation de l'accueil
          </label>
          <div className="grid2">
            <Field
              label="Durée maximale par client et par jour (heures)"
              hint="Vide : pas de limite. Entre 0,25 et 24 heures. Ne s'applique qu'aux réservations de l'espace client."
              error={maxInvalid ? "Entre 0,25 et 24 heures." : null}
            >
              <input className="input num" inputMode="decimal" value={maxHours} onChange={(e) => setMaxHours(e.target.value)} />
            </Field>
            <Field
              label="Temps tampon (minutes)"
              hint="Battement laissé libre après chaque réservation (ménage, installation). De 0 à 240."
              error={bufferValue === null ? "Entre 0 et 240 minutes." : null}
            >
              <input className="input num" type="number" min={0} max={240} value={buffer} onChange={(e) => setBuffer(e.target.value)} />
            </Field>
          </div>
        </>
      ) : null}
      <div className="grid2">
        <Field label="Ordre d'affichage" error={positionValue === null ? "Un nombre entier positif." : null}>
          <input className="input num" type="number" min={0} value={position} onChange={(e) => setPosition(e.target.value)} />
        </Field>
      </div>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
        Visible sur le site et dans l'espace client
      </label>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** Kinds of space offered (hot desk, meeting room...): the category decides whether they are booked or assigned. */
export function SpaceTypesTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<ResourceType | "new" | null>(null);
  const [archiving, setArchiving] = useState<ResourceType | null>(null);
  const [blocked, setBlocked] = useState<number | null>(null);
  const types = useQuery({ queryKey: CW_KEYS.types, queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
  return (
    <>
      <Card
        title="Types d'espaces"
        actions={
          <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
            + Type d'espace
          </button>
        }
      >
        <ErrorBanner error={types.error} retry={() => types.refetch()} />
        {types.isPending ? (
          <Loading />
        ) : !types.data?.length ? (
          <Empty title="Aucun type d'espace" text="Créez par exemple « Poste flexible », « Salle de réunion 6 places », « Bureau privé »." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Catégorie</th>
                  <th>Validation</th>
                  <th className="num">Maximum par jour</th>
                  <th className="num">Tampon</th>
                  <th className="num">Ressources</th>
                  <th>Visibilité</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {types.data.map((t) => {
                  const bookable = isBookableCategory(t.category);
                  return (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.name}</strong>
                        {t.description ? <div className="cap">{t.description.length > 80 ? `${t.description.slice(0, 80)}…` : t.description}</div> : null}
                      </td>
                      <td>
                        {CW_CATEGORY_LABELS.fr[t.category]} {bookable ? <Badge tone="blue">Réservable</Badge> : <Badge tone="violet">Attribué</Badge>}
                      </td>
                      <td>{bookable ? t.requiresApproval ? <Badge tone="amber">Toujours</Badge> : "Selon les règles" : "-"}</td>
                      <td className="num">{bookable && t.maxMinutesPerDay ? durationLabel(t.maxMinutesPerDay) : "-"}</td>
                      <td className="num">{bookable && t.bufferMinutes ? `${t.bufferMinutes} min` : "-"}</td>
                      <td className="num">{t.resourceCount}</td>
                      <td>{t.public ? <Badge tone="green">Public</Badge> : <Badge tone="gray">Interne</Badge>}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button type="button" className="btn btn-g" onClick={() => setEditing(t)}>
                          Modifier
                        </button>
                        <button
                          type="button"
                          className="btn btn-g"
                          onClick={() => {
                            setBlocked(null);
                            setArchiving(t);
                          }}
                        >
                          Archiver
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing ? <TypeModal type={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver le type d'espace"
          explanation={`${archiving.name} n'est plus proposé à la réservation ni dans les nouvelles formules. Les réservations à venir sur ses ressources doivent être déplacées ou annulées avant.`}
          extra={
            blocked ? (
              <div className="ban ban-amber">
                {blocked} réservation{blocked > 1 ? "s" : ""} à venir sur les ressources de ce type : déplacez-les ou annulez-les depuis le planning coworking.
              </div>
            ) : null
          }
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            try {
              await api.post(`/coworking/resource-types/${archiving.id}/archive`, { reason });
            } catch (error) {
              if (error instanceof ApiError && error.code === "resource_has_bookings")
                setBlocked((error.details as { count?: number } | undefined)?.count ?? null);
              throw error;
            }
            await client.invalidateQueries({ queryKey: CW_KEYS.all });
            toast("Type d'espace archivé.");
          }}
        />
      ) : null}
    </>
  );
}
