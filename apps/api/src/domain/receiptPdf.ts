import { formatTnd } from "@gcf/shared";
import PDFDocument from "pdfkit";

export interface ReceiptSnapshot {
  number: string;
  kind: "payment" | "refund" | "cancellation";
  issuedAt: string;
  centre: { name: string; address: string | null; taxId: string | null; footer: string | null };
  payer: { name: string; guardianName: string | null };
  method: "cash" | "transfer" | "cheque" | "card";
  chequeNumber: string | null;
  chequeBank: string | null;
  reference: string | null;
  amount: number;
  lines: { label: string; amount: number }[];
  creditAfter: number;
  remainingAfter: number;
  cancels: { number: string; reason: string } | null;
}

const METHOD_LABELS: Record<ReceiptSnapshot["method"], string> = { cash: "Espèces", transfer: "Virement", cheque: "Chèque", card: "Carte" };
const TITLES: Record<ReceiptSnapshot["kind"], string> = { payment: "REÇU DE PAIEMENT", refund: "REÇU DE REMBOURSEMENT", cancellation: "REÇU D'ANNULATION" };

const NARROW_NBSP = String.fromCharCode(0x202f);

/** Standard PDF fonts cannot draw the narrow no-break space used as the French thousands separator. */
function money(amount: number): string {
  return `${formatTnd(amount, "fr").split(NARROW_NBSP).join(" ")} TND`;
}

export const DEFAULT_RECEIPT_FOOTER =
  "Reçu délivré pour servir et valoir ce que de droit. Document généré électroniquement, numéroté et archivé ; " +
  "il ne peut être ni modifié ni supprimé. Toute erreur est corrigée par un reçu d'annulation.";

/** A4 or A5 (half page) receipt. A reprint carries the DUPLICATA mention. */
export function renderReceipt(snapshot: ReceiptSnapshot, options: { format: "A4" | "A5"; duplicate: boolean }): Promise<Buffer> {
  const margin = options.format === "A4" ? 48 : 32;
  const doc = new PDFDocument({ size: options.format, margin, info: { Title: snapshot.number } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - margin * 2;
  const base = options.format === "A4" ? 10 : 8.5;

  const startY = doc.y;
  if (options.duplicate) {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc
      .font("Helvetica-Bold")
      .fontSize(options.format === "A4" ? 72 : 48)
      .fillColor("#d0d0d0");
    doc.text("DUPLICATA", 0, doc.page.height / 2 - 40, { width: doc.page.width, align: "center" });
    doc.restore().fillColor("#000000");
  }

  const top = startY;
  doc
    .font("Helvetica-Bold")
    .fontSize(base + 4)
    .text(snapshot.centre.name, margin, top, { width: width * 0.6 });
  doc.font("Helvetica").fontSize(base);
  if (snapshot.centre.address) doc.text(snapshot.centre.address, { width: width * 0.6 });
  if (snapshot.centre.taxId) doc.text(`Matricule fiscal : ${snapshot.centre.taxId}`, { width: width * 0.6 });
  const leftBottom = doc.y;
  doc
    .font("Helvetica")
    .fontSize(base - 1)
    .text(TITLES[snapshot.kind], margin, top, { width, align: "right" });
  doc
    .font("Helvetica-Bold")
    .fontSize(base + 4)
    .text(snapshot.number, { width, align: "right" });
  doc.font("Helvetica").fontSize(base).text(`Date : ${snapshot.issuedAt}`, { width, align: "right" });
  if (options.duplicate) doc.font("Helvetica-Bold").text("DUPLICATA", { width, align: "right" }).font("Helvetica");
  doc.y = Math.max(doc.y, leftBottom) + 12;
  doc
    .moveTo(margin, doc.y)
    .lineTo(margin + width, doc.y)
    .stroke();
  doc.moveDown(0.8);

  doc.font("Helvetica-Bold").text("Reçu de : ", margin, doc.y, { continued: true }).font("Helvetica").text(snapshot.payer.name);
  if (snapshot.payer.guardianName)
    doc.font("Helvetica-Bold").text("Parent ou tuteur : ", { continued: true }).font("Helvetica").text(snapshot.payer.guardianName);
  let method = METHOD_LABELS[snapshot.method];
  if (snapshot.method === "cheque") method += ` n° ${snapshot.chequeNumber ?? ""}${snapshot.chequeBank ? `, ${snapshot.chequeBank}` : ""}`;
  if (snapshot.reference) method += ` (réf. ${snapshot.reference})`;
  doc.font("Helvetica-Bold").text("Mode : ", { continued: true }).font("Helvetica").text(method);
  if (snapshot.cancels) {
    doc
      .font("Helvetica-Bold")
      .text("Annule le reçu : ", { continued: true })
      .font("Helvetica")
      .text(`${snapshot.cancels.number}, motif : ${snapshot.cancels.reason}`);
  }
  doc.moveDown(0.8);

  const amountWidth = 110;
  const rowY = () => doc.y;
  doc.font("Helvetica-Bold");
  let y = rowY();
  doc.text("Objet", margin, y, { width: width - amountWidth });
  doc.text("Montant", margin + width - amountWidth, y, { width: amountWidth, align: "right" });
  doc
    .moveTo(margin, doc.y + 2)
    .lineTo(margin + width, doc.y + 2)
    .stroke();
  doc.moveDown(0.4).font("Helvetica");
  const lines = snapshot.lines.length
    ? snapshot.lines
    : [{ label: snapshot.kind === "payment" ? "Avance (solde créditeur)" : "Remboursement", amount: snapshot.amount }];
  for (const line of lines) {
    y = rowY();
    doc.text(line.label, margin, y, { width: width - amountWidth - 8 });
    const after = doc.y;
    doc.text(money(line.amount), margin + width - amountWidth, y, { width: amountWidth, align: "right" });
    doc.y = Math.max(after, doc.y) + 2;
  }
  doc
    .moveTo(margin, doc.y)
    .lineTo(margin + width, doc.y)
    .stroke();
  doc.moveDown(0.4);
  y = rowY();
  doc
    .font("Helvetica-Bold")
    .fontSize(base + 2)
    .text("Montant", margin, y, { width: width - amountWidth });
  doc.text(money(snapshot.amount), margin + width - amountWidth, y, { width: amountWidth, align: "right" });
  doc.font("Helvetica").fontSize(base).moveDown(0.8);
  doc.text(`Reste à payer après cette opération : ${money(snapshot.remainingAfter)}`, margin);
  doc.text(`Solde créditeur : ${money(snapshot.creditAfter)}`, margin);

  const signatureHeight = options.format === "A4" ? 80 : 56;
  const footerText = snapshot.centre.footer ?? DEFAULT_RECEIPT_FOOTER;
  const footerHeight = doc.heightOfString(footerText, { width }) + 8;
  const signatureY = Math.max(doc.y + 20, doc.page.height - margin - footerHeight - signatureHeight - 12);
  doc.rect(margin + width - 220, signatureY, 220, signatureHeight).stroke();
  doc.text("Signature et cachet", margin + width - 214, signatureY + 6);
  doc
    .fontSize(base - 2)
    .fillColor("#444444")
    .text(footerText, margin, signatureY + signatureHeight + 12, { width });
  doc.end();
  return done;
}
