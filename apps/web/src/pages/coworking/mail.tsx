import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Pagination, ReasonDialog, Segmented } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { frDate, frDateTime } from "../../lib/format";
import { MAIL_KIND, MAIL_STATUS, type MailItem, type MailKind, type Page } from "./api";

const PAGE_SIZE = 25;

/** Records mail received today for a domiciled member. */
export function RegisterMailModal({ member, onClose }: { member: { id: string; name: string }; onClose: () => void }) {
  const [kind, setKind] = useState<MailKind>("letter");
  const [sender, setSender] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () =>
      api.post<MailItem>("/coworking/mail-items", {
        memberId: member.id,
        kind,
        sender: sender.trim() || null,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast(`Courrier enregistré pour ${member.name}.`);
      onClose();
    },
  });
  return (
    <Modal
      title={`Courrier reçu pour ${member.name}`}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Segmented
        label="Type d'envoi"
        value={kind}
        onChange={setKind}
        options={(Object.keys(MAIL_KIND) as MailKind[]).map((k) => ({ value: k, label: MAIL_KIND[k] }))}
      />
      <div className="grid2">
        <Field label="Expéditeur (facultatif)">
          <input className="input" autoFocus value={sender} maxLength={200} onChange={(e) => setSender(e.target.value)} />
        </Field>
        <Field label="Référence (facultatif)">
          <input className="input" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      <Field label="Note (facultatif)">
        <input className="input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function CollectMailModal({ item, onClose }: { item: MailItem; onClose: () => void }) {
  const [name, setName] = useState(item.memberName);
  const [notes, setNotes] = useState("");
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.post(`/coworking/mail-items/${item.id}/collect`, { collectedByName: name.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}) }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Courrier remis.");
      onClose();
    },
  });
  return (
    <Modal
      title="Remettre le courrier"
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              Remis
            </button>
          </div>
        </>
      }
    >
      <div>
        {MAIL_KIND[item.kind]}
        {item.sender ? ` de ${item.sender}` : ""} reçu le {frDate(item.receivedAt)} pour {item.memberName}.
      </div>
      <Field label="Remis à (nom de la personne)">
        <input className="input" autoFocus value={name} maxLength={150} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Note (facultatif)">
        <input className="input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** Mail items with their state and the desk actions: notify the member, hand over, return to sender. */
export function MailItemsTable({ items, showMember }: { items: MailItem[]; showMember: boolean }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [collecting, setCollecting] = useState<MailItem | null>(null);
  const [returning, setReturning] = useState<MailItem | null>(null);
  const notify = useMutation({
    mutationFn: (id: string) => api.post<MailItem & { mail: "sent" | "failed" }>(`/coworking/mail-items/${id}/notify`),
    onSuccess: async (r) => {
      await client.invalidateQueries();
      toast(
        r.mail === "sent" ? `${r.memberName} est prévenu par e-mail.` : "L'envoi de l'e-mail a échoué ; il est noté au journal d'envoi.",
        r.mail === "sent" ? "success" : "error",
      );
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
  const write = can("coworking:write");
  return (
    <>
      <div className="xs">
        <table className="tbl">
          <thead>
            <tr>
              <th>Reçu le</th>
              {showMember ? <th>Membre</th> : null}
              <th>Envoi</th>
              <th>Statut</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((m) => {
              const open = m.status === "received" || m.status === "notified";
              return (
                <tr key={m.id}>
                  <td>{frDateTime(m.receivedAt)}</td>
                  {showMember ? (
                    <td>
                      <Link to={`/coworking/membres/${m.memberId}`}>{m.memberName}</Link>
                    </td>
                  ) : null}
                  <td>
                    {MAIL_KIND[m.kind]}
                    {m.sender ? ` · ${m.sender}` : ""}
                    {m.reference ? <div className="cap">Réf. {m.reference}</div> : null}
                    {m.notes ? <div className="cap">{m.notes}</div> : null}
                  </td>
                  <td>
                    <Badge tone={MAIL_STATUS[m.status].tone}>{MAIL_STATUS[m.status].label}</Badge>
                    {m.notifiedAt && m.status === "notified" ? <div className="cap">le {frDateTime(m.notifiedAt)}</div> : null}
                    {m.collectedAt ? (
                      <div className="cap">
                        à {m.collectedByName}, le {frDateTime(m.collectedAt)}
                        {m.handedBy ? ` par ${m.handedBy}` : ""}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {write && open ? (
                      <>
                        <button type="button" className="btn btn-g" disabled={notify.isPending} onClick={() => notify.mutate(m.id)}>
                          {m.status === "notified" ? "Prévenir à nouveau" : "Prévenir"}
                        </button>
                        <button type="button" className="btn btn-g" onClick={() => setCollecting(m)}>
                          Remis
                        </button>
                        <button type="button" className="btn btn-g" onClick={() => setReturning(m)}>
                          Retourné
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {collecting ? <CollectMailModal item={collecting} onClose={() => setCollecting(null)} /> : null}
      {returning ? (
        <ReasonDialog
          title="Retourner le courrier"
          explanation={`${MAIL_KIND[returning.kind]} pour ${returning.memberName}, renvoyé à l'expéditeur.`}
          confirmLabel="Retourné"
          onClose={() => setReturning(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/mail-items/${returning.id}/return`, { reason });
            await client.invalidateQueries();
            toast("Courrier retourné.");
          }}
        />
      ) : null}
    </>
  );
}

interface Domiciliation {
  memberId: string;
  memberName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  endsOn: string;
  planName: string;
  openMailCount: number;
}

/** Domiciliation desk: the members domiciled today, then the mail received for them, waiting items first. */
export function MailPage() {
  usePage(["Coworking", "Courrier"]);
  const { can } = useSession();
  const [status, setStatus] = useState<"open" | "all">("open");
  const [page, setPage] = useState(1);
  const [registering, setRegistering] = useState<{ id: string; name: string } | null>(null);
  const domiciled = useQuery({ queryKey: ["cw-domiciliations"], queryFn: () => api.get<Domiciliation[]>("/coworking/domiciliations") });
  const items = useQuery({
    queryKey: ["cw-mail", status, page],
    queryFn: () => api.get<Page<MailItem>>("/coworking/mail-items", { status, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Courrier et domiciliation" />
      <Card
        title={`Courrier ${status === "open" ? "à remettre" : "reçu"}`}
        actions={
          <Segmented
            label="Courrier affiché"
            value={status}
            onChange={(s) => (setStatus(s), setPage(1))}
            options={[
              { value: "open", label: "À remettre" },
              { value: "all", label: "Tout" },
            ]}
          />
        }
        footer={
          items.data ? (
            <Pagination page={page} hasMore={page * PAGE_SIZE < items.data.total} onPage={setPage} total={items.data.total} pageSize={PAGE_SIZE} />
          ) : null
        }
      >
        <ErrorBanner error={items.error} retry={() => items.refetch()} />
        {items.isPending ? (
          <Loading />
        ) : items.data?.items.length === 0 ? (
          <Empty title={status === "open" ? "Aucun courrier en attente" : "Aucun courrier"} />
        ) : (
          <MailItemsTable items={items.data?.items ?? []} showMember />
        )}
      </Card>
      <Card title={`Membres domiciliés aujourd'hui (${domiciled.data?.length ?? 0})`}>
        <ErrorBanner error={domiciled.error} retry={() => domiciled.refetch()} />
        {domiciled.isPending ? (
          <Loading />
        ) : domiciled.data?.length === 0 ? (
          <Empty title="Aucune domiciliation en cours" text="La domiciliation est incluse dans certaines formules d'abonnement." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Membre</th>
                  <th>Contact</th>
                  <th>Formule</th>
                  <th className="num">En attente</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {domiciled.data?.map((d) => (
                  <tr key={d.memberId}>
                    <td>
                      <Link to={`/coworking/membres/${d.memberId}`}>{d.memberName}</Link>
                      {d.companyName ? <div className="cap">{d.companyName}</div> : null}
                    </td>
                    <td>
                      {d.phone ?? ""}
                      {d.email ? <div className="cap">{d.email}</div> : <div className="cap">Pas d'e-mail</div>}
                    </td>
                    <td>
                      {d.planName}
                      <div className="cap">jusqu'au {frDate(d.endsOn)}</div>
                    </td>
                    <td className="num">{d.openMailCount}</td>
                    <td style={{ textAlign: "right" }}>
                      {can("coworking:write") ? (
                        <button type="button" className="btn btn-g" onClick={() => setRegistering({ id: d.memberId, name: d.memberName })}>
                          Enregistrer un courrier
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {registering ? <RegisterMailModal member={registering} onClose={() => setRegistering(null)} /> : null}
    </>
  );
}
