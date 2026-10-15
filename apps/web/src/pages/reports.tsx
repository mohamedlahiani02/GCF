import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api/client";
import { usePage } from "../components/shell";
import { Card, Empty, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { frDate, percent, tnd, todayIso } from "../lib/format";

interface ReportTable {
  title: string;
  subtitle: string;
  columns: { key: string; label: string; kind: "text" | "money" | "number" | "date" | "percent" }[];
  rows: Record<string, string | number | null>[];
}

function cell(value: string | number | null, kind: ReportTable["columns"][number]["kind"]): string {
  if (value === null || value === undefined) return "";
  if (kind === "money") return tnd(Number(value));
  if (kind === "percent") return percent(Number(value));
  if (kind === "date") return frDate(String(value));
  return String(value);
}

export function ReportsPage() {
  usePage(["Rapports"]);
  const [params, setParams] = useSearchParams();
  const list = useQuery({ queryKey: ["reports"], queryFn: () => api.get<{ name: string; title: string }[]>("/reports") });
  const name = params.get("rapport") ?? list.data?.[0]?.name ?? "";
  const [from, setFrom] = useState(`${todayIso().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayIso());
  const report = useQuery({
    queryKey: ["report", name, from, to],
    queryFn: () => api.get<ReportTable>(`/reports/${name}`, { from, to }),
    enabled: !!name && !!from && !!to && to >= from,
  });
  const exportUrl = (format: "csv" | "xlsx" | "pdf") => api.fileUrl(`/reports/${name}`, { from, to, format });
  return (
    <>
      <PageHeader title="Rapports" subtitle="Chaque export est tracé au journal d'audit" />
      <div className="grid2" style={{ gridTemplateColumns: "280px 1fr", alignItems: "start" }}>
        <Card title="Rapports disponibles">
          <ErrorBanner error={list.error} />
          <nav className="stack" style={{ gap: 2, padding: 8 }}>
            {(list.data ?? []).map((r) => (
              <button
                key={r.name}
                type="button"
                className={`navi${r.name === name ? " on" : ""}`}
                style={{ border: 0, background: r.name === name ? undefined : "transparent", textAlign: "start" }}
                onClick={() => setParams({ rapport: r.name })}
              >
                {r.title}
              </button>
            ))}
          </nav>
        </Card>
        <Card
          title={
            <div className="row center" style={{ gap: 8 }}>
              <input className="input" type="date" aria-label="Du" value={from} onChange={(e) => setFrom(e.target.value)} />
              <input className="input" type="date" aria-label="Au" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          }
          actions={
            name && to >= from ? (
              <>
                <a className="btn" href={exportUrl("xlsx")}>
                  Excel
                </a>
                <a className="btn" href={exportUrl("csv")}>
                  CSV
                </a>
                <a className="btn" href={exportUrl("pdf")}>
                  PDF
                </a>
              </>
            ) : null
          }
        >
          <ErrorBanner error={report.error} />
          {to < from ? (
            <div className="card-b err-text">La fin de période précède le début.</div>
          ) : report.isPending ? (
            <Loading />
          ) : report.data ? (
            <>
              <div className="card-b">
                <h2 className="h2">{report.data.title}</h2>
                <div className="cap">{report.data.subtitle}</div>
              </div>
              {report.data.rows.length === 0 ? (
                <Empty title="Aucune donnée sur la période" />
              ) : (
                <div className="xs">
                  <table className="tbl">
                    <thead>
                      <tr>
                        {report.data.columns.map((c) => (
                          <th key={c.key} className={c.kind === "money" || c.kind === "number" || c.kind === "percent" ? "num" : undefined}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {report.data.rows.map((row, i) => (
                        <tr key={i}>
                          {report.data!.columns.map((c) => (
                            <td key={c.key} className={c.kind === "money" || c.kind === "number" || c.kind === "percent" ? "num" : undefined}>
                              {cell(row[c.key] ?? null, c.kind)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </Card>
      </div>
    </>
  );
}
