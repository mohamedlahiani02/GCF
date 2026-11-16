import { formatTnd } from "@gcf/shared";
import PDFDocument from "pdfkit";

export interface InvoiceSnapshot {
  kind: "invoice" | "credit_note";
  number: string;
  /** DD/MM/YYYY */
  issueDate: string;
  dueDate: string | null;
  centre: { name: string; address: string | null; taxId: string | null; footer: string | null };
  buyer: { name: string; company: boolean; taxId: string | null; address: string | null; email: string | null };
  lines: { label: string; amount: number }[];
  total: number;
  net: number;
  tax: number;
  taxBp: number | null;
  credits: { number: string; issueDate: string; reason: string } | null;
}

const NARROW_NBSP = String.fromCharCode(0x202f);

/** Standard PDF fonts cannot draw the narrow no-break space used as the French thousands separator. */
const money = (amount: number) => `${formatTnd(amount, "fr").split(NARROW_NBSP).join(" ")} TND`;
const rate = (bp: number) => `${(bp / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;

export const DEFAULT_INVOICE_FOOTER =
  "Document numéroté sans rupture et archivé ; il ne peut être ni modifié ni supprimé. Toute correction fait l'objet d'un avoir.";

/** A4 invoice or credit note. Amounts include tax; for a company with a tax rate the totals show net and tax. */
export function renderInvoice(snapshot: InvoiceSnapshot): Promise<Buffer> {
  const margin = 48;
  const doc = new PDFDocument({ size: "A4", margin, info: { Title: snapshot.number } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - margin * 2;
  const base = 10;
  const top = doc.y;

  doc
    .font("Helvetica-Bold")
    .fontSize(base + 4)
    .text(snapshot.centre.name, margin, top, { width: width * 0.55 });
  doc.font("Helvetica").fontSize(base);
  if (snapshot.centre.address) doc.text(snapshot.centre.address, { width: width * 0.55 });
  if (snapshot.centre.taxId) doc.text(`Matricule fiscal : ${snapshot.centre.taxId}`, { width: width * 0.55 });
  const leftBottom = doc.y;
  doc
    .font("Helvetica")
    .fontSize(base - 1)
    .text(snapshot.kind === "invoice" ? "FACTURE" : "AVOIR", margin, top, { width, align: "right" });
  doc
    .font("Helvetica-Bold")
    .fontSize(base + 4)
    .text(snapshot.number, { width, align: "right" });
  doc.font("Helvetica").fontSize(base).text(`Date : ${snapshot.issueDate}`, { width, align: "right" });
  if (snapshot.dueDate) doc.text(`Échéance : ${snapshot.dueDate}`, { width, align: "right" });
  doc.y = Math.max(doc.y, leftBottom) + 16;

  const boxX = margin + width * 0.5;
  const boxY = doc.y;
  doc.font("Helvetica-Bold").text(snapshot.kind === "invoice" ? "Facturé à" : "Avoir au profit de", boxX + 10, boxY + 8, { width: width * 0.5 - 20 });
  doc.font("Helvetica").text(snapshot.buyer.name, { width: width * 0.5 - 20 });
  if (snapshot.buyer.address) doc.text(snapshot.buyer.address, { width: width * 0.5 - 20 });
  if (snapshot.buyer.taxId) doc.text(`Matricule fiscal : ${snapshot.buyer.taxId}`, { width: width * 0.5 - 20 });
  if (snapshot.buyer.email) doc.text(snapshot.buyer.email, { width: width * 0.5 - 20 });
  const boxBottom = doc.y + 8;
  doc.rect(boxX, boxY, width * 0.5, boxBottom - boxY).stroke();
  doc.y = boxBottom + 16;

  if (snapshot.credits) {
    doc
      .font("Helvetica-Bold")
      .text("Annule la facture : ", margin, doc.y, { continued: true })
      .font("Helvetica")
      .text(`${snapshot.credits.number} du ${snapshot.credits.issueDate}, motif : ${snapshot.credits.reason}`, { width });
    doc.moveDown(0.8);
  }

  const amountWidth = 120;
  doc.font("Helvetica-Bold");
  let y = doc.y;
  doc.text("Désignation", margin, y, { width: width - amountWidth });
  doc.text("Montant TTC", margin + width - amountWidth, y, { width: amountWidth, align: "right" });
  doc
    .moveTo(margin, doc.y + 2)
    .lineTo(margin + width, doc.y + 2)
    .stroke();
  doc.moveDown(0.4).font("Helvetica");
  for (const line of snapshot.lines) {
    y = doc.y;
    doc.text(line.label, margin, y, { width: width - amountWidth - 8 });
    const after = doc.y;
    doc.text(money(line.amount), margin + width - amountWidth, y, { width: amountWidth, align: "right" });
    doc.y = Math.max(after, doc.y) + 3;
  }
  doc
    .moveTo(margin, doc.y)
    .lineTo(margin + width, doc.y)
    .stroke();
  doc.moveDown(0.5);

  const totalRow = (label: string, amount: number, bold = false) => {
    y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? base + 2 : base);
    doc.text(label, margin + width - 320, y, { width: 200, align: "right" });
    doc.text(money(amount), margin + width - amountWidth, y, { width: amountWidth, align: "right" });
    doc.moveDown(0.2);
  };
  if (snapshot.taxBp !== null) {
    totalRow("Total hors taxe", snapshot.net);
    totalRow(`Taxe (${rate(snapshot.taxBp)})`, snapshot.tax);
  }
  totalRow(snapshot.kind === "invoice" ? "Total TTC" : "Total de l'avoir TTC", snapshot.total, true);
  doc.font("Helvetica").fontSize(base);

  const footerText = snapshot.centre.footer ?? DEFAULT_INVOICE_FOOTER;
  const footerHeight = doc.heightOfString(footerText, { width }) + 8;
  doc
    .fontSize(base - 2)
    .fillColor("#444444")
    .text(footerText, margin, Math.max(doc.y + 24, doc.page.height - margin - footerHeight), { width });
  doc.end();
  return done;
}
