import { formatTnd } from "@gcf/shared";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export type ColumnKind = "text" | "money" | "number" | "date" | "percent";

export interface ReportTable {
  title: string;
  subtitle: string;
  columns: { key: string; label: string; kind: ColumnKind }[];
  rows: Record<string, string | number | null>[];
}

const NARROW_NBSP = String.fromCharCode(0x202f);

function display(value: string | number | null, kind: ColumnKind): string {
  if (value === null || value === undefined) return "";
  if (kind === "money") return formatTnd(Number(value), "fr").split(NARROW_NBSP).join(" ");
  if (kind === "percent") return `${(Number(value) / 100).toFixed(1).replace(".", ",")} %`;
  if (kind === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10).split("-").reverse().join("/");
  return String(value);
}

/** CSV for French spreadsheets: semicolon separator, UTF-8 with BOM, amounts with a decimal comma. */
export function toCsv(table: ReportTable): Buffer {
  const escape = (text: string) => (/[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = [table.columns.map((c) => escape(c.label)).join(";")];
  for (const row of table.rows) {
    lines.push(
      table.columns
        .map((c) => {
          const v = row[c.key] ?? null;
          if (c.kind === "money" && v !== null) return (Number(v) / 1000).toFixed(3).replace(".", ",");
          return escape(display(v, c.kind));
        })
        .join(";"),
    );
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join("\r\n"), "utf8")]);
}

/** Excel workbook with typed cells: amounts are numbers in TND with three decimals. */
export async function toXlsx(table: ReportTable): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(table.title.slice(0, 31));
  sheet.addRow([table.title]).font = { bold: true, size: 13 };
  sheet.addRow([table.subtitle]);
  sheet.addRow([]);
  const header = sheet.addRow(table.columns.map((c) => c.label));
  header.font = { bold: true };
  for (const row of table.rows) {
    sheet.addRow(
      table.columns.map((c) => {
        const v = row[c.key] ?? null;
        if (v === null) return null;
        if (c.kind === "money") return Number(v) / 1000;
        if (c.kind === "percent") return Number(v) / 10_000;
        if (c.kind === "number") return Number(v);
        return display(v, c.kind);
      }),
    );
  }
  table.columns.forEach((c, i) => {
    const column = sheet.getColumn(i + 1);
    column.width = Math.max(12, Math.min(40, c.label.length + 4));
    if (c.kind === "money") column.numFmt = "#,##0.000";
    if (c.kind === "percent") column.numFmt = "0.0%";
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Landscape A4 table, repeated header on each page. */
export function toPdf(table: ReportTable): Promise<Buffer> {
  const margin = 36;
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin, info: { Title: table.title } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - margin * 2;
  const weights = table.columns.map((c) => (c.kind === "text" ? 3 : 1.4));
  const total = weights.reduce((s, w) => s + w, 0);
  const widths = weights.map((w) => (w / total) * width);
  doc.font("Helvetica-Bold").fontSize(13).text(table.title);
  doc.font("Helvetica").fontSize(9).text(table.subtitle);
  doc.moveDown(0.6);
  const rowHeight = 16;
  let y = doc.y;
  const drawRow = (cells: string[], bold: boolean, kinds: ColumnKind[]) => {
    let x = margin;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    cells.forEach((cell, i) => {
      const align = kinds[i] === "text" || kinds[i] === "date" ? "left" : "right";
      doc.text(cell, x + 2, y + 4, { width: widths[i]! - 4, align, lineBreak: false, ellipsis: true });
      x += widths[i]!;
    });
    doc
      .moveTo(margin, y + rowHeight)
      .lineTo(margin + width, y + rowHeight)
      .lineWidth(0.3)
      .stroke();
    y += rowHeight;
  };
  const kinds = table.columns.map((c) => c.kind);
  drawRow(
    table.columns.map((c) => c.label),
    true,
    kinds,
  );
  for (const row of table.rows) {
    if (y + rowHeight > doc.page.height - margin) {
      doc.addPage();
      y = margin;
      drawRow(
        table.columns.map((c) => c.label),
        true,
        kinds,
      );
    }
    drawRow(
      table.columns.map((c) => display(row[c.key] ?? null, c.kind)),
      false,
      kinds,
    );
  }
  if (table.rows.length === 0)
    doc
      .font("Helvetica")
      .fontSize(9)
      .text("Aucune donnée pour cette période.", margin, y + 6);
  doc.end();
  return done;
}
