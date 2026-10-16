import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, ReasonDialog } from "../../components/ui";
import { frDateTime } from "../../lib/format";
import { CW_KEYS, type FloorRow } from "./api";
import { parseInteger } from "./helpers";

export const floorEditorPath = (floorId: string) => `/coworking/parametres/etages/${floorId}`;

function FloorModal({ floor, onClose }: { floor: FloorRow | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(floor?.name ?? "");
  const [position, setPosition] = useState(String(floor?.position ?? 0));
  const positionValue = parseInteger(position, 0, 10_000);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), position: positionValue };
      return floor ? api.patch(`/coworking/floors/${floor.id}`, body) : api.post("/coworking/floors", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast(floor ? "Étage modifié." : "Étage créé. Ouvrez son plan pour y placer les ressources.");
      onClose();
    },
  });
  return (
    <Modal
      title={floor ? `Modifier ${floor.name}` : "Nouvel étage"}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!name.trim() || positionValue === null || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom *" hint="Par exemple : Rez-de-chaussée, 1er étage.">
        <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Ordre d'affichage" hint="Les étages sont listés du plus petit au plus grand." error={positionValue === null ? "Un nombre entier positif." : null}>
        <input className="input num" type="number" min={0} value={position} onChange={(e) => setPosition(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function planState(f: FloorRow) {
  if (f.hasDraft) return <Badge tone="amber">Brouillon en cours</Badge>;
  if (f.layoutPublishedAt) return <Badge tone="green">Publié</Badge>;
  return <Badge tone="gray">Jamais publié</Badge>;
}

/** Floors of the coworking space; each one opens the plan editor. */
export function FloorsTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<FloorRow | "new" | null>(null);
  const [archiving, setArchiving] = useState<FloorRow | null>(null);
  const floors = useQuery({ queryKey: CW_KEYS.floors, queryFn: () => api.get<FloorRow[]>("/coworking/floors") });
  return (
    <>
      <Card
        title="Étages"
        actions={
          <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
            + Étage
          </button>
        }
      >
        <ErrorBanner error={floors.error} retry={() => floors.refetch()} />
        {floors.isPending ? (
          <Loading />
        ) : !floors.data?.length ? (
          <Empty title="Aucun étage" text="Créez un étage, puis dessinez son plan et placez-y les ressources." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Étage</th>
                  <th className="num">Ordre</th>
                  <th className="num">Ressources</th>
                  <th>Image du plan</th>
                  <th>Plan</th>
                  <th>Dernière publication</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {floors.data.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <Link to={floorEditorPath(f.id)}>{f.name}</Link>
                    </td>
                    <td className="num">{f.position}</td>
                    <td className="num">{f.resourceCount}</td>
                    <td>{f.planMediaId ? "Oui" : <span className="cap">Aucune</span>}</td>
                    <td>{planState(f)}</td>
                    <td>{f.layoutPublishedAt ? frDateTime(f.layoutPublishedAt) : <span className="cap">-</span>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <Link className="btn btn-g" to={floorEditorPath(f.id)}>
                        Éditer le plan
                      </Link>
                      <button type="button" className="btn btn-g" onClick={() => setEditing(f)}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn-g" onClick={() => setArchiving(f)}>
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
      {editing ? <FloorModal floor={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver l'étage"
          explanation={`${archiving.name} disparaît du plan en direct et de l'espace client. Ses ressources doivent être archivées ou déplacées avant.`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/floors/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.all });
            toast("Étage archivé.");
          }}
        />
      ) : null}
    </>
  );
}
