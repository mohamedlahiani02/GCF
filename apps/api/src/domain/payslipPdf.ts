import { formatTnd } from "@gcf/shared";
import PDFDocument from "pdfkit";

/** Proof of a payment to an instructor: the items it settles, with what was due, already paid, paid now and left. */
export interface SettlementProof {
  centreName: string;
  centreAddress: string | null;
  number: string;
  instructorName: string;
  employment: string;
  paidOn: string;
  method: "cash" | "transfer" | "cheque";
  reference: string | null;
  lines: { label: string; period: string; due: number; already: number; paid: number; remaining: number }[];
  total: number;
  issuedAt: string;
}

const METHOD_FR: Record<SettlementProof["method"], string> = { cash: "Espèces", transfer: "Virement", cheque: "Chèque" };
const NARROW_NBSP = String.fromCharCode(0x202f);
// Standard PDF fonts cannot draw the narrow no-break space used as the French thousands separator.
const money = (amount: number) => formatTnd(amount, "fr").split(NARROW_NBSP).join(" ");

export function renderSettlement(data: SettlementProof): Promise<Buffer> {
  const margin = 40;
  const doc = new PDFDocument({ size: "A4", margin, info: { Title: `Justificatif de paiement ${data.number} - ${data.instructorName}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - margin * 2;
  const amountWidth = 70;
  const labelWidth = width - amountWidth * 4;

  doc.font("Helvetica-Bold").fontSize(14).text(data.centreName);
  doc.font("Helvetica").fontSize(10);
  if (data.centreAddress) doc.text(data.centreAddress);
  doc.moveDown();
  doc.font("Helvetica-Bold").fontSize(13).text(`Justificatif de paiement de rémunération n° ${data.number}`);
  doc.font("Helvetica").fontSize(10).text(`Intervenant : ${data.instructorName} (${data.employment})`);
  doc.text(`Payé le : ${data.paidOn}, par ${METHOD_FR[data.method]}${data.reference ? `, référence ${data.reference}` : ""}`);
  doc.text(`Émis le : ${data.issuedAt}`);
  doc.moveDown();

  const columns = (cells: string[], bold: boolean) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    doc.text(cells[0]!, margin, y, { width: labelWidth - 6 });
    let bottom = doc.y;
    if (cells[1]) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#444444")
        .text(cells[1], margin, bottom, { width: labelWidth - 6 })
        .fillColor("#000000");
      bottom = doc.y;
    }
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    cells.slice(2).forEach((text, i) => doc.text(text, margin + labelWidth + i * amountWidth, y, { width: amountWidth, align: "right" }));
    doc.y = Math.max(bottom, doc.y) + 4;
  };
  columns(["Élément de rémunération", "", "Dû", "Déjà payé", "Payé ici", "Reste"], true);
  doc
    .moveTo(margin, doc.y)
    .lineTo(margin + width, doc.y)
    .stroke();
  doc.moveDown(0.3);
  for (const line of data.lines) columns([line.label, line.period, money(line.due), money(line.already), money(line.paid), money(line.remaining)], false);
  doc
    .moveTo(margin, doc.y)
    .lineTo(margin + width, doc.y)
    .stroke();
  doc.moveDown(0.3);
  columns(["Total payé (TND)", "", "", "", money(data.total), ""], true);

  const signatureY = Math.max(doc.y + 30, doc.page.height - margin - 110);
  doc.rect(margin, signatureY, 220, 80).stroke();
  doc
    .font("Helvetica")
    .fontSize(9)
    .text("Signature de l'intervenant (pour acquit)", margin + 6, signatureY + 6);
  doc.rect(margin + width - 220, signatureY, 220, 80).stroke();
  doc.text("Signature et cachet du centre", margin + width - 214, signatureY + 6);
  doc.end();
  return done;
}
