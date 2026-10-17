import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../../api/client";
import { usePage } from "../../components/shell";
import { Card, PageHeader } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { frDate } from "../../lib/format";
import { CATEGORY, type Booking } from "./api";

/**
 * Page opened by scanning the QR code of a client's booking with the desk phone: the booking is shown, and one
 * large button records the arrival.
 */
export function CheckInPage() {
  usePage(["Coworking", "Arrivée"]);
  const { code = "" } = useParams();
  const client = useQueryClient();
  const scanned = useQuery({ queryKey: ["cw-check-in", code], queryFn: () => api.get<Booking>(`/coworking/check-in/${encodeURIComponent(code)}`) });
  const checkIn = useMutation({
    mutationFn: () => api.post<Booking>("/coworking/check-in", { code }),
    onSuccess: () => client.invalidateQueries(),
  });
  const b = checkIn.data;
  const pending = scanned.data;
  return (
    <>
      <PageHeader title="Arrivée d'un client" subtitle="Réservation scannée depuis son QR code." />
      <Card>
        <div className="card-b stack cw-checkin">
          {b ? (
            <div className="ban ban-green" role="status">
              <strong>Arrivée enregistrée</strong>
              <span>
                {b.memberName} · {CATEGORY[b.category]} {b.resourceCode}, {frDate(b.localDate)} {b.startTime}-{b.endTime}
              </span>
            </div>
          ) : (
            <>
              <span className="cap">Code de réservation {code}</span>
              {pending ? (
                <span>
                  {pending.memberName} · {CATEGORY[pending.category]} {pending.resourceCode}, {frDate(pending.localDate)} {pending.startTime}-{pending.endTime}
                </span>
              ) : null}
              {scanned.error ? (
                <div className="ban ban-red" role="alert">
                  <strong>Réservation introuvable</strong>
                  <span>{errorMessage(scanned.error)}</span>
                </div>
              ) : null}
              <button type="button" className="btn btn-p btn-l cw-checkin-button" disabled={checkIn.isPending || !pending} onClick={() => checkIn.mutate()}>
                {checkIn.isPending ? <span className="spinner" aria-label="En cours" /> : "Enregistrer l'arrivée"}
              </button>
            </>
          )}
          {checkIn.error ? (
            <div className="ban ban-red" role="alert">
              <strong>Arrivée non enregistrée</strong>
              <span>{errorMessage(checkIn.error)}</span>
            </div>
          ) : null}
          {b ? (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Link className="btn btn-l" to={`/coworking/reservations/${b.id}`}>
                Ouvrir la réservation
              </Link>
              <Link className="btn btn-l" to="/coworking">
                Plan en direct
              </Link>
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}
