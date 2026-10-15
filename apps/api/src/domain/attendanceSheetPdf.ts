import PDFDocument from "pdfkit";

export interface AttendanceSheetPdf {
  centreName: string;
  groupName: string;
  sessionLabel: string;
  instructorName: string;
  roomName: string | null;
  students: { lastName: string; firstName: string; guestOf: string | null }[];
  blankRows: number;
}

const MARGIN = 40;
const COLUMNS = [
  { title: "N°", width: 28 },
  { title: "Élève", width: 167 },
  { title: "Présent", width: 52 },
  { title: "Absent", width: 52 },
  { title: "Justifié", width: 52 },
  { title: "Autre groupe", width: 74 },
  { title: "Note", width: 90 },
];

/** Printable A4 attendance sheet: one row per student, tick boxes, signature areas. */
export function renderAttendanceSheet(sheet: AttendanceSheetPdf): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: { Title: `Feuille de présence - ${sheet.groupName}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font("Helvetica-Bold").fontSize(14).text(sheet.centreName);
  doc.font("Helvetica").fontSize(11).text("Feuille de présence");
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(`Groupe : ${sheet.groupName}`);
  doc.text(`Séance : ${sheet.sessionLabel}`);
  doc.text(`Intervenant : ${sheet.instructorName}`);
  if (sheet.roomName) doc.text(`Salle : ${sheet.roomName}`);
  doc.moveDown(0.8);

  const rowHeight = 24;
  let y = doc.y;
  const drawRow = (cells: string[], bold: boolean) => {
    let x = MARGIN;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    COLUMNS.forEach((column, index) => {
      doc.rect(x, y, column.width, rowHeight).stroke();
      doc.text(cells[index] ?? "", x + 4, y + 8, { width: column.width - 8, height: rowHeight - 8, ellipsis: true, lineBreak: false });
      x += column.width;
    });
    y += rowHeight;
  };
  drawRow(
    COLUMNS.map((c) => c.title),
    true,
  );
  const rows = [
    ...sheet.students.map((s) => `${s.lastName} ${s.firstName}${s.guestOf ? ` (invité, ${s.guestOf})` : ""}`),
    ...Array.from({ length: sheet.blankRows }, () => ""),
  ];
  rows.forEach((name, index) => {
    if (y + rowHeight > doc.page.height - MARGIN - 110) {
      doc.addPage();
      y = MARGIN;
      drawRow(
        COLUMNS.map((c) => c.title),
        true,
      );
    }
    drawRow([String(index + 1), name, "", "", "", "", ""], false);
  });

  const signatureY = Math.max(y + 24, doc.page.height - MARGIN - 90);
  doc.font("Helvetica").fontSize(9);
  doc.rect(MARGIN, signatureY, 240, 80).stroke();
  doc.text("Signature de l'intervenant", MARGIN + 6, signatureY + 6);
  doc.rect(doc.page.width - MARGIN - 240, signatureY, 240, 80).stroke();
  doc.text("Visa du secrétariat", doc.page.width - MARGIN - 234, signatureY + 6);
  doc.end();
  return done;
}
