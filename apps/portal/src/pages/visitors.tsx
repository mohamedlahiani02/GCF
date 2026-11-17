import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Notice, PageHeader, Spinner } from "../components/ui";
import { useI18n } from "../i18n/i18n";
import { useFormat } from "../lib/format";

interface Visitor {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  expectedOn: string;
  expectedAt: string | null;
  purpose: string | null;
  status: "expected" | "arrived" | "left" | "cancelled";
}

const TONE = { expected: "amber", arrived: "green", left: "gray", cancelled: "gray" } as const;

/** Today in the visitor's browser, YYYY-MM-DD; the server checks the date against the centre's calendar. */
const localToday = () => new Date().toLocaleDateString("sv-SE");

/** The member's guests to come: announce one, cancel one. */
export function VisitorsPage() {
  const { t } = useI18n();
  const f = useFormat();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [date, setDate] = useState(localToday());
  const [time, setTime] = useState("");
  const [purpose, setPurpose] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const visitors = useQuery({ queryKey: ["visitors"], queryFn: () => api.get<Visitor[]>("/visitors") });
  const announce = useMutation({
    mutationFn: () =>
      api.post<Visitor>("/visitors", {
        name: name.trim(),
        company: company.trim() || null,
        phone: phone.trim() || null,
        expectedOn: date,
        expectedAt: time || null,
        purpose: purpose.trim() || null,
      }),
    onSuccess: async (v) => {
      await client.invalidateQueries({ queryKey: ["visitors"] });
      setNotice(t.visitors.saved(v.name));
      setName("");
      setCompany("");
      setPhone("");
      setTime("");
      setPurpose("");
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post<Visitor>(`/visitors/${id}/cancel`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["visitors"] });
      setNotice(t.visitors.cancelled);
    },
  });
  return (
    <>
      <PageHeader title={t.visitors.title} subtitle={t.visitors.intro} />
      {notice ? <Notice tone="green">{notice}</Notice> : null}
      <Card
        title={t.visitors.announce}
        footer={
          <>
            <span />
            <button type="button" className="btn btn-p" disabled={!name.trim() || !date || announce.isPending} onClick={() => announce.mutate()}>
              {announce.isPending ? <Spinner /> : t.visitors.announce}
            </button>
          </>
        }
      >
        <div className="card-b stack">
          <div className="grid3 portal-grid">
            <Field label={t.visitors.name}>
              <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={`${t.visitors.company} (${t.common.optional})`}>
              <input className="input" value={company} maxLength={120} onChange={(e) => setCompany(e.target.value)} />
            </Field>
            <Field label={`${t.visitors.phone} (${t.common.optional})`}>
              <input className="input" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label={t.visitors.date}>
              <input className="input" type="date" min={localToday()} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={`${t.visitors.time} (${t.common.optional})`}>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field label={`${t.visitors.purpose} (${t.common.optional})`}>
              <input className="input" value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} />
            </Field>
          </div>
          <ErrorBanner error={announce.error} />
        </div>
      </Card>
      <Card>
        <ErrorBanner error={visitors.error ?? cancel.error} retry={() => visitors.refetch()} />
        {visitors.isPending ? (
          <Loading />
        ) : visitors.data?.length ? (
          <div className="xs">
            <table className="tbl">
              <tbody>
                {visitors.data.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {f.date(v.expectedOn, true)}
                      {v.expectedAt ? `, ${v.expectedAt}` : ""}
                    </td>
                    <td>
                      <strong>{v.name}</strong>
                      <div className="cap">{[v.company, v.purpose].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td>
                      <Badge tone={TONE[v.status]}>{t.visitors.statuses[v.status]}</Badge>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {v.status === "expected" ? (
                        <button type="button" className="btn btn-g" disabled={cancel.isPending} onClick={() => cancel.mutate(v.id)}>
                          {t.visitors.cancel}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t.visitors.none} />
        )}
      </Card>
    </>
  );
}
