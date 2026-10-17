import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import type { Account, MailItem, Page } from "../api/types";
import { InstallmentBadge } from "../components/badges";
import { Badge, Card, Empty, ErrorBanner, Kpi, Loading, Money, PageHeader, Pagination } from "../components/ui";
import { useI18n } from "../i18n/i18n";
import { useFormat } from "../lib/format";

export function PaymentsPage() {
  const { t } = useI18n();
  const f = useFormat();
  const query = useQuery({ queryKey: ["account"], queryFn: () => api.get<Account>("/account") });
  const data = query.data;
  if (query.isPending) return <Loading />;
  if (!data) return <ErrorBanner error={query.error} retry={() => query.refetch()} />;
  const charges = data.installments.filter((i) => i.kind === "charge");
  return (
    <>
      <PageHeader title={t.payments.title} subtitle={t.payments.dueNote} />
      <div className="grid2 portal-grid">
        <Kpi label={t.payments.due} value={<Money value={data.totals.due} />} />
        <Kpi label={t.payments.credit} value={<Money value={data.totals.credit} />} />
      </div>
      <Card title={t.payments.installments}>
        {charges.length ? (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t.payments.label}</th>
                  <th>{t.payments.dueDate}</th>
                  <th className="num">{t.payments.amount}</th>
                  <th className="num">{t.payments.paid}</th>
                  <th className="num">{t.payments.remaining}</th>
                  <th>{t.payments.state}</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((i) => (
                  <tr key={i.id} className={i.status === "cancelled" ? "void" : undefined}>
                    <td>{i.label}</td>
                    <td>{f.date(i.dueDate)}</td>
                    <td className="num">
                      <Money value={i.amount} />
                    </td>
                    <td className="num">
                      <Money value={i.paid} />
                    </td>
                    <td className="num">
                      <Money value={i.remaining} />
                    </td>
                    <td>
                      <InstallmentBadge state={i.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t.payments.noInstallments} />
        )}
      </Card>
      <Card title={t.payments.payments}>
        {data.payments.length ? (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t.payments.date}</th>
                  <th>{t.payments.method}</th>
                  <th className="num">{t.payments.amount}</th>
                  <th>{t.payments.receipt}</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.id} className={p.status === "cancelled" ? "void" : undefined}>
                    <td>{f.instantDate(p.receivedAt)}</td>
                    <td>
                      {t.payments.methods[p.method]}
                      {p.kind === "refund" ? (
                        <>
                          {" "}
                          <Badge tone="violet">{t.payments.refund}</Badge>
                        </>
                      ) : null}
                      {p.status === "cancelled" ? (
                        <>
                          {" "}
                          <Badge tone="gray">{t.payments.cancelled}</Badge>
                        </>
                      ) : null}
                    </td>
                    <td className="num">
                      <Money value={p.amount} />
                    </td>
                    <td>
                      {p.receiptId && p.receiptNumber ? (
                        <a href={api.fileUrl(`/receipts/${p.receiptId}/pdf`)} target="_blank" rel="noopener">
                          {t.payments.receiptLink(p.receiptNumber)}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t.payments.noPayments} />
        )}
      </Card>
    </>
  );
}

const MAIL_PAGE_SIZE = 50;
const MAIL_TONE: Record<MailItem["status"], "amber" | "blue" | "green" | "gray"> = { received: "amber", notified: "blue", collected: "green", returned: "gray" };

export function MailPage() {
  const { t } = useI18n();
  const f = useFormat();
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["mail", page], queryFn: () => api.get<Page<MailItem>>("/mail", { page, pageSize: MAIL_PAGE_SIZE }) });
  return (
    <>
      <PageHeader title={t.mail.title} subtitle={t.mail.intro} />
      <ErrorBanner error={query.error} retry={() => query.refetch()} />
      {query.isPending ? (
        <Loading />
      ) : (
        <Card footer={query.data && (page > 1 || query.data.hasMore) ? <Pagination page={page} hasMore={query.data.hasMore} onPage={setPage} /> : undefined}>
          {query.data?.items.length ? (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t.mail.received}</th>
                    <th>{t.mail.kind}</th>
                    <th>{t.mail.sender}</th>
                    <th>{t.mail.reference}</th>
                    <th>{t.mail.status}</th>
                    <th>{t.mail.collected}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((m) => (
                    <tr key={m.id}>
                      <td>{f.instantDate(m.receivedAt)}</td>
                      <td>{t.mail.kinds[m.kind]}</td>
                      <td>{m.sender}</td>
                      <td>{m.reference}</td>
                      <td>
                        <Badge tone={MAIL_TONE[m.status]}>{t.mail.statuses[m.status]}</Badge>
                      </td>
                      <td>{m.collectedAt ? t.mail.collectedBy(f.dateTime(m.collectedAt), m.collectedByName) : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={t.mail.none} />
          )}
        </Card>
      )}
    </>
  );
}
