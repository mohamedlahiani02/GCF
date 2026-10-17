/** A calendar event exported as an iCalendar file (RFC 5545). */
export interface CalendarEvent {
  uid: string;
  stamp: Date;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  location: string | null;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
}

/** RFC 5545 3.3.10 TEXT: backslash, semicolon and comma are escaped, line breaks become \n. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** UTC date-time form of RFC 5545 3.3.5, for example 20261021T080000Z. */
export function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

/**
 * RFC 5545 3.1: lines longer than 75 octets are folded, each continuation starting with one space. Folding happens
 * between characters, never inside a UTF-8 sequence.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    const limit = parts.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** One VCALENDAR holding one VEVENT, with CRLF line endings. */
export function calendarFile(event: CalendarEvent, productId: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${productId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(event.stamp)}`,
    `DTSTART:${utcStamp(event.startsAt)}`,
    `DTEND:${utcStamp(event.endsAt)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    `STATUS:${event.status}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
