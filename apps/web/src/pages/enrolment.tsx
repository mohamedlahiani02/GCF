import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { GroupDetail, GroupRow, StudentRow, Study, TrainingDetail } from "../api/types";
import { useSession } from "../auth/session";
import { usePage, useCollect } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, PageHeader, Segmented } from "../components/ui";
import { frDate, tnd, todayIso, tryParseTnd, weekdayLabel } from "../lib/format";
import { FORMULA, FORMULA_HELP, formulaText, type FormulaKind } from "../lib/formulas";
import { PAYMENT_MODE } from "../lib/labels";
import { StudentFormModal } from "./students";

interface TrainingRow {
  id: string;
  title: string;
  category: string | null;
  price: number;
  formulaKinds: FormulaKind[];
  status: string;
  openSessions: number;
}
interface PreviewResult {
  lines: { label: string; amount: number; dueDate: string }[];
  discount: { amount: number; reason: string } | null;
  total: number;
}
type PaymentMode = "full" | "installments" | "monthly" | "per_session";
type Offer = { kind: "study"; study: Study } | { kind: "training"; training: TrainingRow };

const STEPS = ["Élève", "Offre", "Groupe", "Paiement", "Récapitulatif", "Premier paiement"];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="row" style={{ gap: 8, listStyle: "none", padding: 0, margin: 0, flexWrap: "wrap" }} aria-label="Étapes">
      {STEPS.map((label, i) => (
        <li key={label} aria-current={i === step ? "step" : undefined}>
          <Badge tone={i < step ? "green" : i === step ? "blue" : "neutral"}>
            {i + 1}. {label}
          </Badge>
        </li>
      ))}
    </ol>
  );
}

function StudentStep({ onPick }: { onPick: (s: StudentRow) => void }) {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const { can } = useSession();
  const list = useQuery({
    queryKey: ["students", "pick", q],
    queryFn: () => api.get<{ items: StudentRow[] }>("/students", { q, pageSize: 10, status: "active" }),
    enabled: q.trim().length >= 2,
  });
  return (
    <div className="stack">
      <Field label="Rechercher un élève existant">
        <input className="input" autoFocus placeholder="Nom ou téléphone" value={q} onChange={(e) => setQ(e.target.value)} />
      </Field>
      <ErrorBanner error={list.error} />
      {list.data ? (
        list.data.items.length ? (
          <div className="card xs">
            <table className="tbl">
              <tbody>
                {list.data.items.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => onPick(s)}>
                    <td>
                      {s.lastName} {s.firstName} {s.isMinor ? <Badge tone="amber">Mineur</Badge> : null}
                    </td>
                    <td>{s.phone ?? s.guardianPhone ?? ""}</td>
                    <td>{s.activeGroups?.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="cap">Aucun élève trouvé.</div>
        )
      ) : null}
      {can("students:write") ? (
        <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setCreating(true)}>
          + Créer une nouvelle fiche élève
        </button>
      ) : null}
      {creating ? (
        <StudentFormModal
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            setCreating(false);
            onPick(s);
          }}
        />
      ) : null}
    </div>
  );
}

function OfferStep({ onPick }: { onPick: (o: Offer) => void }) {
  const [kind, setKind] = useState<"study" | "training">("study");
  const studies = useQuery({ queryKey: ["studies"], queryFn: () => api.get<Study[]>("/catalogue/studies") });
  const trainings = useQuery({ queryKey: ["trainings"], queryFn: () => api.get<TrainingRow[]>("/catalogue/trainings") });
  return (
    <div className="stack">
      <Segmented
        label="Type d'offre"
        value={kind}
        onChange={setKind}
        options={[
          { value: "study", label: "Cours particulier" },
          { value: "training", label: "Formation" },
        ]}
      />
      <ErrorBanner error={studies.error ?? trainings.error} />
      <div className="card xs">
        <table className="tbl">
          <thead>
            <tr>
              <th>{kind === "study" ? "Cours particulier" : "Formation"}</th>
              <th>Facturation</th>
              <th className="num">Prix (TND)</th>
              <th>{kind === "study" ? "Groupes" : "Sessions ouvertes"}</th>
            </tr>
          </thead>
          <tbody>
            {kind === "study"
              ? (studies.data ?? [])
                  .filter((s) => s.status === "active")
                  .map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => onPick({ kind: "study", study: s })}>
                      <td>{s.name}</td>
                      <td>{s.billingMode === "monthly" ? "Mensuelle" : "À la séance"}</td>
                      <td className="num">{tnd(s.price)}</td>
                      <td>{s.groupCount}</td>
                    </tr>
                  ))
              : (trainings.data ?? [])
                  .filter((t) => t.status === "active")
                  .map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => onPick({ kind: "training", training: t })}>
                      <td>
                        {t.title}
                        {t.category ? <div className="cap">{t.category}</div> : null}
                      </td>
                      <td>{t.formulaKinds.length ? t.formulaKinds.map((k) => FORMULA[k]).join(", ") : "Aucune formule"}</td>
                      <td className="num">{tnd(t.price)}</td>
                      <td>{t.openSessions}</td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupStep({ offer, onPick }: { offer: Offer; onPick: (g: GroupDetail) => void }) {
  const training = useQuery({
    queryKey: ["training", offer.kind === "training" ? offer.training.id : null],
    queryFn: () => api.get<TrainingDetail>(`/catalogue/trainings/${(offer as { training: TrainingRow }).training.id}`),
    enabled: offer.kind === "training",
  });
  const sessionIds = offer.kind === "training" ? (training.data?.sessions ?? []).filter((s) => s.status === "open").map((s) => s.id) : [];
  const groups = useQuery({
    queryKey: ["groups", "offer", offer.kind === "study" ? offer.study.id : sessionIds.join(",")],
    queryFn: async () =>
      offer.kind === "study"
        ? api.get<GroupRow[]>("/groups", { studyId: offer.study.id })
        : (await Promise.all(sessionIds.map((id) => api.get<GroupRow[]>("/groups", { trainingSessionId: id })))).flat(),
    enabled: offer.kind === "study" || training.isSuccess,
  });
  const [picking, setPicking] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ["group", picking], queryFn: () => api.get<GroupDetail>(`/groups/${picking}`), enabled: !!picking });
  useEffect(() => {
    if (detail.data) onPick(detail.data);
  }, [detail.data, onPick]);
  if (groups.isPending) return <Loading />;
  return (
    <div className="stack">
      <ErrorBanner error={groups.error ?? training.error ?? detail.error} />
      {groups.data && groups.data.length === 0 ? (
        <Empty
          title="Aucun groupe actif"
          text="Créez d'abord un groupe pour cette offre."
          action={
            <Link to="/groupes/nouveau" className="btn">
              Créer un groupe
            </Link>
          }
        />
      ) : (
        <div className="card xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Groupe</th>
                <th>Intervenant</th>
                <th>Salle</th>
                <th>Période</th>
                <th>Places</th>
              </tr>
            </thead>
            <tbody>
              {groups.data?.map((g) => {
                const full = g.enrolledCount >= g.capacity;
                return (
                  <tr key={g.id} className={full ? "dim" : "clickable"} onClick={() => !full && setPicking(g.id)} aria-disabled={full}>
                    <td>{g.name}</td>
                    <td>
                      {g.instructorLastName} {g.instructorFirstName}
                    </td>
                    <td>{g.roomName ?? ""}</td>
                    <td>
                      {frDate(g.startDate)} au {frDate(g.endDate)}
                    </td>
                    <td>{full ? <Badge tone="red">Complet</Badge> : `${g.enrolledCount}/${g.capacity}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function EnrolmentWizardPage() {
  usePage(["Élèves", "Nouvelle inscription"]);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const collect = useCollect();
  const toast = useToast();
  const { can } = useSession();
  const [step, setStep] = useState(0);
  const [student, setStudent] = useState<StudentRow | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("monthly");
  const [planId, setPlanId] = useState("");
  const [firstDueDate, setFirstDueDate] = useState("");
  const [withDiscount, setWithDiscount] = useState(false);
  const [discountKind, setDiscountKind] = useState<"percent" | "amount">("percent");
  const [discountText, setDiscountText] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [created, setCreated] = useState<{ id: string } | null>(null);

  const preset = params.get("eleve");
  const presetStudent = useQuery({ queryKey: ["student", preset], queryFn: () => api.get<StudentRow>(`/students/${preset}`), enabled: !!preset && !student });
  useEffect(() => {
    if (presetStudent.data && !student) {
      setStudent(presetStudent.data);
      setStep(1);
    }
  }, [presetStudent.data, student]);

  const presetGroupId = params.get("groupe");
  const presetGroup = useQuery({
    queryKey: ["enrolment-preset-group", presetGroupId],
    queryFn: async (): Promise<{ group: GroupDetail; offer: Offer } | null> => {
      const g = await api.get<GroupDetail>(`/groups/${presetGroupId}`);
      if (g.kind === "study") {
        const study = (await api.get<Study[]>("/catalogue/studies")).find((s) => s.id === g.studyId);
        return study ? { group: g, offer: { kind: "study", study } } : null;
      }
      const row = (await api.get<TrainingRow[]>("/catalogue/trainings")).find((t) => t.id === g.trainingId);
      return row ? { group: g, offer: { kind: "training", training: row } } : null;
    },
    enabled: !!presetGroupId,
  });

  const training = useQuery({
    queryKey: ["training", offer?.kind === "training" ? offer.training.id : null],
    queryFn: () => api.get<TrainingDetail>(`/catalogue/trainings/${(offer as { training: TrainingRow }).training.id}`),
    enabled: offer?.kind === "training",
  });
  const plans = (training.data?.plans ?? []).filter((p) => p.status === "active");
  const selectedPlan = plans.find((p) => p.id === planId);

  const discountValue = (() => {
    if (!withDiscount) return null;
    if (discountKind === "percent") {
      const n = Number(discountText.replace(",", "."));
      return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 100) : null;
    }
    return tryParseTnd(discountText);
  })();
  const body =
    student && group
      ? {
          studentId: student.id,
          groupId: group.id,
          effectiveDate,
          ...(group.kind === "training" ? (planId ? { planId } : {}) : { paymentMode }),
          ...(firstDueDate && (paymentMode === "monthly" || paymentMode === "full") ? { firstDueDate } : {}),
          ...(withDiscount && discountValue && discountReason.trim()
            ? { discount: { kind: discountKind, value: discountValue, reason: discountReason.trim() } }
            : {}),
        }
      : null;
  const preview = useQuery({
    queryKey: ["enrolment-preview", body],
    queryFn: () => api.post<PreviewResult>("/enrolments/preview", body),
    enabled: !!body && step >= 3 && (group?.kind !== "training" || !!planId),
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/enrolments", body),
    onSuccess: (r) => {
      setCreated(r);
      toast(
        withDiscount && !can("discounts:approve") ? "Inscription enregistrée. La remise attend la validation de l'administrateur." : "Inscription enregistrée.",
      );
      setStep(5);
    },
  });

  const pickGroup = useCallback((g: GroupDetail) => {
    setGroup(g);
    setPlanId("");
    if (g.kind === "study") setPaymentMode(g.billingMode ?? "monthly");
    setEffectiveDate((d) => (g.startDate > d ? g.startDate : d));
    setStep(3);
  }, []);

  useEffect(() => {
    if (student && presetGroup.data && !offer) {
      setOffer(presetGroup.data.offer);
      pickGroup(presetGroup.data.group);
    }
  }, [student, presetGroup.data, offer, pickGroup]);

  // A training is enrolled under one of its formulas; the default formula is preselected.
  useEffect(() => {
    if (group?.kind !== "training" || planId || plans.length === 0) return;
    const chosen = plans.find((p) => p.isDefault) ?? plans[0]!;
    setPlanId(chosen.id);
    setPaymentMode(chosen.kind);
  }, [group, planId, plans]);

  const choosePlan = (id: string) => {
    const plan = plans.find((p) => p.id === id);
    setPlanId(id);
    if (plan) {
      setPaymentMode(plan.kind);
      if (plan.kind === "per_session") setWithDiscount(false);
    }
  };

  return (
    <>
      <PageHeader title="Nouvelle inscription" />
      <Stepper step={step} />
      <div className="grid2" style={{ gridTemplateColumns: "2fr 1fr", alignItems: "start" }}>
        <Card title={STEPS[step]}>
          <div className="card-b stack">
            {step === 0 ? (
              <StudentStep
                onPick={(s) => {
                  setStudent(s);
                  setStep(1);
                }}
              />
            ) : null}
            {step === 1 ? (
              <OfferStep
                onPick={(o) => {
                  setOffer(o);
                  setGroup(null);
                  setPlanId("");
                  setStep(2);
                }}
              />
            ) : null}
            {step === 2 && offer ? <GroupStep offer={offer} onPick={pickGroup} /> : null}
            {step === 3 && group ? (
              <>
                <Field label="Date d'effet *" hint={`Le groupe se déroule du ${frDate(group.startDate)} au ${frDate(group.endDate)}.`}>
                  <input
                    className="input"
                    type="date"
                    min={group.startDate}
                    max={group.endDate}
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                  />
                </Field>
                {group.kind === "study" ? (
                  <div>
                    <div className="lab" style={{ marginBottom: 6 }}>
                      Mode de paiement
                    </div>
                    <Badge tone="blue">{PAYMENT_MODE[paymentMode]}</Badge>
                    {paymentMode === "per_session" ? (
                      <div className="cap" style={{ marginTop: 6 }}>
                        Chaque séance validée sur la feuille de présence crée une échéance au tarif du groupe.
                      </div>
                    ) : null}
                  </div>
                ) : training.isPending ? (
                  <Loading />
                ) : plans.length === 0 ? (
                  <div className="ban ban-amber">
                    <span>
                      Cette formation n'a aucune formule active. Ajoutez-en une depuis la{" "}
                      <Link to={`/formations/${training.data?.id ?? ""}`}>fiche de la formation</Link>.
                    </span>
                  </div>
                ) : (
                  <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
                    <legend className="lab" style={{ marginBottom: 6 }}>
                      Formule *
                    </legend>
                    {plans.map((p) => (
                      <label key={p.id} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                        <input type="radio" name="formula" checked={planId === p.id} onChange={() => choosePlan(p.id)} />
                        <span>
                          <strong>{p.name}</strong> <Badge tone="gray">{FORMULA[p.kind]}</Badge> {p.isDefault ? <Badge tone="blue">Par défaut</Badge> : null}
                          <div className="cap">{formulaText(p, training.data?.price ?? group.effective.price)}</div>
                        </span>
                      </label>
                    ))}
                    {planId ? <div className="cap">{FORMULA_HELP[paymentMode]}</div> : null}
                  </fieldset>
                )}
                {paymentMode === "monthly" || paymentMode === "full" ? (
                  <Field label="Première échéance" hint="Par défaut, la date d'effet.">
                    <input className="input" type="date" value={firstDueDate} onChange={(e) => setFirstDueDate(e.target.value)} />
                  </Field>
                ) : null}
                {paymentMode !== "per_session" ? (
                  <label className="row center" style={{ gap: 8 }}>
                    <input type="checkbox" className="chk" checked={withDiscount} onChange={(e) => setWithDiscount(e.target.checked)} /> Appliquer une remise
                  </label>
                ) : null}
                {withDiscount ? (
                  <div className="stack">
                    <div className="grid2">
                      <Segmented
                        label="Type de remise"
                        value={discountKind}
                        onChange={setDiscountKind}
                        options={[
                          { value: "percent", label: "Pourcentage" },
                          { value: "amount", label: "Montant" },
                        ]}
                      />
                      <input
                        className="input num"
                        inputMode="decimal"
                        aria-label="Valeur de la remise"
                        placeholder={discountKind === "percent" ? "10" : "0,000"}
                        value={discountText}
                        onChange={(e) => setDiscountText(e.target.value)}
                      />
                    </div>
                    <Field label="Motif de la remise *">
                      <input className="input" value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} />
                    </Field>
                    {!can("discounts:approve") ? (
                      <div className="ban ban-amber">
                        <span>La remise sera appliquée après validation par l'administrateur.</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <ErrorBanner error={preview.error} />
              </>
            ) : null}
            {step === 4 && preview.data ? (
              <>
                {preview.data.lines.length === 0 ? (
                  <div className="cap">Facturation à la séance : aucune échéance n'est créée à l'avance.</div>
                ) : (
                  <div className="card xs">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Échéance</th>
                          <th>Date</th>
                          <th className="num">Montant (TND)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.data.lines.map((l, i) => (
                          <tr key={i}>
                            <td>{l.label}</td>
                            <td>{frDate(l.dueDate)}</td>
                            <td className="num">{tnd(l.amount)}</td>
                          </tr>
                        ))}
                        {preview.data.discount ? (
                          <tr>
                            <td colSpan={2}>
                              Remise : {preview.data.discount.reason} {!can("discounts:approve") ? <Badge tone="amber">À valider</Badge> : null}
                            </td>
                            <td className="num">-{tnd(preview.data.discount.amount)}</td>
                          </tr>
                        ) : null}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={2}>Total</td>
                          <td className="num">{tnd(preview.data.total)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                <ErrorBanner error={create.error} />
              </>
            ) : null}
            {step === 5 && created && student ? (
              <div className="stack">
                <div className="ban ban-green" role="status">
                  <strong>Inscription enregistrée</strong>
                  <span>
                    {student.firstName} {student.lastName} est inscrit(e) dans {group?.name}.
                  </span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {can("payments:write") ? (
                    <button type="button" className="btn btn-p btn-l" onClick={() => collect({ studentId: student.id })}>
                      Encaisser un premier paiement
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-l" onClick={() => navigate(`/eleves/${student.id}`)}>
                    Ouvrir la fiche élève
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          {step < 5 ? (
            <div className="card-f">
              <button type="button" className="btn" disabled={step === 0 || create.isPending} onClick={() => setStep(step - 1)}>
                Retour
              </button>
              {step === 3 ? (
                <button
                  type="button"
                  className="btn btn-p"
                  disabled={!preview.data || (group?.kind === "training" && !planId) || (withDiscount && (!discountValue || !discountReason.trim()))}
                  onClick={() => setStep(4)}
                >
                  Voir le récapitulatif
                </button>
              ) : step === 4 ? (
                <button type="button" className="btn btn-p" disabled={create.isPending} onClick={() => create.mutate()}>
                  Confirmer l'inscription
                </button>
              ) : null}
            </div>
          ) : null}
        </Card>
        <Card title="Résumé">
          <div className="card-b stack">
            <div>
              <div className="lab">Élève</div>
              <div>{student ? `${student.lastName} ${student.firstName}` : "À choisir"}</div>
            </div>
            <div>
              <div className="lab">Offre</div>
              <div>{offer ? (offer.kind === "study" ? offer.study.name : offer.training.title) : "À choisir"}</div>
            </div>
            <div>
              <div className="lab">Groupe</div>
              {group ? (
                <>
                  <div>{group.name}</div>
                  <div className="cap">
                    {group.slots.map((s) => `${weekdayLabel(s.weekday)} ${s.startTime}-${s.endTime}`).join(", ")} · {group.instructorFirstName}{" "}
                    {group.instructorLastName}
                  </div>
                  <div className="cap">
                    {group.kind === "study"
                      ? `Tarif : ${tnd(group.effective.price)} TND ${group.billingMode === "monthly" ? "par mois" : "par séance"}`
                      : selectedPlan
                        ? `Formule : ${selectedPlan.name}, ${formulaText(selectedPlan, group.effective.price)}`
                        : `Prix de la formation : ${tnd(group.effective.price)} TND`}
                  </div>
                </>
              ) : (
                <div>À choisir</div>
              )}
            </div>
            {preview.data ? (
              <div>
                <div className="lab">Total de l'échéancier</div>
                <strong className="num">{tnd(preview.data.total)} TND</strong>
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </>
  );
}
