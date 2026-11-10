import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { useToast } from "../../components/toasts";
import { Card, Empty, ErrorBanner, Loading, Pagination } from "../../components/ui";
import { frDateTime } from "../../lib/format";
import { memberName, type MemberRow, type Page } from "./api";
import { CW_KEYS, type CwSettings } from "../coworking-settings/api";

export function PendingSignups() {
  const { can } = useSession();
  const settings = useQuery({ queryKey: CW_KEYS.settings, queryFn: () => api.get<CwSettings>("/coworking/settings") });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MemberRow | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const client = useQueryClient();
  const toast = useToast();
  const members = useQuery({
    queryKey: ["cw-members", "pending-approvals", page],
    queryFn: () => api.get<Page<MemberRow>>("/coworking/members", { status: "pending", page, pageSize: 25 }),
    refetchInterval: 30_000,
  });
  const validate = useMutation({
    mutationFn: (id: string) => api.post<{ mail: "sent" | "failed" | null }>(`/coworking/members/${id}/validate`),
    onSuccess: async (result) => {
      setSelected(null);
      await client.invalidateQueries();
      toast(
        result.mail === "failed"
          ? "Inscription validée. L’e-mail n’a pas pu être envoyé ; consultez le journal d’envoi."
          : result.mail === "sent"
            ? "Inscription validée. Le client a été prévenu par e-mail."
            : "Inscription validée. Le client peut maintenant se connecter.",
        result.mail === "failed" ? "error" : undefined,
      );
    },
  });
  useEffect(() => {
    if (selected) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selected]);
  useEffect(() => {
    if (members.data && page > 1 && !members.data.items.length) setPage(page - 1);
  }, [members.data, page]);
  return (
    <>
      <Card
        title={`Inscriptions à valider${members.data ? ` (${members.data.total})` : ""}`}
        footer={
          members.data && members.data.total > 25 ? (
            <Pagination page={page} total={members.data.total} pageSize={25} hasMore={page * 25 < members.data.total} onPage={setPage} />
          ) : undefined
        }
      >
        <div className="card-b signup-intro">
          <strong>Comptes créés depuis l’espace client</strong>
          <p>
            Vérifiez ses coordonnées, puis validez son inscription pour lui permettre de se connecter à l’espace client. Les comptes déjà actifs ne demandent
            aucune validation.
          </p>
          {settings.data ? (
            <p>
              {settings.data.selfSignup === "open"
                ? "Réglage actuel : création automatique des comptes, sans validation manuelle."
                : settings.data.selfSignup === "validated"
                  ? "Réglage actuel : les nouvelles inscriptions doivent être validées par l’accueil."
                  : "Réglage actuel : inscriptions en ligne fermées ; les comptes sont créés par l’accueil."}{" "}
              {can("coworking:manage") ? <Link to="/coworking/parametres?onglet=regles">Modifier le mode d’inscription</Link> : null}
            </p>
          ) : null}
        </div>
        <ErrorBanner error={members.error} retry={() => members.refetch()} />
        {members.isPending ? (
          <Loading />
        ) : members.data?.items.length === 0 ? (
          <Empty
            title="Aucune inscription en attente"
            text="Les nouvelles inscriptions soumises à validation apparaîtront ici et dans la cloche de notifications."
          />
        ) : (
          <ul className="signup-list">
            {members.data?.items.map((m) => (
              <li key={m.id}>
                <span className="avatar" aria-hidden="true">
                  {m.firstName[0]}
                  {m.lastName?.[0]}
                </span>
                <div>
                  <Link className="signup-name" to={`/coworking/membres/${m.id}`}>
                    {memberName(m)}
                  </Link>
                  <p>{[m.email, m.phone].filter(Boolean).join(" · ") || "Coordonnées non renseignées"}</p>
                  <span className="cap">Inscrit le {frDateTime(m.createdAt)}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-p"
                  onClick={() => {
                    validate.reset();
                    setSelected(m);
                  }}
                >
                  Valider l’inscription
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <dialog
        ref={dialog}
        className="signup-confirm"
        aria-labelledby="signup-confirm-title"
        onCancel={(e) => {
          e.preventDefault();
          if (!validate.isPending) setSelected(null);
        }}
      >
        <div className="stack">
          <h2 id="signup-confirm-title" className="h2">
            Valider cette inscription ?
          </h2>
          <p>
            <strong>{selected ? memberName(selected) : ""}</strong>
            {selected?.email ? ` (${selected.email})` : ""} pourra se connecter à son espace client.
          </p>
          <p className="cap">Cette validation est enregistrée à votre nom. Un e-mail est envoyé si le client a une adresse.</p>
          <ErrorBanner error={validate.error} />
          <div className="row signup-confirm-actions">
            <button type="button" className="btn" disabled={validate.isPending} onClick={() => setSelected(null)}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={validate.isPending} onClick={() => selected && validate.mutate(selected.id)}>
              {validate.isPending ? "Validation…" : "Valider l’inscription"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
