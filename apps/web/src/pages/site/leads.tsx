import { LEAD_KINDS, type LeadKind } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Drawer, Empty, ErrorBanner, Loading, PageHeader, Pagination, Segmented } from "../../components/ui";
import { frDate, frDateTime } from "../../lib/format";
import { LANGUAGE_LABEL, LEAD_KIND, LEAD_STATUS, siteKeys, type Lead, type LeadList, type LeadStatus } from "./api";

const PAGE_SIZE = 50;

function LeadDrawer({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const change = useMutation({
    mutationFn: (status: LeadStatus) => api.patch(`/site/leads/${lead.id}`, { status }),
    onSuccess: async (_, status) => {
      await client.invalidateQueries({ queryKey: siteKeys.leads });
      toast(status === "handled" ? "Demande marquée comme traitée." : status === "spam" ? "Demande classée indésirable." : "Demande remise à traiter.");
      onClose();
    },
  });
  const rows: [string, React.ReactNode][] = [
    ["Reçue le", frDateTime(lead.createdAt)],
    ["Type", LEAD_KIND[lead.kind]],
    ["Nom", lead.name],
    ["Entreprise", lead.company],
    ["E-mail", lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : null],
    ["Téléphone", lead.phone ? <a href={`tel:${lead.phone.replace(/[^+\d]/g, "")}`}>{lead.phone}</a> : null],
    ["Date souhaitée", lead.preferredDate ? frDate(lead.preferredDate) : null],
    ["Page d'origine", lead.pagePath],
    ["Langue", LANGUAGE_LABEL[lead.language]],
  ];
  return (
    <Drawer
      title={`Demande de ${lead.name}`}
      onClose={onClose}
      footer={
        <>
          {lead.status !== "new" ? (
            <button type="button" className="btn" disabled={change.isPending} onClick={() => change.mutate("new")}>
              Remettre à traiter
            </button>
          ) : (
            <span />
          )}
          <div className="row" style={{ gap: 8 }}>
            {lead.status !== "spam" ? (
              <button type="button" className="btn" disabled={change.isPending} onClick={() => change.mutate("spam")}>
                Indésirable
              </button>
            ) : null}
            {lead.status !== "handled" ? (
              <button type="button" className="btn btn-p" disabled={change.isPending} onClick={() => change.mutate("handled")}>
                Marquer comme traitée
              </button>
            ) : null}
          </div>
        </>
      }
    >
      <div className="row center" style={{ gap: 6 }}>
        <Badge tone={LEAD_STATUS[lead.status].tone}>{LEAD_STATUS[lead.status].label}</Badge>
        {lead.handledAt ? (
          <span className="cap">
            le {frDateTime(lead.handledAt)}
            {lead.handledBy ? ` par ${lead.handledBy}` : ""}
          </span>
        ) : null}
      </div>
      <dl className="site-dl">
        {rows
          .filter(([, v]) => v !== null && v !== "")
          .map(([label, v]) => (
            <div key={label}>
              <dt className="lab">{label}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      <div className="stack" style={{ gap: 4 }}>
        <span className="lab">Message</span>
        {lead.message ? <p className="site-message">{lead.message}</p> : <span className="cap">Aucun message.</span>}
      </div>
      <ErrorBanner error={change.error} />
    </Drawer>
  );
}

export function LeadsPage() {
  usePage(["Site web", "Demandes du site"]);
  const [status, setStatus] = useState<LeadStatus | "all">("new");
  const [kind, setKind] = useState<LeadKind | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Lead | null>(null);
  const filters = { status: status === "all" ? undefined : status, kind, from, to, page, pageSize: PAGE_SIZE };
  const leads = useQuery({ queryKey: [...siteKeys.leads, filters], queryFn: () => api.get<LeadList>("/site/leads", filters) });
  const reset = <T,>(setter: (v: T) => void) => (v: T) => (setter(v), setPage(1));
  return (
    <>
      <PageHeader title="Demandes du site" subtitle="Messages, demandes de visite et de devis envoyés depuis les formulaires du site." />
      <Card
        title={
          <div className="row center" style={{ gap: 8 }}>
            <Segmented
              label="Statut"
              value={status}
              onChange={reset(setStatus)}
              options={[
                { value: "new", label: "À traiter" },
                { value: "handled", label: "Traitées" },
                { value: "spam", label: "Indésirables" },
                { value: "all", label: "Toutes" },
              ]}
            />
            <select className="input" aria-label="Type de demande" value={kind} onChange={(e) => reset(setKind)(e.target.value as LeadKind | "")}>
              <option value="">Tous les types</option>
              {LEAD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LEAD_KIND[k]}
                </option>
              ))}
            </select>
            <label className="row center" style={{ gap: 6 }}>
              <span className="lab">Du</span>
              <input className="input" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
            </label>
            <label className="row center" style={{ gap: 6 }}>
              <span className="lab">Au</span>
              <input className="input" type="date" value={to} min={from || undefined} onChange={(e) => reset(setTo)(e.target.value)} />
            </label>
          </div>
        }
        footer={leads.data ? <Pagination page={page} hasMore={leads.data.hasMore} onPage={setPage} /> : undefined}
      >
        <ErrorBanner error={leads.error} retry={() => leads.refetch()} />
        {leads.isPending ? (
          <Loading />
        ) : leads.data?.items.length === 0 ? (
          <Empty title="Aucune demande" text={status === "new" ? "Toutes les demandes ont été traitées." : undefined} />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Reçue le</th>
                  <th>Type</th>
                  <th>Nom</th>
                  <th>Contact</th>
                  <th>Message</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {leads.data?.items.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => setSelected(l)}>
                    <td>{frDateTime(l.createdAt)}</td>
                    <td>{LEAD_KIND[l.kind]}</td>
                    <td>
                      <button type="button" className="btn btn-g site-link-btn" onClick={(e) => (e.stopPropagation(), setSelected(l))}>
                        {l.name}
                      </button>
                      {l.company ? <div className="cap">{l.company}</div> : null}
                    </td>
                    <td>
                      {[l.email, l.phone].filter(Boolean).join(" · ")}
                      {l.preferredDate ? <div className="cap">Visite souhaitée le {frDate(l.preferredDate)}</div> : null}
                    </td>
                    <td>
                      <span className="site-clamp" style={{ maxWidth: 320 }}>
                        {l.message ?? ""}
                      </span>
                    </td>
                    <td>
                      <Badge tone={LEAD_STATUS[l.status].tone}>{LEAD_STATUS[l.status].label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selected ? <LeadDrawer lead={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
