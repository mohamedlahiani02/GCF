import { formatTnd } from "@gcf/shared";
import PDFDocument from "pdfkit";

export interface PayslipData {
  centreName: string;
  centreAddress: string | null;
  instructorName: string;
  employment: string;
  periodLabel: string;
  lines: { label: string; detail: string; amount: number }[];
  adjustments: { label: string; amount: number }[];
  total: number;
  issuedAt: string;
}

const NARROW_NBSP = String.fromCharCode(0x202f);
const money = (amount: number) => `${formatTnd(amount, "fr").split(NARROW_NBSP).join(" ")} TND`;

export function renderPayslip(data: PayslipData): Promise<Buffer> {
  const margin = 48;
  const doc = new PDFDocument({ size: "A4", margin, info: { Title: `Justificatif de paie - ${data.instructorName} - ${data.periodLabel}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - margin * 2;
  const amountWidth = 110;

  doc.font("Helvetica-Bold").fontSize(14).text(data.centreName);
  doc.font("Helvetica").fontSize(10);
  if (data.centreAddress) doc.text(data.centreAddress);
  doc.moveDown();
  doc.font("Helvetica-Bold").fontSize(13).text("Justificatif de rémunération");
  doc.font("Helvetica").fontSize(10).text(`Intervenant : ${data.instructorName} (${data.employment})`);
  doc.text(`Période : ${data.periodLabel}`);
  doc.text(`Émis le : ${data.issuedAt}`);
  doc.moveDown();

  const row = (label: string, detail: string, amount: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).text(label, margin, y, { width: width - amountWidth - 8 });
    if (detail) doc.font("Helvetica").fontSize(8).fillColor("#444444").text(detail, { width: width - amountWidth - 8 }).fillColor("#000000");
    const after = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).text(amount, margin + width - amountWidth, y, { width: amountWidth, align: "right" });
    doc.y = Math.max(after, doc.y) + 4;
  };
  row("Détail", "", "Montant", true);
  doc.moveTo(margin, doc.y).lineTo(margin + width, doc.y).stroke();
  doc.moveDown(0.3);
  for (const line of data.lines) row(line.label, line.detail, money(line.amount));
  for (const adjustment of data.adjustments) row(adjustment.label, "", money(adjustment.amount));
  doc.moveTo(margin, doc.y).lineTo(margin + width, doc.y).stroke();
  doc.moveDown(0.3);
  row("Net à payer", "", money(data.total), true);

  const signatureY = Math.max(doc.y + 30, doc.page.height - margin - 110);
  doc.rect(margin, signatureY, 220, 80).stroke();
  doc.fontSize(9).text("Signature de l'intervenant", margin + 6, signatureY + 6);
  doc.rect(margin + width - 220, signatureY, 220, 80).stroke();
  doc.text("Signature et cachet du centre", margin + width - 214, signatureY + 6);
  doc.end();
  return done;
}
