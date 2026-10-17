import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, Segmented } from "../../components/ui";
import { frDate, todayIso } from "../../lib/format";
import { CW_KEYS, type Closure } from "./api";

function ClosureModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const today = todayIso();
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState(today);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"closed" | "reduced">("closed");
  const [openFrom, setOpenFrom] = useState("09:00");
  const [openTo, setOpenTo] = useState("13:00");
  const errors = {
    dates: !startsOn || !endsOn || endsOn < startsOn ? "La fin ne peut pas précéder le début." : null,
    hours: mode === "reduced" && !(openFrom && openTo && openTo > openFrom) ? "L'heure de fermeture doit suivre l'ouverture." : null,
  };
  const save = useMutation({
    mutationFn: () =>
      api.post("/coworking/closures", {
        startsOn,
        endsOn,
        label: label.trim(),
        openFrom: mode === "reduced" ? openFrom : null,
        openTo: mode === "reduced" ? openTo : null,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.closures });
      toast(mode === "closed" ? "Fermeture enregistrée." : "Horaires réduits enregistrés.");
      onClose();
    },
  });
  return (
    <Modal
      title="Nouvelle fermeture"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Les réservations existantes ne sont pas annulées</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!label.trim() || errors.dates !== null || errors.hours !== null || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Motif *" hint="Par exemple : Aïd el-Fitr, Inventaire, Fête nationale.">
        <input className="input" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label="Du *">
          <input className="input" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </Field>
        <Field label="Au (inclus) *" error={errors.dates}>
          <input className="input" type="date" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </Field>
      </div>
      <Segmented
        label="Fermeture complète ou horaires réduits"
        value={mode}
        onChange={setMode}
        options={[
          { value: "closed", label: "Fermé toute la journée" },
          { value: "reduced", label: "Horaires réduits" },
        ]}
      />
      {mode === "reduced" ? (
        <div className="grid2">
          <Field label="Ouverture">
            <input className="input" type="time" value={openFrom} onChange={(e) => setOpenFrom(e.target.value)} />
          </Field>
          <Field label="Fermeture" error={errors.hours}>
            <input className="input" type="time" value={openTo} onChange={(e) => setOpenTo(e.target.value)} />
          </Field>
        </div>
      ) : null}
      <span className="cap">
        Ces jours-là, les horaires remplacent les heures d'ouverture du centre pour les nouvelles réservations du coworking. Vérifiez le planning coworking pour
        les réservations déjà faites.
      </span>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** Closed days and reduced opening hours of the coworking, from today on. */
export function ClosuresTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Closure | null>(null);
  const closures = useQuery({ queryKey: CW_KEYS.closures, queryFn: () => api.get<Closure[]>("/coworking/closures") });
  const remove = useMutation({
    mutationFn: (c: Closure) => api.del(`/coworking/closures/${c.id}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.closures });
      toast("Fermeture supprimée.");
      setDeleting(null);
    },
  });
  return (
    <>
      <Card
        title="Fermetures et horaires réduits à venir"
        actions={
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            + Fermeture
          </button>
        }
      >
        <ErrorBanner error={closures.error} retry={() => closures.refetch()} />
        {closures.isPending ? (
          <Loading />
        ) : !closures.data?.length ? (
          <Empty title="Aucune fermeture à venir" text="Ajoutez les jours fériés et les fermetures exceptionnelles du coworking." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Période</th>
                  <th>Motif</th>
                  <th>Horaires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {closures.data.map((c) => (
                  <tr key={c.id}>
                    <td>{c.startsOn === c.endsOn ? frDate(c.startsOn) : `Du ${frDate(c.startsOn)} au ${frDate(c.endsOn)}`}</td>
                    <td>{c.label}</td>
                    <td>
                      {c.openFrom && c.openTo ? (
                        <Badge tone="amber">
                          Ouvert de {c.openFrom} à {c.openTo}
                        </Badge>
                      ) : (
                        <Badge tone="red">Fermé</Badge>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className="btn btn-g" onClick={() => setDeleting(c)}>
                        Supprimer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating ? <ClosureModal onClose={() => setCreating(false)} /> : null}
      {deleting ? (
        <Modal
          title="Supprimer la fermeture"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <span className="cap">Action tracée au journal d'audit</span>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setDeleting(null)}>
                  Retour
                </button>
                <button type="button" className="btn btn-d" disabled={remove.isPending} onClick={() => remove.mutate(deleting)}>
                  Supprimer
                </button>
              </div>
            </>
          }
        >
          <p>
            {deleting.label} ({deleting.startsOn === deleting.endsOn ? frDate(deleting.startsOn) : `${frDate(deleting.startsOn)} au ${frDate(deleting.endsOn)}`}
            ) : les heures d'ouverture habituelles s'appliquent de nouveau.
          </p>
          <ErrorBanner error={remove.error} />
        </Modal>
      ) : null}
    </>
  );
}
