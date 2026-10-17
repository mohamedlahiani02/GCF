import { CW_CATEGORY_LABELS, isBookableCategory } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, Money, ReasonDialog } from "../../components/ui";
import { tnd, tryParseTnd } from "../../lib/format";
import { CW_KEYS, type Entitlement, type Plan, type QuotaKind, type ResourceType } from "./api";
import { durationLabel, hoursText, parseHours, parseInteger } from "./helpers";

export const PERIOD: Record<Plan["period"], string> = { month: "Mensuelle", quarter: "Trimestrielle", year: "Annuelle" };
const BILLING: Record<Plan["billing"], string> = { upfront: "En une fois au début", monthly: "Chaque mois" };
const QUOTA_KIND: Record<QuotaKind, string> = { unlimited: "Illimité", minutes: "Heures", bookings: "Réservations" };

/** "Illimité", "20 h" or "8 réservations": an entitlement or a pack quota in words. */
export function quotaLabel(kind: QuotaKind, quota: number | null): string {
  if (kind === "unlimited" || quota === null) return "Illimité";
  return kind === "minutes" ? durationLabel(quota) : `${quota} réservation${quota > 1 ? "s" : ""}`;
}

interface EntitlementRow {
  included: boolean;
  kind: QuotaKind;
  quota: string;
}

function entitlementQuota(row: EntitlementRow): number | null {
  if (row.kind === "unlimited") return null;
  return row.kind === "minutes" ? parseHours(row.quota) : parseInteger(row.quota, 1, 1_000_000);
}

function PlanModal({ plan, types, onClose }: { plan: Plan | null; types: ResourceType[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const bookable = types.filter((t) => isBookableCategory(t.category));
  const assignable = types.filter((t) => !isBookableCategory(t.category));
  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [period, setPeriod] = useState<Plan["period"]>(plan?.period ?? "month");
  const [billing, setBilling] = useState<Plan["billing"]>(plan?.billing ?? "upfront");
  const [price, setPrice] = useState(plan ? tnd(plan.price) : "");
  const [domiciliation, setDomiciliation] = useState(plan?.includesDomiciliation ?? false);
  const [assignedTypeId, setAssignedTypeId] = useState(plan?.assignedTypeId ?? "");
  const [notice, setNotice] = useState(String(plan?.noticeDays ?? 0));
  const [isPublic, setPublic] = useState(plan?.public ?? true);
  const [position, setPosition] = useState(String(plan?.position ?? 0));
  const [rows, setRows] = useState<Record<string, EntitlementRow>>(() =>
    Object.fromEntries(
      bookable.map((t) => {
        const e = plan?.entitlements.find((x) => x.typeId === t.id);
        const quota = e?.quota ?? null;
        return [
          t.id,
          { included: !!e, kind: e?.quotaKind ?? "unlimited", quota: quota === null ? "" : e?.quotaKind === "minutes" ? hoursText(quota) : String(quota) },
        ];
      }),
    ),
  );
  const dropped = (plan?.entitlements ?? []).filter((e) => !bookable.some((t) => t.id === e.typeId));
  const priceValue = tryParseTnd(price);
  const noticeValue = parseInteger(notice, 0, 365);
  const positionValue = parseInteger(position, 0, 10_000);
  const effectiveBilling = period === "month" ? "upfront" : billing;
  const entitlementErrors = Object.fromEntries(
    Object.entries(rows).map(([typeId, row]) => [typeId, row.included && row.kind !== "unlimited" && entitlementQuota(row) === null]),
  );
  const valid =
    name.trim() !== "" &&
    priceValue !== null &&
    priceValue > 0 &&
    noticeValue !== null &&
    positionValue !== null &&
    !Object.values(entitlementErrors).some(Boolean);
  const save = useMutation({
    mutationFn: () => {
      const entitlements = Object.entries(rows)
        .filter(([, row]) => row.included)
        .map(([typeId, row]) => ({ typeId, quotaKind: row.kind, quota: entitlementQuota(row) }));
      const body = {
        name: name.trim(),
        description: description.trim(),
        period,
        billing: effectiveBilling,
        price: priceValue,
        includesDomiciliation: domiciliation,
        assignedTypeId: assignedTypeId || null,
        noticeDays: noticeValue,
        public: isPublic,
        position: positionValue,
        entitlements,
      };
      return plan ? api.patch(`/coworking/plans/${plan.id}`, body) : api.post("/coworking/plans", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.plans });
      toast(plan ? "Formule modifiée. Les abonnements déjà vendus gardent leurs conditions." : "Formule d'abonnement créée.");
      onClose();
    },
  });
  const setRow = (typeId: string, change: Partial<EntitlementRow>) => setRows({ ...rows, [typeId]: { ...rows[typeId]!, ...change } });
  return (
    <Modal
      title={plan ? `Modifier ${plan.name}` : "Nouvelle formule d'abonnement"}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="cap">Les changements valent pour les nouveaux abonnements et les renouvellements</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Nom *" hint="Par exemple : Nomade 10 jours, Résident, Domiciliation.">
          <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Prix de la période (TND) *" error={price.trim() && (priceValue === null || priceValue <= 0) ? "Montant invalide" : null}>
          <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
      </div>
      <Field label="Description" hint="Présentée aux clients sur le site et dans l'espace client.">
        <textarea className="input" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid3">
        <Field label="Période">
          <select className="input" value={period} onChange={(e) => setPeriod(e.target.value as Plan["period"])}>
            {Object.entries(PERIOD).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Facturation"
          hint={period === "month" ? "Une formule mensuelle se paie en une fois." : "Mensuelle : une échéance par mois de la période."}
        >
          <select className="input" value={effectiveBilling} disabled={period === "month"} onChange={(e) => setBilling(e.target.value as Plan["billing"])}>
            {Object.entries(BILLING).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Préavis de résiliation (jours)" error={noticeValue === null ? "Entre 0 et 365." : null}>
          <input className="input num" type="number" min={0} max={365} value={notice} onChange={(e) => setNotice(e.target.value)} />
        </Field>
      </div>
      <div className="grid3">
        <Field label="Espace attribué" hint="Bureau dédié ou bureau privé réservé à l'abonné pendant toute la période.">
          <select className="input" value={assignedTypeId} onChange={(e) => setAssignedTypeId(e.target.value)}>
            <option value="">Aucun</option>
            {assignable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({CW_CATEGORY_LABELS.fr[t.category]})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ordre d'affichage" error={positionValue === null ? "Un nombre entier positif." : null}>
          <input className="input num" type="number" min={0} value={position} onChange={(e) => setPosition(e.target.value)} />
        </Field>
      </div>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={domiciliation} onChange={(e) => setDomiciliation(e.target.checked)} />
        Comprend la domiciliation et la gestion du courrier
      </label>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
        Visible sur le site et dans l'espace client
      </label>
      <h3 className="h2">Droits de réservation</h3>
      <span className="cap">Ce que l'abonnement couvre sur les espaces réservables. Les quotas repartent à zéro chaque mois d'abonnement.</span>
      {bookable.length === 0 ? (
        <span className="cap">Aucun type d'espace réservable.</span>
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Type d'espace</th>
                <th>Droit</th>
                <th>Quota par mois</th>
              </tr>
            </thead>
            <tbody>
              {bookable.map((t) => {
                const row = rows[t.id]!;
                return (
                  <tr key={t.id}>
                    <td>
                      <label className="row center" style={{ gap: 8 }}>
                        <input type="checkbox" className="chk" checked={row.included} onChange={(e) => setRow(t.id, { included: e.target.checked })} />
                        {t.name}
                      </label>
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`Droit sur ${t.name}`}
                        disabled={!row.included}
                        value={row.kind}
                        onChange={(e) => setRow(t.id, { kind: e.target.value as QuotaKind })}
                      >
                        {Object.entries(QUOTA_KIND).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {row.included && row.kind !== "unlimited" ? (
                        <div className="stack" style={{ gap: 2 }}>
                          <input
                            className={`input num${entitlementErrors[t.id] ? " err" : ""}`}
                            inputMode="decimal"
                            aria-label={row.kind === "minutes" ? `Heures par mois sur ${t.name}` : `Réservations par mois sur ${t.name}`}
                            value={row.quota}
                            onChange={(e) => setRow(t.id, { quota: e.target.value })}
                          />
                          <span className="cap">{row.kind === "minutes" ? "En heures, par exemple 20 ou 7,5" : "Nombre de réservations"}</span>
                        </div>
                      ) : (
                        <span className="cap">{row.included ? "Sans limite" : "-"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {dropped.length ? (
        <div className="ban ban-amber">
          Droits sur des types archivés ou attribués, retirés à l'enregistrement : {dropped.map((e) => e.typeName).join(", ")}.
        </div>
      ) : null}
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function entitlementsSummary(entitlements: Entitlement[]): string {
  if (!entitlements.length) return "";
  return entitlements.map((e) => `${e.typeName} : ${quotaLabel(e.quotaKind, e.quota)}`).join(" ; ");
}

/** Subscription plans sold at the desk and shown in the portal. */
export function PlansCard({ types }: { types: ResourceType[] }) {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const [archiving, setArchiving] = useState<Plan | null>(null);
  const plans = useQuery({ queryKey: CW_KEYS.plans, queryFn: () => api.get<Plan[]>("/coworking/plans") });
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  return (
    <>
      <Card
        title="Formules d'abonnement"
        actions={
          <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
            + Formule
          </button>
        }
      >
        <ErrorBanner error={plans.error} retry={() => plans.refetch()} />
        {plans.isPending ? (
          <Loading />
        ) : !plans.data?.length ? (
          <Empty title="Aucune formule" text="Créez les abonnements proposés : mensuel nomade, résident avec bureau dédié, domiciliation." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Formule</th>
                  <th>Période et facturation</th>
                  <th className="num">Prix</th>
                  <th>Comprend</th>
                  <th className="num">Abonnés</th>
                  <th>Visibilité</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plans.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.noticeDays ? <div className="cap">Préavis de {p.noticeDays} jours</div> : null}
                    </td>
                    <td>
                      {PERIOD[p.period]}
                      <div className="cap">{BILLING[p.billing]}</div>
                    </td>
                    <td className="num">
                      <Money value={p.price} />
                    </td>
                    <td>
                      <div className="stack" style={{ gap: 2 }}>
                        {p.assignedTypeId ? <span>Espace attribué : {typeName.get(p.assignedTypeId) ?? "type archivé"}</span> : null}
                        {p.includesDomiciliation ? <span>Domiciliation</span> : null}
                        {p.entitlements.length ? <span className="cap">{entitlementsSummary(p.entitlements)}</span> : null}
                        {!p.assignedTypeId && !p.includesDomiciliation && !p.entitlements.length ? <span className="cap">-</span> : null}
                      </div>
                    </td>
                    <td className="num">{p.subscriptionCount}</td>
                    <td>{p.public ? <Badge tone="green">Public</Badge> : <Badge tone="gray">Interne</Badge>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="btn btn-g" onClick={() => setEditing(p)}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn-g" onClick={() => setArchiving(p)}>
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
      {editing ? <PlanModal plan={editing === "new" ? null : editing} types={types} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver la formule"
          explanation={`${archiving.name} n'est plus proposée à la vente. ${
            archiving.subscriptionCount
              ? `Les ${archiving.subscriptionCount} abonnement(s) en cours continuent jusqu'à leur fin mais ne pourront plus être renouvelés.`
              : "Aucun abonnement en cours."
          }`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/plans/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.plans });
            toast("Formule archivée.");
          }}
        />
      ) : null}
    </>
  );
}
