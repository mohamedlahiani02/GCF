import { formatTnd } from "@gcf/shared";
import PDFDocument from "pdfkit";

export interface RentalQuote {
  centreName: string;
  centreAddress: string | null;
  reference: string;
  renter: { name: string; company: string | null; phone: string | null; email: string | null };
  roomName: string;
  unitLabel: string;
  quantityLabel: string;
  unitPrice: number;
  total: number;
  slots: string[];
  schedule: { label: string; dueDate: string; amount: number }[];
  issuedAt: string;
}

const NARROW_NBSP = String.fromCharCode(0x202f);
const money = (amount: number) => `${formatTnd(amount, "fr").split(NARROW_NBSP).join(" ")} TND`;

/** Rental agreement summary: renter, room, slots, price from the tariff grid and payment schedule. */
export function renderRentalQuote(q: RentalQuote): Promise<Buffer> {
  const margin = 48;
  const doc = new PDFDocument({ size: "A4", margin, info: { Title: `Location ${q.reference}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - margin * 2;
  doc.font("Helvetica-Bold").fontSize(14).text(q.centreName);
  doc.font("Helvetica").fontSize(10);
  if (q.centreAddress) doc.text(q.centreAddress);
  doc.moveDown();
  doc.font("Helvetica-Bold").fontSize(13).text("Contrat de location de salle");
  doc.font("Helvetica").fontSize(10).text(`Référence : ${q.reference}    Émis le : ${q.issuedAt}`);
  doc.moveDown();
  doc
    .font("Helvetica-Bold")
    .text("Loueur : ", { continued: true })
    .font("Helvetica")
    .text(`${q.renter.name}${q.renter.company ? `, ${q.renter.company}` : ""}`);
  const contact = [q.renter.phone, q.renter.email].filter(Boolean).join(" · ");
  if (contact) doc.text(contact);
  doc.font("Helvetica-Bold").text("Salle : ", { continued: true }).font("Helvetica").text(q.roomName);
  doc
    .font("Helvetica-Bold")
    .text("Tarif : ", { continued: true })
    .font("Helvetica")
    .text(`${money(q.unitPrice)} par ${q.unitLabel}, ${q.quantityLabel}`);
  doc.font("Helvetica-Bold").text("Total : ", { continued: true }).font("Helvetica").text(money(q.total));
  doc.moveDown();
  doc.font("Helvetica-Bold").text("Créneaux réservés");
  doc.font("Helvetica").fontSize(9);
  const shown = q.slots.slice(0, 40);
  for (const slot of shown) doc.text(`- ${slot}`);
  if (q.slots.length > shown.length) doc.text(`... et ${q.slots.length - shown.length} autres créneaux`);
  doc.moveDown().fontSize(10).font("Helvetica-Bold").text("Échéancier");
  doc.font("Helvetica");
  for (const line of q.schedule) {
    const y = doc.y;
    doc.text(`${line.label}, échéance le ${line.dueDate.split("-").reverse().join("/")}`, margin, y, { width: width - 120 });
    doc.text(money(line.amount), margin + width - 110, y, { width: 110, align: "right" });
  }
  const signatureY = Math.max(doc.y + 30, doc.page.height - margin - 100);
  doc.rect(margin, signatureY, 220, 80).stroke();
  doc.fontSize(9).text("Le loueur, lu et approuvé", margin + 6, signatureY + 6);
  doc.rect(margin + width - 220, signatureY, 220, 80).stroke();
  doc.text("Le centre, signature et cachet", margin + width - 214, signatureY + 6);
  doc.end();
  return done;
}
