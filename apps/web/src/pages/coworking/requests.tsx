import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Loading, PageHeader, ReasonDialog } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { frDate, frTime, localParts, tnd } from "../../lib/format";
import { PROFILE, durationLabel, type RequestRow } from "./api";
import { ReassignModal } from "./bookingParts";

/** Time left before a request expires, refreshed every 30 seconds. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** The fields of a request the reassign dialog shows. */
const reassignTarget = (r: RequestRow) => ({
  id: r.id,
  memberName: r.memberName,
  typeName: r.typeName,
  resourceCode: r.resourceCode,
  localDate: localParts(r.startsAt).date,
  startTime: localParts(r.startsAt).time,
  endTime: localParts(r.endsAt).time,
});

/**
 * Portal booking requests waiting for the desk, the soonest start first, with the time left before each expires:
 * accept, refuse with a reason, or move the request to another free resource and accept it.
 */
export function RequestsPage() {
  usePage(["Coworking", "Demandes"]);
  const now = useNow(30_000);
  const client = useQueryClient();
  const toast = useToast();
  const [refusing, setRefusing] = useState<RequestRow | null>(null);
  const [moving, setMoving] = useState<RequestRow | null>(null);
  const list = useQuery({
    queryKey: ["cw-requests"],
    queryFn: () => api.get<{ items: RequestRow[] }>("/coworking/requests"),
    refetchInterval: 30_000,
  });
  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/coworking/bookings/${id}/approve`),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Demande acceptée. Le client est prévenu par e-mail.");
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
  const rows = list.data?.items ?? [];
  return (
    <>
      <PageHeader title="Demandes de réservation" subtitle="Demandes envoyées depuis l'espace client, à accepter ou refuser avant leur expiration." />
      <Card title={`En attente (${rows.length})`}>
        <ErrorBanner error={list.error} retry={() => list.refetch()} />
        {list.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title="Aucune demande en attente" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Expire dans</th>
                  <th>Client</th>
                  <th>Ressource</th>
                  <th>Créneau</th>
                  <th>Profil</th>
                  <th className="num">Montant (TND)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const left = Math.max(0, Math.round((new Date(r.expiresAt).getTime() - now) / 60_000));
                  return (
                    <tr key={r.id}>
                      <td>
                        <Badge tone={left < 60 ? "red" : left < 240 ? "amber" : "neutral"}>{left > 0 ? durationLabel(left) : "Expirée"}</Badge>
                        <div className="cap">
                          demandée le {frDate(r.requestedAt)} à {frTime(r.requestedAt)}
                        </div>
                      </td>
                      <td>
                        <Link to={`/coworking/membres/${r.memberId}`}>{r.memberName}</Link>
                        <div className="cap">{[r.company, r.phone, r.email].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td>
                        <Link to={`/coworking/reservations/${r.id}`}>{r.resourceCode}</Link>
                        <div className="cap">{r.typeName}</div>
                      </td>
                      <td>
                        {frDate(r.startsAt)}
                        <div className="cap">
                          {frTime(r.startsAt)}-{frTime(r.endsAt)}
                        </div>
                        {r.notes ? <div className="cap">{r.notes}</div> : null}
                      </td>
                      <td>{PROFILE[r.profile]}</td>
                      <td className="num">{tnd(r.charge)}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button type="button" className="btn btn-p" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>
                          Accepter
                        </button>
                        <button type="button" className="btn btn-g" onClick={() => setMoving(r)}>
                          Autre ressource
                        </button>
                        <button type="button" className="btn btn-g" onClick={() => setRefusing(r)}>
                          Refuser
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {refusing ? (
        <ReasonDialog
          title="Refuser la demande"
          explanation={`${refusing.memberName} · ${refusing.resourceCode}, ${frDate(refusing.startsAt)} ${frTime(refusing.startsAt)}-${frTime(refusing.endsAt)}. Le client est prévenu par e-mail avec le motif.`}
          confirmLabel="Refuser"
          danger
          onClose={() => setRefusing(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/bookings/${refusing.id}/refuse`, { reason });
            await client.invalidateQueries();
            toast("Demande refusée.");
          }}
        />
      ) : null}
      {moving ? <ReassignModal booking={reassignTarget(moving)} approve onClose={() => setMoving(null)} /> : null}
    </>
  );
}
