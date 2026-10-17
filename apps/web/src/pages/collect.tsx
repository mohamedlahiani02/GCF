import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Installment, Totals } from "../api/types";
import { useSession } from "../auth/session";
import { useToast } from "../components/toasts";
import { Drawer, ErrorBanner, Field, Segmented, StateBadge } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { frDate, tnd, tryParseTnd } from "../lib/format";

type Method = "cash" | "transfer" | "cheque" | "card";
/** Who pays: a student, a room renter or a coworking member (exactly one). */
export interface Payer {
  studentId?: string;
  renterId?: string;
  memberId?: string;
}
interface Preview {
  before: Totals;
  lines: { installmentId: string; label: string; dueDate: string; amount: number }[];
  advance: number;
  after: { due: number; credit: number };
}
export interface Created {
  paymentId: string;
  receipt: { id: string; number: string };
  advance: number;
  after: Totals;
}

interface PickRow {
  key: string;
  name: string;
  due?: number;
  payer: Payer;
}

function PayerPicker({ onPick }: { onPick: (payer: Payer, name: string) => void }) {
  const { can } = useSession();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"student" | "renter" | "member">("student");
  const searching = text.trim().length >= 2;
  const students = useQuery({
    queryKey: ["students-pick", text],
    queryFn: () => api.get<{ items: { id: string; firstName: string; lastName: string; due: number }[] }>("/students", { q: text, pageSize: 8 }),
    enabled: kind === "student" && searching,
  });
  const renters = useQuery({
    queryKey: ["renters"],
    queryFn: () => api.get<{ id: string; name: string; company: string | null }[]>("/renters"),
    enabled: kind === "renter",
  });
  const members = useQuery({
    queryKey: ["members-pick", text],
    queryFn: () =>
      api.get<{ items: { id: string; firstName: string; lastName: string | null; companyName: string | null; phone: string | null }[] }>("/coworking/members", {
        q: text,
        pageSize: 8,
      }),
    enabled: kind === "member" && searching,
  });
  const rows: PickRow[] =
    kind === "student"
      ? (students.data?.items ?? []).map((p) => ({ key: p.id, name: `${p.lastName} ${p.firstName}`, due: p.due, payer: { studentId: p.id } }))
      : kind === "renter"
        ? (renters.data ?? []).map((p) => ({ key: p.id, name: `${p.name}${p.company ? ` (${p.company})` : ""}`, payer: { renterId: p.id } }))
        : (members.data?.items ?? []).map((p) => ({
            key: p.id,
            name: `${[p.firstName, p.lastName].filter(Boolean).join(" ")}${p.companyName ? ` (${p.companyName})` : ""}`,
            payer: { memberId: p.id },
          }));
  return (
    <div className="stack">
      <Segmented
        label="Type de payeur"
        value={kind}
        onChange={setKind}
        options={[
          { value: "student", label: "Élève" },
          { value: "renter", label: "Loueur" },
          ...(can("coworking:read") ? [{ value: "member" as const, label: "Client coworking" }] : []),
        ]}
      />
      {kind === "student" ? (
        <Field label="1. Élève">
          <input className="input" autoFocus placeholder="Nom ou téléphone" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      ) : null}
      {kind === "member" ? (
        <Field label="1. Client coworking">
          <input className="input" autoFocus placeholder="Nom, téléphone, e-mail ou société" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      ) : null}
      <div className="card">
        {rows.map((p) => (
          <button
            key={p.key}
            type="button"
            className="btn btn-g"
            style={{ width: "100%", justifyContent: "space-between", borderRadius: 0 }}
            onClick={() => onPick(p.payer, p.name)}
          >
            <span>{p.name}</span>
            {p.due !== undefined ? <span className="cap">reste {tnd(p.due)} TND</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function accountPathOf(payer: Payer): string {
  if (payer.studentId) return `/students/${payer.studentId}/account`;
  if (payer.memberId) return `/coworking/members/${payer.memberId}/account`;
  return `/renters/${payer.renterId}/account`;
}

/** Records a payment for a payer; `onPaid` runs once the payment and its receipt are saved. */
export function CollectDrawer({ payer: initial, onClose, onPaid }: { payer: Payer; onClose: () => void; onPaid?: ((created: Created) => void) | undefined }) {
  const [payer, setPayer] = useState<Payer>(initial);
  const [payerName, setPayerName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [amountText, setAmountText] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeBank, setChequeBank] = useState("");
  const [reference, setReference] = useState("");
  const [done, setDone] = useState<Created | null>(null);
  const toast = useToast();
  const client = useQueryClient();
  const hasPayer = !!(payer.studentId || payer.renterId || payer.memberId);
  const accountPath = accountPathOf(payer);
  const account = useQuery({
    queryKey: ["account", accountPath],
    queryFn: () =>
      api.get<{
        totals: Totals;
        installments: Installment[];
        student?: { firstName: string; lastName: string };
        renter?: { name: string };
        member?: { firstName: string; lastName: string | null };
      }>(accountPath),
    enabled: hasPayer,
  });
  useEffect(() => {
    if (account.data?.student) setPayerName(`${account.data.student.firstName} ${account.data.student.lastName}`);
    if (account.data?.renter) setPayerName(account.data.renter.name);
    if (account.data?.member) setPayerName([account.data.member.firstName, account.data.member.lastName].filter(Boolean).join(" "));
  }, [account.data]);
  const open = useMemo(() => (account.data?.installments ?? []).filter((i) => i.kind === "charge" && i.status === "open" && i.remaining > 0), [account.data]);
  const amount = tryParseTnd(amountText);
  const selectedTotal = open.filter((i) => selected.includes(i.id)).reduce((s, i) => s + i.remaining, 0);

  const [debouncedAmount, setDebouncedAmount] = useState<number | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedAmount(amount), 300);
    return () => window.clearTimeout(t);
  }, [amount]);
  const preview = useQuery({
    queryKey: ["payment-preview", payer, selected, debouncedAmount],
    queryFn: () => api.post<Preview>("/payments/preview", { ...payer, amount: debouncedAmount, installmentIds: selected }),
    enabled: hasPayer && !!debouncedAmount && debouncedAmount > 0,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Created>("/payments", {
        ...payer,
        amount,
        method,
        installmentIds: selected,
        ...(method === "cheque" ? { cheque: { number: chequeNumber.trim(), bank: chequeBank.trim() } } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      }),
  });

  const submit = async (then: "print" | "mail" | "none") => {
    // The tab is opened before the request so the browser does not treat it as an unsolicited pop-up.
    const printWindow = then === "print" ? window.open("about:blank", "_blank") : null;
    let created: Created;
    try {
      created = await create.mutateAsync();
    } catch {
      printWindow?.close();
      return;
    }
    setDone(created);
    await client.invalidateQueries();
    toast(`Paiement enregistré. Reçu ${created.receipt.number} créé.`);
    onPaid?.(created);
    if (printWindow) printWindow.location.href = api.fileUrl(`/receipts/${created.receipt.id}/pdf`);
    if (then === "mail") {
      try {
        const sent = await api.post<{ status: string; recipient: string }>(`/receipts/${created.receipt.id}/send`);
        toast(
          sent.status === "sent" ? `Reçu envoyé à ${sent.recipient}.` : "L'envoi du reçu a échoué ; il est noté au journal d'envoi.",
          sent.status === "sent" ? "success" : "error",
        );
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }
  };

  const chequeOk = method !== "cheque" || (chequeNumber.trim() && chequeBank.trim());
  const canSubmit = hasPayer && amount !== null && amount > 0 && chequeOk && !create.isPending;

  return (
    <Drawer
      title="Encaisser un paiement"
      onClose={onClose}
      footer={
        done ? (
          <>
            <a className="btn btn-p btn-l" href={api.fileUrl(`/receipts/${done.receipt.id}/pdf`)} target="_blank" rel="noreferrer">
              Imprimer le reçu {done.receipt.number}
            </a>
            <button type="button" className="btn btn-l" onClick={onClose}>
              Terminer
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-p btn-l" disabled={!canSubmit} onClick={() => submit("print")}>
              Enregistrer et imprimer le reçu
            </button>
            <button type="button" className="btn btn-l" disabled={!canSubmit} onClick={() => submit("mail")}>
              Enregistrer et envoyer par e-mail
            </button>
            <button type="button" className="btn btn-l" disabled={!canSubmit} onClick={() => submit("none")}>
              Enregistrer
            </button>
          </>
        )
      }
    >
      {!hasPayer ? (
        <PayerPicker
          onPick={(p, name) => {
            setPayer(p);
            setPayerName(name);
          }}
        />
      ) : done ? (
        <div className="stack">
          <div className="ban ban-green" role="status">
            <strong>Paiement enregistré</strong>
            <span>Reçu {done.receipt.number}.</span>
          </div>
          {done.advance > 0 ? (
            <div className="ban ban-blue">
              <strong>Avance</strong>
              <span>{tnd(done.advance)} TND déposés en avance, imputés automatiquement aux prochaines échéances.</span>
            </div>
          ) : null}
          <div className="grid2">
            <div className="card kpi">
              <div className="lab">Reste à payer</div>
              <div className="amt">{tnd(done.after.due)}</div>
              <div className="cap">TND</div>
            </div>
            <div className="card kpi">
              <div className="lab">Solde créditeur</div>
              <div className="amt">{tnd(done.after.credit)}</div>
              <div className="cap">TND</div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="row between center">
            <div>
              <div className="lab">1. Payeur</div>
              <strong>{payerName || "…"}</strong>
            </div>
            {!initial.studentId && !initial.renterId && !initial.memberId ? (
              <button type="button" className="btn btn-g" onClick={() => (setPayer({}), setSelected([]))}>
                Changer
              </button>
            ) : null}
          </div>
          <ErrorBanner error={account.error} />
          <div className="grid2">
            <div className="card kpi" style={{ background: "var(--soft)" }}>
              <div className="lab">Reste à payer</div>
              <div className="amt">{tnd(account.data?.totals.due ?? 0)}</div>
              <div className="cap">TND</div>
            </div>
            <div className="card kpi" style={{ background: "var(--soft)" }}>
              <div className="lab">Solde créditeur</div>
              <div className="amt">{tnd(account.data?.totals.credit ?? 0)}</div>
              <div className="cap">TND</div>
            </div>
          </div>

          <div>
            <div className="lab" style={{ marginBottom: 6 }}>
              2. Échéances ouvertes (cochez celles à régler en priorité)
            </div>
            <div className="card xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 32 }} />
                    <th>Échéance</th>
                    <th>Statut</th>
                    <th className="num">Dû (TND)</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((i) => (
                    <tr key={i.id} className={selected.includes(i.id) ? "sel" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          className="chk"
                          aria-label={`Échéance du ${frDate(i.dueDate)}`}
                          checked={selected.includes(i.id)}
                          onChange={(e) => setSelected((list) => (e.target.checked ? [...list, i.id] : list.filter((x) => x !== i.id)))}
                        />
                      </td>
                      <td>
                        {frDate(i.dueDate)}
                        <div className="cap">{i.label}</div>
                        {i.dueDate !== i.originalDueDate ? <div className="cap">origine : {frDate(i.originalDueDate)}</div> : null}
                      </td>
                      <td>
                        <StateBadge state={i.state} />
                      </td>
                      <td className="num">{tnd(i.remaining)}</td>
                    </tr>
                  ))}
                  {open.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="cap">
                        Aucune échéance ouverte : un paiement sera enregistré comme avance.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
                {selected.length ? (
                  <tfoot>
                    <tr>
                      <td />
                      <td colSpan={2}>Sélection</td>
                      <td className="num">{tnd(selectedTotal)}</td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </div>

          <Field label="3. Montant reçu (TND)" error={amountText && amount === null ? "Montant invalide (3 décimales au plus)" : null}>
            <input
              className="input num amt-s"
              inputMode="decimal"
              style={{ minHeight: 44, fontSize: 18 }}
              value={amountText}
              placeholder="0,000"
              onChange={(e) => setAmountText(e.target.value)}
            />
          </Field>
          {selected.length && !amountText ? (
            <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setAmountText(tnd(selectedTotal))}>
              Montant de la sélection : {tnd(selectedTotal)} TND
            </button>
          ) : null}
          {preview.data && preview.data.advance > 0 ? (
            <div className="ban ban-blue">
              <strong>Avance</strong>
              <span>{tnd(preview.data.advance)} TND déposés en avance, imputés automatiquement aux prochaines échéances.</span>
            </div>
          ) : null}

          <div>
            <div className="lab" style={{ marginBottom: 6 }}>
              4. Mode
            </div>
            <Segmented
              label="Mode de paiement"
              value={method}
              onChange={setMethod}
              options={[
                { value: "cash", label: "Espèces" },
                { value: "transfer", label: "Virement" },
                { value: "cheque", label: "Chèque" },
                { value: "card", label: "Carte" },
              ]}
            />
          </div>
          {method === "cheque" ? (
            <div className="grid2">
              <Field label="N° de chèque">
                <input className="input" value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
              </Field>
              <Field label="Banque">
                <input className="input" value={chequeBank} onChange={(e) => setChequeBank(e.target.value)} />
              </Field>
            </div>
          ) : null}
          {method === "transfer" || method === "card" ? (
            <Field label="Référence (facultatif)">
              <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          ) : null}

          {preview.data ? (
            <div>
              <div className="lab" style={{ marginBottom: 6 }}>
                5. Aperçu de l'imputation
              </div>
              <div className="card xs">
                <table className="tbl">
                  <tbody>
                    {preview.data.lines.map((l) => (
                      <tr key={l.installmentId}>
                        <td>→ {l.label}</td>
                        <td className="num">{tnd(l.amount)}</td>
                      </tr>
                    ))}
                    {preview.data.advance > 0 ? (
                      <tr>
                        <td>→ Solde créditeur (avance)</td>
                        <td className="num">{tnd(preview.data.advance)}</td>
                      </tr>
                    ) : null}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Reste à payer après paiement</td>
                      <td className="num">{tnd(preview.data.after.due)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ) : null}
          <ErrorBanner error={create.error ?? preview.error} />
        </>
      )}
    </Drawer>
  );
}
