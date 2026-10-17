import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Pagination, ReasonDialog, Segmented } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { frDate, tnd, todayIso } from "../../lib/format";
import { BILLING, PERIOD, SUBSCRIPTION_STATE, type Page, type Plan, type Resource, type Subscription } from "./api";

const PAGE_SIZE = 25;

/** Sells a plan to a member: start date, the resource a dedicated plan assigns, automatic renewal. */
export function SellSubscriptionModal({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const plans = useQuery({ queryKey: ["cw-plans"], queryFn: () => api.get<Plan[]>("/coworking/plans") });
  const [planId, setPlanId] = useState("");
  const plan = plans.data?.find((p) => p.id === planId) ?? plans.data?.[0];
  const [startsOn, setStartsOn] = useState(todayIso());
  const [resourceId, setResourceId] = useState("");
  const [autoRenew, setAutoRenew] = useState(false);
  const resources = useQuery({
    queryKey: ["cw-resources", plan?.assignedTypeId],
    queryFn: () => api.get<Resource[]>("/coworking/resources", { typeId: plan!.assignedTypeId, status: "active" }),
    enabled: !!plan?.assignedTypeId,
  });
  const client = useQueryClient();
  const toast = useToast();
  const assigned = plan?.assignedTypeId ? resourceId || resources.data?.[0]?.id || "" : null;
  const save = useMutation({
    mutationFn: () => api.post<Subscription>("/coworking/subscriptions", { memberId, planId: plan!.id, startsOn, assignedResourceId: assigned, autoRenew }),
    onSuccess: async (s) => {
      await client.invalidateQueries();
      toast(`Abonnement ${s.planName} vendu jusqu'au ${frDate(s.endsOn)}.`);
      onClose();
    },
  });
  return (
    <Modal
      title="Vendre un abonnement"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Les échéances sont créées à la vente, réglables depuis l'onglet Compte.</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!plan || assigned === "" || save.isPending} onClick={() => save.mutate()}>
              Vendre
            </button>
          </div>
        </>
      }
    >
      {plans.isPending ? (
        <Loading />
      ) : !plans.data?.length ? (
        <div className="ban ban-amber">
          <span>Aucune formule active : créez-les dans les paramètres coworking.</span>
        </div>
      ) : (
        <>
          <Field label="Formule">
            <select className="input" autoFocus value={plan?.id ?? ""} onChange={(e) => (setPlanId(e.target.value), setResourceId(""))}>
              {plans.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {PERIOD[p.period]} · {tnd(p.price)} TND
                </option>
              ))}
            </select>
          </Field>
          {plan ? (
            <span className="cap">
              {BILLING[plan.billing]}
              {plan.includesDomiciliation ? ", domiciliation incluse" : ""}
            </span>
          ) : null}
          <div className="grid2">
            <Field label="Début">
              <input className="input" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </Field>
            {plan?.assignedTypeId ? (
              <Field label="Ressource attribuée" error={resources.data && !resources.data.length ? "Aucune ressource active de ce type" : null}>
                <select className="input" value={assigned ?? ""} onChange={(e) => setResourceId(e.target.value)}>
                  {(resources.data ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.code} · {r.floorName}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
          <label className="row center" style={{ gap: 8 }}>
            <input type="checkbox" className="chk" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
            <span>Renouvellement automatique à la fin de la période</span>
          </label>
        </>
      )}
      <ErrorBanner error={plans.error ?? save.error} />
    </Modal>
  );
}

/** Résiliation: the subscription ends earlier; unpaid charges due after the new end are cancelled. */
function TerminateModal({ subscription, onClose }: { subscription: Subscription; onClose: () => void }) {
  const today = todayIso();
  const [endsOn, setEndsOn] = useState(today > subscription.startsOn ? today : subscription.startsOn);
  const [reason, setReason] = useState("");
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.post(`/coworking/subscriptions/${subscription.id}/terminate`, { endsOn, reason: reason.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast(`Abonnement résilié au ${frDate(endsOn)}.`);
      onClose();
    },
  });
  return (
    <Modal
      title="Résilier l'abonnement"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Action tracée au journal d'audit</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Retour
            </button>
            <button type="button" className="btn btn-d" disabled={!reason.trim() || save.isPending} onClick={() => save.mutate()}>
              Résilier
            </button>
          </div>
        </>
      }
    >
      <div>
        {subscription.planName}, du {frDate(subscription.startsOn)} au {frDate(subscription.endsOn)}. Les échéances non payées dues après la nouvelle fin sont
        annulées et le renouvellement automatique est arrêté.
      </div>
      <Field label="Nouvelle date de fin">
        <input className="input" type="date" min={today} max={subscription.endsOn} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
      </Field>
      <Field label="Motif (obligatoire)">
        <textarea className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** Subscriptions with their state, money due and the actions of the desk (renew, auto-renew, terminate, cancel). */
export function SubscriptionsTable({ items, showMember }: { items: Subscription[]; showMember: boolean }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [terminating, setTerminating] = useState<Subscription | null>(null);
  const [cancelling, setCancelling] = useState<Subscription | null>(null);
  const act = useMutation({
    mutationFn: (input: { id: string; action: "renew" } | { id: string; action: "auto-renew"; autoRenew: boolean }) =>
      input.action === "renew"
        ? api.post<Subscription>(`/coworking/subscriptions/${input.id}/renew`)
        : api.put<Subscription>(`/coworking/subscriptions/${input.id}/auto-renew`, { autoRenew: input.autoRenew }),
    onSuccess: async (s, input) => {
      await client.invalidateQueries();
      toast(
        input.action === "renew"
          ? `Abonnement renouvelé du ${frDate(s.startsOn)} au ${frDate(s.endsOn)}.`
          : s.autoRenew
            ? "Renouvellement automatique activé."
            : "Renouvellement automatique arrêté.",
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
              {showMember ? <th>Membre</th> : null}
              <th>Formule</th>
              <th>Période</th>
              <th className="num">Prix (TND)</th>
              <th className="num">Reste dû</th>
              <th>Statut</th>
              <th>Renouvellement</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => {
              const st = SUBSCRIPTION_STATE[s.state];
              const live = s.status === "active";
              return (
                <tr key={s.id} className={s.status === "cancelled" ? "void" : ""}>
                  {showMember ? (
                    <td>
                      <Link to={`/coworking/membres/${s.memberId}`}>{s.memberName}</Link>
                    </td>
                  ) : null}
                  <td>
                    {s.planName}
                    <div className="cap">
                      {BILLING[s.billing]}
                      {s.assignedResourceCode ? ` · ${s.assignedResourceCode}` : ""}
                      {s.includesDomiciliation ? " · domiciliation" : ""}
                    </div>
                  </td>
                  <td>
                    {frDate(s.startsOn)} au {frDate(s.endsOn)}
                    {s.cancelReason ? <div className="cap">{s.cancelReason}</div> : null}
                  </td>
                  <td className="num">{tnd(s.price)}</td>
                  <td className="num">
                    {tnd(s.due)}
                    {s.overdue > 0 ? <div className="cap">dont {tnd(s.overdue)} échu</div> : null}
                  </td>
                  <td>
                    <Badge tone={s.overdue > 0 && live ? "red" : st.tone}>{s.overdue > 0 && live ? "Impayé" : st.label}</Badge>
                  </td>
                  <td>
                    {s.renewalId ? (
                      <span className="cap">Renouvelé</span>
                    ) : live && write && s.state !== "ended" ? (
                      <label className="row center" style={{ gap: 6 }}>
                        <input
                          type="checkbox"
                          className="chk"
                          checked={s.autoRenew}
                          disabled={act.isPending}
                          onChange={(e) => act.mutate({ id: s.id, action: "auto-renew", autoRenew: e.target.checked })}
                        />
                        <span className="cap">Automatique</span>
                      </label>
                    ) : (
                      <span className="cap">{s.autoRenew ? "Automatique" : "Manuel"}</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {write && live && !s.renewalId && s.state !== "upcoming" ? (
                      <button type="button" className="btn btn-g" disabled={act.isPending} onClick={() => act.mutate({ id: s.id, action: "renew" })}>
                        Renouveler
                      </button>
                    ) : null}
                    {write && live && s.state !== "ended" ? (
                      <button type="button" className="btn btn-g" onClick={() => setTerminating(s)}>
                        Résilier
                      </button>
                    ) : null}
                    {write && live ? (
                      <button type="button" className="btn btn-g" onClick={() => setCancelling(s)}>
                        Annuler
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {terminating ? <TerminateModal subscription={terminating} onClose={() => setTerminating(null)} /> : null}
      {cancelling ? (
        <ReasonDialog
          title="Annuler l'abonnement"
          danger
          explanation="L'annulation corrige une erreur de saisie : elle n'est possible que si aucun paiement n'a été reçu. Les échéances non payées sont annulées. Pour arrêter un abonnement en cours, résiliez-le."
          confirmLabel="Annuler l'abonnement"
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/subscriptions/${cancelling.id}/cancel`, { reason });
            await client.invalidateQueries();
            toast("Abonnement annulé.");
          }}
        />
      ) : null}
    </>
  );
}

type Filter = "current" | "ending" | "unpaid" | "upcoming" | "ended";

const FILTER_QUERY: Record<Filter, Record<string, string | number>> = {
  current: { status: "current" },
  ending: { status: "current", endingWithinDays: 30 },
  unpaid: { status: "all", unpaid: "true" },
  upcoming: { status: "upcoming" },
  ended: { status: "ended" },
};

/** Every subscription of the centre, filtered for the desk's follow-up: running, ending soon, unpaid, upcoming, ended. */
export function SubscriptionsPage() {
  usePage(["Coworking", "Abonnements"]);
  const [filter, setFilter] = useState<Filter>("current");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["cw-subscriptions", filter, page],
    queryFn: () => api.get<Page<Subscription>>("/coworking/subscriptions", { ...FILTER_QUERY[filter], page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Abonnements" subtitle="Un abonnement se vend depuis la fiche du membre." />
      <Segmented
        label="Filtre"
        value={filter}
        onChange={(f) => (setFilter(f), setPage(1))}
        options={[
          { value: "current", label: "En cours" },
          { value: "ending", label: "Fin sous 30 jours" },
          { value: "unpaid", label: "Impayés" },
          { value: "upcoming", label: "À venir" },
          { value: "ended", label: "Terminés" },
        ]}
      />
      <Card footer={list.data ? <Pagination page={page} hasMore={page * PAGE_SIZE < list.data.total} onPage={setPage} total={list.data.total} pageSize={PAGE_SIZE} /> : null}>
        <ErrorBanner error={list.error} retry={() => list.refetch()} />
        {list.isPending ? <Loading /> : list.data?.items.length === 0 ? <Empty title="Aucun abonnement" /> : <SubscriptionsTable items={list.data?.items ?? []} showMember />}
      </Card>
    </>
  );
}
