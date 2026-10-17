import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Kpi, Loading, Modal, PageHeader, Pagination, ReasonDialog, StateBadge, Tabs } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { frDate, frDateTime, frTime, tnd } from "../../lib/format";
import { CHEQUE, METHOD } from "../../lib/labels";
import {
  MEMBER_KIND,
  MEMBER_STATUS,
  PACK_STATE,
  QUOTA,
  durationLabel,
  memberName,
  type BookingListRow,
  type MailItem,
  type MemberAccount,
  type MemberDetail,
  type Pack,
  type PackProduct,
  type Page,
  type Subscription,
} from "./api";
import { BookingStatusBadge, useMemberCollect } from "./bookingParts";
import { MailItemsTable, RegisterMailModal } from "./mail";
import { MemberFormModal } from "./memberPicker";
import { SellSubscriptionModal, SubscriptionsTable } from "./subscriptions";

type Tab = "profile" | "bookings" | "subscriptions" | "packs" | "account" | "mail";

function ConvertModal({ member, onClose }: { member: MemberDetail; onClose: () => void }) {
  const [email, setEmail] = useState(member.email ?? "");
  const [lastName, setLastName] = useState(member.lastName ?? "");
  const [phone, setPhone] = useState(member.phone ?? "");
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.post(`/coworking/members/${member.id}/convert`, { email: email.trim(), lastName: lastName.trim() || null, phone: phone.trim() || null }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Client converti en membre. Envoyez-lui l'invitation à son espace client.");
      onClose();
    },
  });
  return (
    <Modal
      title="Convertir en membre"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Les réservations et paiements passés restent sur la fiche.</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!email.trim() || save.isPending} onClick={() => save.mutate()}>
              Convertir
            </button>
          </div>
        </>
      }
    >
      <Field label="E-mail de l'espace client">
        <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label="Nom (facultatif)">
          <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </Field>
        <Field label="Téléphone (facultatif)">
          <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function SellPackModal({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const products = useQuery({ queryKey: ["cw-pack-products"], queryFn: () => api.get<PackProduct[]>("/coworking/pack-products") });
  const [productId, setProductId] = useState("");
  const product = products.data?.find((p) => p.id === productId) ?? products.data?.[0];
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.post<Pack>("/coworking/packs", { memberId, productId: product!.id }),
    onSuccess: async (p) => {
      await client.invalidateQueries();
      toast(`Carnet ${p.productName} vendu, valable jusqu'au ${frDate(p.expiresOn)}.`);
      onClose();
    },
  });
  return (
    <Modal
      title="Vendre un carnet"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Une échéance due aujourd'hui est créée.</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!product || save.isPending} onClick={() => save.mutate()}>
              Vendre
            </button>
          </div>
        </>
      }
    >
      {products.isPending ? (
        <Loading />
      ) : !products.data?.length ? (
        <div className="ban ban-amber">
          <span>Aucun carnet actif : créez-les dans les paramètres coworking.</span>
        </div>
      ) : (
        <Field label="Carnet">
          <select className="input" autoFocus value={product?.id ?? ""} onChange={(e) => setProductId(e.target.value)}>
            {products.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.quotaKind === "minutes" ? durationLabel(p.quota) : `${p.quota} réservation(s)`} · {p.validityDays} jours · {tnd(p.price)} TND
              </option>
            ))}
          </select>
        </Field>
      )}
      <ErrorBanner error={products.error ?? save.error} />
    </Modal>
  );
}

function ProfileTab({ member }: { member: MemberDetail }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [converting, setConverting] = useState(false);
  const act = useMutation({
    mutationFn: (action: "enable" | "invite" | "validate") => api.post<{ mail?: "sent" | "failed" | null }>(`/coworking/members/${member.id}/${action}`),
    onSuccess: async (r, action) => {
      await client.invalidateQueries();
      if (action === "enable") toast("Client réactivé.");
      else if (r.mail === "failed") toast("L'envoi de l'e-mail a échoué ; il est noté au journal d'envoi.", "error");
      else toast(action === "invite" ? `Invitation envoyée à ${member.email}.` : "Inscription validée. Le membre est prévenu par e-mail.");
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
  const write = can("coworking:write");
  const rows: [string, string][] = [
    ["Type", MEMBER_KIND[member.kind]],
    ["Téléphone", member.phone ?? ""],
    ["E-mail", member.email ?? ""],
    ["Société", member.companyName ?? ""],
    ["Espace client", member.kind === "guest" ? "Aucun (client de passage)" : member.hasPassword ? `Activé${member.lastLoginAt ? `, dernière connexion le ${frDateTime(member.lastLoginAt)}` : ""}` : "Invitation à envoyer"],
    ["Client depuis le", frDate(member.createdAt)],
    ["Notes internes", member.notes ?? ""],
  ];
  return (
    <>
      <Card
        title="Profil"
        actions={
          write ? (
            <>
              {member.status === "pending" ? (
                <button type="button" className="btn btn-p" disabled={act.isPending} onClick={() => act.mutate("validate")}>
                  Valider l'inscription
                </button>
              ) : null}
              {member.kind === "member" && member.status === "active" && !member.hasPassword ? (
                <button type="button" className="btn" disabled={act.isPending} onClick={() => act.mutate("invite")}>
                  Envoyer l'invitation
                </button>
              ) : null}
              {member.kind === "guest" ? (
                <button type="button" className="btn" onClick={() => setConverting(true)}>
                  Convertir en membre
                </button>
              ) : null}
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                Modifier
              </button>
              {member.status === "disabled" ? (
                <button type="button" className="btn btn-g" disabled={act.isPending} onClick={() => act.mutate("enable")}>
                  Réactiver
                </button>
              ) : (
                <button type="button" className="btn btn-g" onClick={() => setDisabling(true)}>
                  Désactiver
                </button>
              )}
            </>
          ) : null
        }
      >
        <div className="xs">
          <table className="tbl">
            <tbody>
              {rows.map(([label, value]) => (
                <tr key={label}>
                  <td className="lab" style={{ width: 180 }}>
                    {label}
                  </td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {editing ? (
        <MemberFormModal
          member={member}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast("Fiche mise à jour.");
          }}
        />
      ) : null}
      {converting ? <ConvertModal member={member} onClose={() => setConverting(false)} /> : null}
      {disabling ? (
        <ReasonDialog
          title="Désactiver le client"
          explanation="Le client ne peut plus réserver ni se connecter à son espace ; sa fiche et son historique sont conservés."
          confirmLabel="Désactiver"
          danger
          onClose={() => setDisabling(false)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/members/${member.id}/disable`, { reason });
            await client.invalidateQueries();
            toast("Client désactivé.");
          }}
        />
      ) : null}
    </>
  );
}

function BookingsTab({ memberId }: { memberId: string }) {
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["cw-bookings", { memberId }, page],
    queryFn: () => api.get<{ items: BookingListRow[]; hasMore: boolean }>("/coworking/bookings", { memberId, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card title="Réservations" footer={list.data ? <Pagination page={page} hasMore={list.data.hasMore} onPage={setPage} /> : null}>
      <ErrorBanner error={list.error} retry={() => list.refetch()} />
      {list.isPending ? (
        <Loading />
      ) : list.data?.items.length === 0 ? (
        <Empty title="Aucune réservation" />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Ressource</th>
                <th>Format</th>
                <th className="num">Montant (TND)</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/coworking/reservations/${b.id}`}>{frDate(b.startsAt)}</Link>
                    <div className="cap">
                      {frTime(b.startsAt)}-{frTime(b.endsAt)}
                    </div>
                  </td>
                  <td>
                    {b.resourceCode}
                    <div className="cap">{b.typeName}</div>
                  </td>
                  <td>
                    {b.formatLabel ?? ""}
                    <div className="cap">{b.source === "portal" ? "Espace client" : "Accueil"}</div>
                  </td>
                  <td className="num">
                    {tnd(b.charge)}
                    {b.lateCancelFee > 0 ? <div className="cap">frais {tnd(b.lateCancelFee)}</div> : null}
                  </td>
                  <td>
                    <BookingStatusBadge status={b.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SubscriptionsTab({ member }: { member: MemberDetail }) {
  const { can } = useSession();
  const [selling, setSelling] = useState(false);
  const list = useQuery({
    queryKey: ["cw-subscriptions", { memberId: member.id }],
    queryFn: () => api.get<Page<Subscription>>("/coworking/subscriptions", { memberId: member.id, status: "all", pageSize: 100 }),
  });
  return (
    <Card
      title="Abonnements"
      actions={
        can("coworking:write") && member.status !== "disabled" ? (
          <button type="button" className="btn btn-p" onClick={() => setSelling(true)}>
            + Vendre un abonnement
          </button>
        ) : null
      }
    >
      <ErrorBanner error={list.error} retry={() => list.refetch()} />
      {list.isPending ? <Loading /> : list.data?.items.length === 0 ? <Empty title="Aucun abonnement" /> : <SubscriptionsTable items={list.data?.items ?? []} showMember={false} />}
      {selling ? <SellSubscriptionModal memberId={member.id} onClose={() => setSelling(false)} /> : null}
    </Card>
  );
}

function PacksTab({ member }: { member: MemberDetail }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [selling, setSelling] = useState(false);
  const [cancelling, setCancelling] = useState<Pack | null>(null);
  const list = useQuery({ queryKey: ["cw-packs", member.id], queryFn: () => api.get<Pack[]>(`/coworking/members/${member.id}/packs`) });
  const write = can("coworking:write");
  return (
    <Card
      title="Carnets"
      actions={
        write && member.status !== "disabled" ? (
          <button type="button" className="btn btn-p" onClick={() => setSelling(true)}>
            + Vendre un carnet
          </button>
        ) : null
      }
    >
      <ErrorBanner error={list.error} retry={() => list.refetch()} />
      {list.isPending ? (
        <Loading />
      ) : list.data?.length === 0 ? (
        <Empty title="Aucun carnet" />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Carnet</th>
                <th>Validité</th>
                <th className="num">Restant</th>
                <th className="num">Prix (TND)</th>
                <th>Statut</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data?.map((p) => (
                <tr key={p.id} className={p.status === "cancelled" ? "void" : ""}>
                  <td>
                    {p.productName}
                    <div className="cap">
                      {p.typeName} · {QUOTA[p.quotaKind]}
                    </div>
                  </td>
                  <td>
                    {frDate(p.startsOn)} au {frDate(p.expiresOn)}
                    {p.cancelReason ? <div className="cap">{p.cancelReason}</div> : null}
                  </td>
                  <td className="num">
                    {p.quotaKind === "minutes" ? `${durationLabel(p.remaining)} / ${durationLabel(p.quota)}` : `${p.remaining} / ${p.quota}`}
                  </td>
                  <td className="num">{tnd(p.price)}</td>
                  <td>
                    <Badge tone={PACK_STATE[p.state].tone}>{PACK_STATE[p.state].label}</Badge>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {write && p.status === "active" && p.used === 0 ? (
                      <button type="button" className="btn btn-g" onClick={() => setCancelling(p)}>
                        Annuler
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selling ? <SellPackModal memberId={member.id} onClose={() => setSelling(false)} /> : null}
      {cancelling ? (
        <ReasonDialog
          title="Annuler le carnet"
          danger
          explanation={`${cancelling.productName} : possible tant qu'il n'a servi à aucune réservation ni reçu de paiement. L'échéance non payée est annulée.`}
          confirmLabel="Annuler le carnet"
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/packs/${cancelling.id}/cancel`, { reason });
            await client.invalidateQueries();
            toast("Carnet annulé.");
          }}
        />
      ) : null}
    </Card>
  );
}

function AccountTab({ memberId }: { memberId: string }) {
  const account = useQuery({
    queryKey: ["account", `/coworking/members/${memberId}/account`],
    queryFn: () => api.get<MemberAccount>(`/coworking/members/${memberId}/account`),
  });
  if (account.isPending) return <Loading />;
  if (account.error) return <ErrorBanner error={account.error} retry={() => account.refetch()} />;
  const { installments, payments } = account.data;
  return (
    <>
      <Card title="Échéancier">
        {installments.length === 0 ? (
          <Empty title="Aucune échéance" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Échéance</th>
                  <th>Date</th>
                  <th>Statut</th>
                  <th className="num">Montant</th>
                  <th className="num">Payé</th>
                  <th className="num">Reste</th>
                </tr>
              </thead>
              <tbody>
                {installments.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.cwBookingId ? <Link to={`/coworking/reservations/${i.cwBookingId}`}>{i.label}</Link> : i.label}
                    </td>
                    <td>
                      {frDate(i.dueDate)}
                      {i.dueDate !== i.originalDueDate ? <div className="cap">origine {frDate(i.originalDueDate)}</div> : null}
                    </td>
                    <td>
                      <StateBadge state={i.state} />
                    </td>
                    <td className="num">{i.kind === "discount" ? `-${tnd(i.amount)}` : tnd(i.amount)}</td>
                    <td className="num">{i.kind === "charge" ? tnd(i.paid) : ""}</td>
                    <td className="num">{i.kind === "charge" && i.status === "open" ? tnd(i.remaining) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Paiements et reçus">
        {payments.length === 0 ? (
          <Empty title="Aucun paiement" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reçu</th>
                  <th>Mode</th>
                  <th className="num">Montant (TND)</th>
                  <th>Statut</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{frDateTime(p.receivedAt)}</td>
                    <td>{p.receiptId ? <Link to={`/recus/${p.receiptId}`}>{p.receiptNumber}</Link> : ""}</td>
                    <td>
                      {METHOD[p.method] ?? p.method}
                      {p.method === "cheque" ? <div className="cap">{CHEQUE[p.chequeStatus ?? "received"]}</div> : null}
                    </td>
                    <td className="num">{tnd(p.amount)}</td>
                    <td>
                      {p.status === "cancelled" ? (
                        <Badge tone="gray" strike>
                          Annulé
                        </Badge>
                      ) : p.kind === "refund" ? (
                        <Badge tone="violet">Remboursement</Badge>
                      ) : p.chequeStatus === "bounced" ? (
                        <Badge tone="red">Chèque impayé</Badge>
                      ) : (
                        <Badge tone="green">Valide</Badge>
                      )}
                      {p.cancelReason ? <div className="cap">{p.cancelReason}</div> : null}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {p.receiptId ? (
                        <a className="btn btn-g" href={api.fileUrl(`/receipts/${p.receiptId}/pdf`)} target="_blank" rel="noreferrer">
                          Imprimer
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function MailTab({ member }: { member: MemberDetail }) {
  const { can } = useSession();
  const [registering, setRegistering] = useState(false);
  const list = useQuery({
    queryKey: ["cw-mail", { memberId: member.id }],
    queryFn: () => api.get<Page<MailItem>>("/coworking/mail-items", { memberId: member.id, pageSize: 100 }),
  });
  const domiciled = !!member.activeSubscription?.includesDomiciliation;
  return (
    <Card
      title="Courrier"
      actions={
        can("coworking:write") && domiciled ? (
          <button type="button" className="btn btn-p" onClick={() => setRegistering(true)}>
            + Enregistrer un courrier
          </button>
        ) : !domiciled ? (
          <span className="cap">Pas de domiciliation en cours</span>
        ) : null
      }
    >
      <ErrorBanner error={list.error} retry={() => list.refetch()} />
      {list.isPending ? <Loading /> : list.data?.items.length === 0 ? <Empty title="Aucun courrier" /> : <MailItemsTable items={list.data?.items ?? []} showMember={false} />}
      {registering ? <RegisterMailModal member={{ id: member.id, name: memberName(member) }} onClose={() => setRegistering(false)} /> : null}
    </Card>
  );
}

/** The desk view of a coworking client: profile, bookings, subscriptions, packs, account and mail. */
export function MemberPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const collect = useMemberCollect();
  const [tab, setTab] = useState<Tab>("profile");
  const member = useQuery({ queryKey: ["cw-member", id], queryFn: () => api.get<MemberDetail>(`/coworking/members/${id}`) });
  const name = member.data ? memberName(member.data) : "Fiche client";
  usePage(["Coworking", "Membres", name]);
  if (member.isPending) return <Loading />;
  if (member.error) return <ErrorBanner error={member.error} retry={() => member.refetch()} />;
  const m = member.data;
  const sub = m.activeSubscription;
  return (
    <>
      <PageHeader
        title={name}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <Badge tone={MEMBER_STATUS[m.status].tone}>{MEMBER_STATUS[m.status].label}</Badge>
            <Badge tone="neutral">{MEMBER_KIND[m.kind]}</Badge>
            <span>{[m.companyName, m.phone, m.email].filter(Boolean).join(" · ")}</span>
          </span>
        }
        actions={
          can("payments:write") ? (
            <button type="button" className="btn btn-p" onClick={() => collect.open(m.id)}>
              Encaisser
            </button>
          ) : null
        }
      />
      <div className="grid4">
        <Kpi
          label="Abonnement"
          value={sub ? sub.planName : "Aucun"}
          sub={sub ? `jusqu'au ${frDate(sub.endsOn)}${sub.assignedResourceCode ? ` · ${sub.assignedResourceCode}` : ""}` : "tarif visiteur"}
        />
        <Kpi
          label="Réservations"
          value={m.upcomingBookings}
          sub={`à venir · ${m.bookingsLast30Days} sur 30 jours${m.noShowsLast90Days ? ` · ${m.noShowsLast90Days} absence(s) sur 90 jours` : ""}`}
          tone={m.noShowsLast90Days >= 3 ? "amber" : undefined}
        />
        <Kpi label="Reste à payer" value={<span className="num">{tnd(m.totals.due)}</span>} sub={`TND · crédit ${tnd(m.totals.credit)} TND`} tone={m.totals.due > 0 ? "amber" : undefined} />
        <Kpi
          label="Carnets et courrier"
          value={m.packs.length}
          sub={`carnet(s) utilisable(s) · ${m.openMailCount} courrier(s) à remettre`}
          tone={m.openMailCount > 0 ? "amber" : undefined}
        />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "profile", label: "Profil" },
          { value: "bookings", label: "Réservations" },
          { value: "subscriptions", label: "Abonnements" },
          { value: "packs", label: "Carnets" },
          { value: "account", label: "Compte" },
          { value: "mail", label: "Courrier" },
        ]}
      />
      {tab === "profile" ? <ProfileTab member={m} /> : null}
      {tab === "bookings" ? <BookingsTab memberId={m.id} /> : null}
      {tab === "subscriptions" ? <SubscriptionsTab member={m} /> : null}
      {tab === "packs" ? <PacksTab member={m} /> : null}
      {tab === "account" ? <AccountTab memberId={m.id} /> : null}
      {tab === "mail" ? <MailTab member={m} /> : null}
      {collect.element}
    </>
  );
}
