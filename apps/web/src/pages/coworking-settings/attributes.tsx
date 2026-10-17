import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Card, Empty, ErrorBanner, Field, Loading, Modal, ReasonDialog } from "../../components/ui";
import { CW_KEYS, type Attribute } from "./api";

function AttributeModal({ attribute, onClose }: { attribute: Attribute | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(attribute?.name ?? "");
  const save = useMutation({
    mutationFn: () =>
      attribute ? api.patch(`/coworking/attributes/${attribute.id}`, { name: name.trim() }) : api.post("/coworking/attributes", { name: name.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.all });
      toast(attribute ? "Attribut renommé." : "Attribut créé.");
      onClose();
    },
  });
  return (
    <Modal
      title={attribute ? "Renommer l'attribut" : "Nouvel attribut"}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom *" hint="Par exemple : Écran, Prise électrique, Fenêtre, Visioconférence.">
        <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** Equipment and features attached to resources; clients filter on them in the portal. */
export function AttributesTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Attribute | "new" | null>(null);
  const [archiving, setArchiving] = useState<Attribute | null>(null);
  const attributes = useQuery({ queryKey: CW_KEYS.attributes, queryFn: () => api.get<Attribute[]>("/coworking/attributes") });
  return (
    <>
      <Card
        title="Attributs des ressources"
        actions={
          <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
            + Attribut
          </button>
        }
      >
        <ErrorBanner error={attributes.error} retry={() => attributes.refetch()} />
        {attributes.isPending ? (
          <Loading />
        ) : !attributes.data?.length ? (
          <Empty title="Aucun attribut" text="Les attributs décrivent l'équipement d'une ressource : écran, fenêtre, visioconférence." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Attribut</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {attributes.data.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="btn btn-g" onClick={() => setEditing(a)}>
                        Renommer
                      </button>
                      <button type="button" className="btn btn-g" onClick={() => setArchiving(a)}>
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
      {editing ? <AttributeModal attribute={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver l'attribut"
          explanation={`${archiving.name} ne peut plus être choisi pour une ressource. Les ressources qui l'ont déjà le gardent jusqu'à leur prochaine modification.`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/attributes/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.all });
            toast("Attribut archivé.");
          }}
        />
      ) : null}
    </>
  );
}
