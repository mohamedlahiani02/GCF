import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Card, Empty, ErrorBanner, Field, Loading, Modal, ReasonDialog } from "../../components/ui";
import { CW_KEYS, type FloorRow, type Zone } from "./api";

const DEFAULT_COLOR = "#64748b";

function ZoneModal({ zone, floors, onClose }: { zone: Zone | null; floors: FloorRow[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [floorId, setFloorId] = useState(zone?.floorId ?? floors[0]?.id ?? "");
  const [name, setName] = useState(zone?.name ?? "");
  const [color, setColor] = useState(zone?.color ?? DEFAULT_COLOR);
  const save = useMutation({
    mutationFn: () =>
      zone ? api.patch(`/coworking/zones/${zone.id}`, { name: name.trim(), color }) : api.post("/coworking/zones", { floorId, name: name.trim(), color }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast(zone ? "Zone modifiée." : "Zone créée. Tracez sa surface dans l'éditeur du plan de l'étage.");
      onClose();
    },
  });
  return (
    <Modal
      title={zone ? `Modifier la zone ${zone.name}` : "Nouvelle zone"}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!name.trim() || !floorId || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Étage *" hint={zone ? "Une zone reste sur son étage." : undefined}>
        <select className="input" value={floorId} disabled={!!zone} onChange={(e) => setFloorId(e.target.value)}>
          {floors.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Nom *" hint="Par exemple : Open space, Espace calme, Pôle réunions.">
        <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Couleur sur le plan">
        <input className="input" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** Zones group the resources of a floor (open space, quiet area) and are drawn as coloured areas on its plan. */
export function ZonesTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [floorId, setFloorId] = useState("");
  const [editing, setEditing] = useState<Zone | "new" | null>(null);
  const [archiving, setArchiving] = useState<Zone | null>(null);
  const floors = useQuery({ queryKey: CW_KEYS.floors, queryFn: () => api.get<FloorRow[]>("/coworking/floors") });
  const zones = useQuery({ queryKey: [...CW_KEYS.zones, floorId], queryFn: () => api.get<Zone[]>("/coworking/zones", { floorId }) });
  const floorName = new Map((floors.data ?? []).map((f) => [f.id, f.name]));
  return (
    <>
      <Card
        title={
          <label className="row center" style={{ gap: 8 }}>
            <span className="lab">Étage</span>
            <select className="input" style={{ width: 220 }} value={floorId} onChange={(e) => setFloorId(e.target.value)}>
              <option value="">Tous les étages</option>
              {(floors.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        }
        actions={
          <button type="button" className="btn btn-p" disabled={!floors.data?.length} onClick={() => setEditing("new")}>
            + Zone
          </button>
        }
      >
        <ErrorBanner error={floors.error ?? zones.error} retry={() => zones.refetch()} />
        {zones.isPending ? (
          <Loading />
        ) : !zones.data?.length ? (
          <Empty title="Aucune zone" text={floors.data?.length ? "Les zones regroupent les ressources d'un étage." : "Créez d'abord un étage."} />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Zone</th>
                  <th>Étage</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {zones.data.map((z) => (
                  <tr key={z.id}>
                    <td>
                      <span className="row center" style={{ gap: 8 }}>
                        <span className="cw-swatch" style={{ background: z.color }} aria-hidden="true" />
                        {z.name}
                      </span>
                    </td>
                    <td>{floorName.get(z.floorId) ?? ""}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="btn btn-g" onClick={() => setEditing(z)}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn-g" onClick={() => setArchiving(z)}>
                        Archiver
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing ? <ZoneModal zone={editing === "new" ? null : editing} floors={floors.data ?? []} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver la zone"
          explanation={`${archiving.name} : les ressources de cette zone doivent d'abord être déplacées. Retirez aussi sa surface du plan et republiez-le.`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/zones/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.all });
            toast("Zone archivée.");
          }}
        />
      ) : null}
    </>
  );
}
