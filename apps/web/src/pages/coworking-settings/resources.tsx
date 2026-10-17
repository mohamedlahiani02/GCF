import { CW_CATEGORY_LABELS } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Room } from "../../api/types";
import { useSession } from "../../auth/session";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, ReasonDialog } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { CW_KEYS, type Attribute, type FloorRow, type Resource, type ResourceType, type Zone } from "./api";
import { parseInteger } from "./helpers";

type StatusFilter = "current" | "active" | "out_of_service" | "archived" | "all";

const STATUS_FILTER: Record<StatusFilter, string> = {
  current: "En service et hors service",
  active: "En service",
  out_of_service: "Hors service",
  archived: "Archivées",
  all: "Toutes",
};

function statusBadge(r: Resource) {
  if (r.status === "active") return <Badge tone="green">En service</Badge>;
  if (r.status === "out_of_service") return <Badge tone="amber">Hors service</Badge>;
  return <Badge tone="gray">Archivée</Badge>;
}

function ResourceModal({
  resource,
  types,
  floors,
  attributes,
  onClose,
}: {
  resource: Resource | null;
  types: ResourceType[];
  floors: FloorRow[];
  attributes: Attribute[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const canLinkRoom = can("catalogue:read");
  const [code, setCode] = useState(resource?.code ?? "");
  const [name, setName] = useState(resource?.name ?? "");
  const [typeId, setTypeId] = useState(resource?.typeId ?? types[0]?.id ?? "");
  const [floorId, setFloorId] = useState(resource?.floorId ?? floors[0]?.id ?? "");
  const [zoneId, setZoneId] = useState(resource?.zoneId ?? "");
  const [capacity, setCapacity] = useState(String(resource?.capacity ?? 1));
  const active = new Set(attributes.map((a) => a.id));
  const [attributeIds, setAttributeIds] = useState<string[]>((resource?.attributeIds ?? []).filter((id) => active.has(id)));
  const [roomId, setRoomId] = useState(resource?.roomId ?? "");
  const zones = useQuery({
    queryKey: [...CW_KEYS.zones, floorId],
    queryFn: () => api.get<Zone[]>("/coworking/zones", { floorId }),
    enabled: !!floorId,
  });
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms"), enabled: canLinkRoom });
  const capacityValue = parseInteger(capacity, 1, 500);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: code.trim(),
        name: name.trim(),
        typeId,
        floorId,
        zoneId: zoneId || null,
        capacity: capacityValue,
        attributeIds,
        ...(canLinkRoom ? { roomId: roomId || null } : {}),
      };
      return resource ? api.patch<Resource>(`/coworking/resources/${resource.id}`, body) : api.post<Resource>("/coworking/resources", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast(resource ? "Ressource modifiée." : "Ressource créée. Placez-la sur le plan de son étage.");
      onClose();
    },
  });
  const typeName = types.find((t) => t.id === typeId);
  return (
    <Modal
      title={resource ? `Modifier ${resource.code}` : "Nouvelle ressource"}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="cap">Le code est affiché sur le plan et dans les réservations</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!code.trim() || !typeId || !floorId || capacityValue === null || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid3">
        <Field label="Code *" hint="20 caractères au plus, par exemple A-12.">
          <input className="input" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Nom">
          <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Capacité (personnes) *" error={capacityValue === null ? "Entre 1 et 500." : null}>
          <input className="input num" type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
      </div>
      <div className="grid3">
        <Field label="Type *" hint={resource && typeId !== resource.typeId ? "Possible seulement sans réservation à venir ni abonnement en cours." : undefined}>
          <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Étage *" hint={resource && floorId !== resource.floorId ? "Retirez d'abord la ressource du plan publié de son étage actuel." : undefined}>
          <select
            className="input"
            value={floorId}
            onChange={(e) => {
              setFloorId(e.target.value);
              setZoneId("");
            }}
          >
            {floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Zone">
          <select className="input" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">Aucune</option>
            {(zones.data ?? []).map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {typeName ? <span className="cap">Catégorie : {CW_CATEGORY_LABELS.fr[typeName.category]}</span> : null}
      <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0, gap: 6 }}>
        <legend className="lab" style={{ marginBottom: 6 }}>
          Attributs
        </legend>
        {attributes.length ? (
          <div className="row" style={{ gap: 12 }}>
            {attributes.map((a) => (
              <label key={a.id} className="row center" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  className="chk"
                  checked={attributeIds.includes(a.id)}
                  onChange={(e) => setAttributeIds(e.target.checked ? [...attributeIds, a.id] : attributeIds.filter((x) => x !== a.id))}
                />
                {a.name}
              </label>
            ))}
          </div>
        ) : (
          <span className="cap">Aucun attribut défini (onglet « Attributs »).</span>
        )}
      </fieldset>
      {canLinkRoom ? (
        <Field
          label="Salle de formation liée"
          hint="Une salle partagée avec le centre de formation : une réservation coworking l'occupe aussi dans le planning des salles."
        >
          <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Aucune</option>
            {(rooms.data ?? [])
              .filter((r) => r.status === "active" || r.id === roomId)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.capacity} places)
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      <ErrorBanner error={zones.error ?? rooms.error ?? save.error} />
    </Modal>
  );
}

/** The bookable or assigned places of the coworking: desks, offices, rooms, each on a floor. */
export function ResourcesTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [floorId, setFloorId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [status, setStatus] = useState<StatusFilter>("current");
  const [editing, setEditing] = useState<Resource | "new" | null>(null);
  const [outOfService, setOutOfService] = useState<Resource | null>(null);
  const [archiving, setArchiving] = useState<Resource | null>(null);
  const [archiveCount, setArchiveCount] = useState<number | null>(null);
  const floors = useQuery({ queryKey: CW_KEYS.floors, queryFn: () => api.get<FloorRow[]>("/coworking/floors") });
  const types = useQuery({ queryKey: CW_KEYS.types, queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
  const attributes = useQuery({ queryKey: CW_KEYS.attributes, queryFn: () => api.get<Attribute[]>("/coworking/attributes") });
  const zones = useQuery({
    queryKey: [...CW_KEYS.zones, floorId],
    queryFn: () => api.get<Zone[]>("/coworking/zones", { floorId }),
    enabled: !!floorId,
  });
  const resources = useQuery({
    queryKey: [...CW_KEYS.resources, floorId, typeId, zoneId, status],
    queryFn: () => api.get<Resource[]>("/coworking/resources", { floorId, typeId, zoneId, status }),
  });
  const backInService = useMutation({
    mutationFn: (r: Resource) => api.post(`/coworking/resources/${r.id}/status`, { status: "active" }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast("Ressource remise en service.");
    },
  });
  const attributeName = new Map((attributes.data ?? []).map((a) => [a.id, a.name]));
  const openArchive = async (r: Resource) => {
    setArchiveCount(null);
    setArchiving(r);
    try {
      const detail = await api.get<{ futureBookings: number }>(`/coworking/resources/${r.id}`);
      setArchiveCount(detail.futureBookings);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  };
  const ready = floors.data && types.data && attributes.data;
  return (
    <>
      <Card
        title="Ressources"
        actions={
          <button type="button" className="btn btn-p" disabled={!ready || !floors.data?.length || !types.data?.length} onClick={() => setEditing("new")}>
            + Ressource
          </button>
        }
      >
        <div className="card-b grid4" style={{ borderBlockEnd: "1px solid var(--line)" }}>
          <Field label="Étage">
            <select
              className="input"
              value={floorId}
              onChange={(e) => {
                setFloorId(e.target.value);
                setZoneId("");
              }}
            >
              <option value="">Tous</option>
              {(floors.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Zone">
            <select className="input" value={zoneId} disabled={!floorId} onChange={(e) => setZoneId(e.target.value)}>
              <option value="">{floorId ? "Toutes" : "Choisissez un étage"}</option>
              {(zones.data ?? []).map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Tous</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="État">
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              {Object.entries(STATUS_FILTER).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <ErrorBanner error={floors.error ?? types.error ?? attributes.error ?? resources.error ?? backInService.error} retry={() => resources.refetch()} />
        {floors.data?.length === 0 || types.data?.length === 0 ? (
          <div className="card-b">
            <div className="ban ban-blue">Créez d'abord au moins un étage et un type d'espace pour ajouter des ressources.</div>
          </div>
        ) : null}
        {resources.isPending ? (
          <Loading />
        ) : !resources.data?.length ? (
          <Empty title="Aucune ressource" text="Aucune ressource ne correspond à ces filtres." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Type</th>
                  <th>Étage et zone</th>
                  <th className="num">Capacité</th>
                  <th>Attributs</th>
                  <th>Salle liée</th>
                  <th>État</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {resources.data.map((r) => (
                  <tr key={r.id} className={r.status === "archived" ? "void" : undefined}>
                    <td>
                      <strong>{r.code}</strong>
                      {r.name ? <div className="cap">{r.name}</div> : null}
                    </td>
                    <td>
                      {r.typeName}
                      <div className="cap">{CW_CATEGORY_LABELS.fr[r.category]}</div>
                    </td>
                    <td>
                      {r.floorName}
                      {r.zoneName ? <div className="cap">{r.zoneName}</div> : null}
                    </td>
                    <td className="num">{r.capacity}</td>
                    <td>
                      {r.attributeIds
                        .map((id) => attributeName.get(id))
                        .filter(Boolean)
                        .join(", ") || <span className="cap">-</span>}
                    </td>
                    <td>{r.roomName ?? <span className="cap">-</span>}</td>
                    <td>
                      {statusBadge(r)}
                      {r.outOfServiceReason ? <div className="cap">{r.outOfServiceReason}</div> : null}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {r.status !== "archived" ? (
                        <>
                          <button type="button" className="btn btn-g" disabled={!ready} onClick={() => setEditing(r)}>
                            Modifier
                          </button>
                          {r.status === "active" ? (
                            <button type="button" className="btn btn-g" onClick={() => setOutOfService(r)}>
                              Mettre hors service
                            </button>
                          ) : (
                            <button type="button" className="btn btn-g" disabled={backInService.isPending} onClick={() => backInService.mutate(r)}>
                              Remettre en service
                            </button>
                          )}
                          <button type="button" className="btn btn-g" onClick={() => void openArchive(r)}>
                            Archiver
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && ready ? (
        <ResourceModal
          resource={editing === "new" ? null : editing}
          types={types.data}
          floors={floors.data}
          attributes={attributes.data}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {outOfService ? (
        <ReasonDialog
          title={`Mettre ${outOfService.code} hors service`}
          explanation="La ressource n'est plus réservable et apparaît bloquée sur le plan. Les réservations à venir sont conservées : déplacez-les ou annulez-les depuis le planning coworking."
          confirmLabel="Mettre hors service"
          onClose={() => setOutOfService(null)}
          onConfirm={async (reason) => {
            const result = await api.post<{ futureBookings: number }>(`/coworking/resources/${outOfService.id}/status`, { status: "out_of_service", reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.all });
            toast(
              result.futureBookings
                ? `Ressource hors service. ${result.futureBookings} réservation${result.futureBookings > 1 ? "s" : ""} à venir à déplacer ou annuler.`
                : "Ressource hors service.",
            );
          }}
        />
      ) : null}
      {archiving ? (
        <ReasonDialog
          title={`Archiver ${archiving.code}`}
          danger
          explanation="La ressource disparaît des plans et ne peut plus être réservée ni attribuée. L'archivage est refusé tant qu'une réservation à venir ou un abonnement en cours l'occupe."
          extra={
            archiveCount === null ? null : archiveCount > 0 ? (
              <div className="ban ban-amber">
                {archiveCount} réservation{archiveCount > 1 ? "s" : ""} à venir sur cette ressource : déplacez-les ou annulez-les avant de l'archiver.
              </div>
            ) : (
              <span className="cap">Aucune réservation à venir sur cette ressource.</span>
            )
          }
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            try {
              await api.post(`/coworking/resources/${archiving.id}/archive`, { reason });
            } catch (error) {
              if (error instanceof ApiError && error.code === "resource_has_bookings") {
                setArchiveCount((error.details as { count?: number } | undefined)?.count ?? archiveCount);
              }
              throw error;
            }
            await client.invalidateQueries({ queryKey: CW_KEYS.all });
            toast("Ressource archivée.");
          }}
        />
      ) : null}
    </>
  );
}
