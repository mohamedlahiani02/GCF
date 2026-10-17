import { CW_CATEGORY_LABELS } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { api } from "../api/client";
import type { BookingDetail, CancelResult } from "../api/types";
import { BookingStatusBadge, InstallmentBadge } from "../components/badges";
import { Card, ErrorBanner, fact, Facts, Field, Loading, Modal, Money, Notice, PageHeader, Spinner } from "../components/ui";
import { useI18n } from "../i18n/i18n";
import { useFormat } from "../lib/format";

function CancelDialog({ booking, onClose, onDone }: { booking: BookingDetail; onClose: () => void; onDone: (result: CancelResult) => void }) {
  const { t } = useI18n();
  const f = useFormat();
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => api.post<CancelResult>(`/bookings/${booking.id}/cancel`, { reason: reason.trim() }),
    onSuccess: onDone,
  });
  const terms = booking.cancellation!;
  return (
    <Modal
      title={t.detail.cancelTitle}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8, marginInlineStart: "auto" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t.detail.keep}
          </button>
          <button type="button" className="btn btn-d" disabled={!reason.trim() || cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending ? <Spinner /> : t.detail.confirmCancel}
          </button>
        </div>
      }
    >
      {terms.free ? (
        <p>{booking.status === "requested" ? t.detail.cancelFree : t.detail.cancelFreeUntil(f.dateTime(terms.freeUntil))}</p>
      ) : (
        <div className="ban ban-amber">
          <span>
            {t.detail.cancelLate} {terms.fee > 0 ? t.detail.cancelFee(f.money(terms.fee)) : null}
          </span>
        </div>
      )}
      <Field label={t.detail.reason}>
        <textarea className="input" value={reason} maxLength={500} required onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBanner error={cancel.error} />
    </Modal>
  );
}

export function BookingDetailPage() {
  const { id = "" } = useParams();
  const { t, language } = useI18n();
  const f = useFormat();
  const location = useLocation();
  const client = useQueryClient();
  const created = (location.state as { created?: "confirmed" | "requested" } | null)?.created;
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState<CancelResult | null>(null);
  const query = useQuery({ queryKey: ["booking", id], queryFn: () => api.get<BookingDetail>(`/bookings/${id}`) });
  const b = query.data;
  if (query.isPending) return <Loading />;
  if (!b) return <ErrorBanner error={query.error} retry={() => query.refetch()} />;
  const promoOrCoverage = b.coverageDiscount > 0 || b.promoDiscount > 0;
  return (
    <>
      <PageHeader
        title={t.detail.title(b.resourceCode)}
        subtitle={`${CW_CATEGORY_LABELS[language][b.category]}, ${b.typeName}`}
        actions={
          <Link to="/reservations" className="btn">
            {t.common.back}
          </Link>
        }
      />
      {created ? <Notice tone="green">{created === "confirmed" ? t.book.createdConfirmed : t.book.createdRequested}</Notice> : null}
      {cancelled ? (
        <Notice tone="green">
          {cancelled.free ? t.detail.cancelledFree : cancelled.fee > 0 ? t.detail.cancelledFee(f.money(cancelled.fee)) : t.detail.cancelledLate}
        </Notice>
      ) : null}
      <ErrorBanner error={query.error} retry={() => query.refetch()} />
      <div className="portal-split">
        <Card title={t.detail.facts} actions={<BookingStatusBadge status={b.status} />}>
          <div className="card-b stack">
            <Facts
              items={[
                [t.bookings.date, f.date(b.date, true)],
                [t.bookings.time, `${b.startTime} - ${b.endTime}`],
                [t.bookings.space, `${CW_CATEGORY_LABELS[language][b.category]} ${b.resourceCode}${b.resourceName ? ` (${b.resourceName})` : ""}`],
                [t.detail.floor, b.floorName],
                ...fact(b.formatLabel, t.detail.format, b.formatLabel),
                ...fact(b.profile, t.detail.profile, b.profile ? t.profile[b.profile] : null),
                ...fact(promoOrCoverage, t.detail.listPrice, <Money value={b.listPrice} />),
                ...fact(b.coverageDiscount > 0, t.detail.coverageDiscount, <span className="num">- {f.money(b.coverageDiscount)}</span>),
                ...fact(b.promoDiscount > 0, t.detail.promoDiscount, <span className="num">- {f.money(b.promoDiscount)}</span>),
                [t.detail.charge, <Money value={b.charge} strong />],
                ...fact(b.lateCancelFee > 0, t.detail.lateCancelFee, <Money value={b.lateCancelFee} />),
                ...fact(b.paid > 0, t.detail.paid, <Money value={b.paid} />),
                ...fact(b.due > 0, t.detail.due, `${f.money(b.due)}, ${t.common.payAtDesk}`),
                [t.detail.requestedAt, f.dateTime(b.requestedAt)],
                ...fact(b.checkedInAt, t.detail.checkedInAt, b.checkedInAt ? f.dateTime(b.checkedInAt) : null),
                ...fact(b.refusalReason, t.detail.refusalReason, b.refusalReason),
                ...fact(b.cancelledAt, t.detail.cancelledAt, b.cancelledAt ? f.dateTime(b.cancelledAt) : null),
                ...fact(b.cancelReason, t.detail.cancelReason, b.cancelReason),
              ]}
            />
          </div>
          <div className="card-f">
            <a className="btn" href={api.fileUrl(`/bookings/${b.id}/calendar.ics`, { lang: language })} download>
              {t.detail.calendar}
            </a>
            {b.cancellable ? (
              <button type="button" className="btn btn-d" onClick={() => setCancelling(true)}>
                {t.detail.cancel}
              </button>
            ) : null}
          </div>
        </Card>
        {b.qrAvailable ? (
          <Card title={t.detail.qrTitle}>
            <div className="card-b stack" style={{ alignItems: "center", textAlign: "center" }}>
              <img className="portal-qr" src={api.fileUrl(`/bookings/${b.id}/qr.svg`)} alt={t.detail.qrAlt(b.resourceCode)} width={220} height={220} />
              <p className="cap">{t.detail.qrHelp}</p>
            </div>
          </Card>
        ) : null}
      </div>
      {b.cancellable && b.cancellation ? (
        <p className="cap">
          {b.cancellation.free
            ? b.status === "requested"
              ? t.detail.cancelFree
              : t.detail.cancelFreeUntil(f.dateTime(b.cancellation.freeUntil))
            : `${t.detail.cancelLate}${b.cancellation.fee > 0 ? ` ${t.detail.cancelFee(f.money(b.cancellation.fee))}` : ""}`}
        </p>
      ) : (b.status === "requested" || b.status === "confirmed") && !b.cancellable ? (
        <Notice tone="amber">{t.detail.cancelPaid}</Notice>
      ) : null}
      {b.charges.length ? (
        <Card title={t.detail.charges}>
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t.detail.label}</th>
                  <th>{t.detail.dueDate}</th>
                  <th className="num">{t.detail.amount}</th>
                  <th className="num">{t.detail.paid}</th>
                  <th className="num">{t.detail.remaining}</th>
                  <th>{t.detail.state}</th>
                </tr>
              </thead>
              <tbody>
                {b.charges.map((c) => (
                  <tr key={c.id}>
                    <td>{c.label}</td>
                    <td>{f.date(c.dueDate)}</td>
                    <td className="num">
                      <Money value={c.amount} />
                    </td>
                    <td className="num">
                      <Money value={c.paid} />
                    </td>
                    <td className="num">
                      <Money value={c.remaining} />
                    </td>
                    <td>
                      <InstallmentBadge state={c.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      {cancelling ? (
        <CancelDialog
          booking={b}
          onClose={() => setCancelling(false)}
          onDone={async (result) => {
            setCancelling(false);
            setCancelled(result);
            await client.invalidateQueries({ queryKey: ["booking", id] });
            await client.invalidateQueries({ queryKey: ["bookings"] });
            await client.invalidateQueries({ queryKey: ["account"] });
            await client.invalidateQueries({ queryKey: ["subscription"] });
            await client.invalidateQueries({ queryKey: ["packs"] });
          }}
        />
      ) : null}
    </>
  );
}
