import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Loading, PageHeader, Pagination } from "../../components/ui";
import { frDate } from "../../lib/format";
import { MEMBER_KIND, MEMBER_STATUS, memberName, type MemberRow, type Page } from "./api";
import { MemberFormModal } from "./memberPicker";

const PAGE_SIZE = 25;

/** Coworking clients: members with a portal account and walk-in guests, with search and filters. */
export function MembersPage() {
  usePage(["Coworking", "Membres"]);
  const { can } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [subscription, setSubscription] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => (setQ(text.trim()), setPage(1)), 250);
    return () => window.clearTimeout(t);
  }, [text]);
  const list = useQuery({
    queryKey: ["cw-members", q, kind, status, subscription, page],
    queryFn: () => api.get<Page<MemberRow>>("/coworking/members", { q, kind, status, hasSubscription: subscription, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const filter = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => (set(e.target.value), setPage(1));
  return (
    <>
      <PageHeader
        title="Membres et clients"
        actions={
          can("coworking:write") ? (
            <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
              + Nouveau client
            </button>
          ) : null
        }
      />
      <Card
        title={
          <div className="row center" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="input" type="search" aria-label="Rechercher" placeholder="Nom, téléphone, e-mail, société" value={text} onChange={(e) => setText(e.target.value)} />
            <select className="input" aria-label="Type" value={kind} onChange={filter(setKind)}>
              <option value="">Tous les types</option>
              <option value="member">Membres</option>
              <option value="guest">Clients de passage</option>
            </select>
            <select className="input" aria-label="Statut" value={status} onChange={filter(setStatus)}>
              <option value="">Tous les statuts</option>
              <option value="active">Actifs</option>
              <option value="pending">À valider</option>
              <option value="disabled">Désactivés</option>
            </select>
            <select className="input" aria-label="Abonnement" value={subscription} onChange={filter(setSubscription)}>
              <option value="">Avec ou sans abonnement</option>
              <option value="true">Abonnement en cours</option>
              <option value="false">Sans abonnement</option>
            </select>
          </div>
        }
        footer={list.data ? <Pagination page={page} hasMore={page * PAGE_SIZE < list.data.total} onPage={setPage} total={list.data.total} pageSize={PAGE_SIZE} /> : null}
      >
        <ErrorBanner error={list.error} retry={() => list.refetch()} />
        {list.isPending ? (
          <Loading />
        ) : list.data?.items.length === 0 ? (
          <Empty title="Aucun client" text="Les membres s'inscrivent depuis l'espace client ou sont créés à l'accueil." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Type</th>
                  <th>Contact</th>
                  <th>Abonnement en cours</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((m) => (
                  <tr key={m.id} className="clickable" onClick={() => navigate(`/coworking/membres/${m.id}`)}>
                    <td>
                      <Link to={`/coworking/membres/${m.id}`} onClick={(e) => e.stopPropagation()}>
                        {memberName(m)}
                      </Link>
                      {m.companyName ? <div className="cap">{m.companyName}</div> : null}
                    </td>
                    <td>{MEMBER_KIND[m.kind]}</td>
                    <td>
                      {m.phone ?? ""}
                      {m.email ? <div className="cap">{m.email}</div> : null}
                    </td>
                    <td>{m.currentPlan ? <Badge tone="violet">{m.currentPlan}</Badge> : <span className="cap">Aucun</span>}</td>
                    <td>
                      <Badge tone={MEMBER_STATUS[m.status].tone}>{MEMBER_STATUS[m.status].label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating ? (
        <MemberFormModal
          member={null}
          onClose={() => setCreating(false)}
          onSaved={(m) => {
            setCreating(false);
            toast(`Client ${memberName(m)} créé.`);
            navigate(`/coworking/membres/${m.id}`);
          }}
        />
      ) : null}
    </>
  );
}
