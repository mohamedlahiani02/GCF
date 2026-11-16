import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader } from "../../components/ui";
import { addDaysIso, frDate, frTime, todayIso } from "../../lib/format";
import type { Tone } from "../../lib/labels";
import { memberName, type MemberRow } from "./api";
import { MemberPicker } from "./memberPicker";

type VisitorStatus = "expected" | "arrived" | "left" | "cancelled";
interface Visitor {
  id: string;
  hostMemberId: string;
  hostName: string;
  hostCompany: string | null;
  name: string;
  company: string | null;
  phone: string | null;
  expectedOn: string;
  expectedAt: string | null;
  purpose: string | null;
  status: VisitorStatus;
  announcedBy: "portal" | "staff";
  arrivedAt: string | null;
  leftAt: string | null;
}

const STATUS: Record<VisitorStatus, { label: string; tone: Tone }> = {
  expected: { label: "Attendu", tone: "amber" },
  arrived: { label: "Sur place", tone: "green" },
  left: { label: "Parti", tone: "gray" },
  cancelled: { label: "Annulé", tone: "gray" },
};

function AddVisitorModal({ date, onClose }: { date: string; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [host, setHost] = useState<MemberRow | null>(null);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [expectedOn, setExpectedOn] = useState(date);
  const [expectedAt, setExpectedAt] = useState("");
  const [purpose, setPurpose] = useState("");
  const [arrivedNow, setArrivedNow] = useState(date === todayIso());
  const save = useMutation({
    mutationFn: async () => {
      const created = await api.post<Visitor>("/coworking/visitors", {
        hostMemberId: host!.id,
        name: name.trim(),
        company: company.trim() || null,
        phone: phone.trim() || null,
        expectedOn,
        expectedAt: expectedAt || null,
        purpose: purpose.trim() || null,
      });
      if (arrivedNow && expectedOn === todayIso()) await api.post(`/coworking/visitors/${created.id}/arrive`);
      return created;
    },
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ["cw-visitors"] });
      toast(`${created.name} enregistré.`);
      onClose();
    },
  });
  return (
    <Modal
      title="Nouveau visiteur"
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!host || !name.trim() || !expectedOn || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      {host ? (
        <div className="row between center">
          <div>
            <div className="lab">Client qui reçoit</div>
            <strong>{memberName(host)}</strong>
            {host.companyName ? <span className="cap"> · {host.companyName}</span> : null}
          </div>
          <button type="button" className="btn btn-g" onClick={() => setHost(null)}>
            Changer
          </button>
        </div>
      ) : (
        <Field label="Client qui reçoit *">
          <MemberPicker onPick={setHost} autoFocus />
        </Field>
      )}
      <div className="grid2">
        <Field label="Nom du visiteur *">
          <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Société">
          <input className="input" value={company} maxLength={120} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label="Téléphone">
          <input className="input" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Objet de la visite">
          <input className="input" value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <Field label="Date *">
          <input className="input" type="date" min={todayIso()} value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />
        </Field>
        <Field label="Heure prévue">
          <input className="input" type="time" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
        </Field>
      </div>
      {expectedOn === todayIso() ? (
        <label className="row center" style={{ gap: 8 }}>
          <input type="checkbox" className="chk" checked={arrivedNow} onChange={(e) => setArrivedNow(e.target.checked)} />
          Le visiteur est déjà à l'accueil
        </label>
      ) : null}
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** The day's guests at the front desk: who is expected, who is here, who has left. */
export function VisitorsPage() {
  usePage(["Coworking", "Visiteurs"]);
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [adding, setAdding] = useState(false);
  const visitors = useQuery({ queryKey: ["cw-visitors", date], queryFn: () => api.get<Visitor[]>("/coworking/visitors", { date }) });
  const move = useMutation({
    mutationFn: ({ id, step }: { id: string; step: "arrive" | "leave" | "cancel" }) => api.post<Visitor>(`/coworking/visitors/${id}/${step}`),
    onSuccess: async (v) => {
      await client.invalidateQueries({ queryKey: ["cw-visitors"] });
      toast(v.status === "arrived" ? `Arrivée de ${v.name} enregistrée.` : v.status === "left" ? `Départ de ${v.name} enregistré.` : "Visite annulée.");
    },
  });
  const rows = visitors.data ?? [];
  const count = (s: VisitorStatus) => rows.filter((v) => v.status === s).length;
  const today = date === todayIso();
  return (
    <>
      <PageHeader
        title="Registre des visiteurs"
        subtitle={`${frDate(date)} · ${count("expected")} attendu(s), ${count("arrived")} sur place, ${count("left")} parti(s)`}
        actions={
          <>
            <button type="button" className="btn btn-g" aria-label="Jour précédent" onClick={() => setDate(addDaysIso(date, -1))}>
              ‹
            </button>
            <input className="input" type="date" aria-label="Date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <button type="button" className="btn btn-g" aria-label="Jour suivant" onClick={() => setDate(addDaysIso(date, 1))}>
              ›
            </button>
            {can("coworking:write") && date >= todayIso() ? (
              <button type="button" className="btn btn-p" onClick={() => setAdding(true)}>
                + Visiteur
              </button>
            ) : null}
          </>
        }
      />
      <Card>
        <ErrorBanner error={visitors.error ?? move.error} retry={() => visitors.refetch()} />
        {visitors.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title="Aucun visiteur ce jour" text="Les clients annoncent leurs visiteurs depuis leur espace ; l'accueil peut aussi en enregistrer." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Heure</th>
                  <th>Visiteur</th>
                  <th>Reçu par</th>
                  <th>Objet</th>
                  <th>État</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id} className={v.status === "cancelled" ? "void" : ""}>
                    <td className="num">{v.expectedAt ?? ""}</td>
                    <td>
                      <strong>{v.name}</strong>
                      <div className="cap">{[v.company, v.phone].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td>
                      <Link to={`/coworking/membres/${v.hostMemberId}`}>{v.hostName}</Link>
                      {v.hostCompany ? <div className="cap">{v.hostCompany}</div> : null}
                    </td>
                    <td>
                      {v.purpose ?? ""}
                      <div className="cap">{v.announcedBy === "portal" ? "Annoncé par le client" : "Enregistré à l'accueil"}</div>
                    </td>
                    <td>
                      <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge>
                      <div className="cap">
                        {v.arrivedAt ? `arrivé à ${frTime(v.arrivedAt)}` : ""}
                        {v.leftAt ? `, parti à ${frTime(v.leftAt)}` : ""}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {can("coworking:write") && v.status === "expected" && today ? (
                        <button type="button" className="btn btn-p" disabled={move.isPending} onClick={() => move.mutate({ id: v.id, step: "arrive" })}>
                          Arrivé
                        </button>
                      ) : null}
                      {can("coworking:write") && v.status === "arrived" ? (
                        <button type="button" className="btn" disabled={move.isPending} onClick={() => move.mutate({ id: v.id, step: "leave" })}>
                          Parti
                        </button>
                      ) : null}
                      {can("coworking:write") && v.status === "expected" ? (
                        <button type="button" className="btn btn-g" disabled={move.isPending} onClick={() => move.mutate({ id: v.id, step: "cancel" })}>
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
      </Card>
      {adding ? <AddVisitorModal date={date} onClose={() => setAdding(false)} /> : null}
    </>
  );
}
