import { api } from "../../api/client";
import type { MediaFile } from "./api";

/** Longest side of an uploaded image: enough for a sharp plan on a large screen, small enough for the 5 MB limit. */
const MAX_IMAGE_SIDE = 2560;
const WEBP_QUALITY = 0.85;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

export const mediaUrl = (mediaId: string) => api.fileUrl(`/media/${mediaId}/file`);

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("file could not be read"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Reads an image in the browser, scales it down to at most 2560 px on its long side and re-encodes it as WebP
 * (browsers without a WebP encoder return PNG, which the API also accepts), then stores it in the media library.
 */
export async function uploadImage(file: File, alt: string, folder: string): Promise<MediaFile> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas is not available");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("image could not be encoded"))), "image/webp", WEBP_QUALITY),
  );
  return api.post<MediaFile>("/media", { image: await blobToDataUrl(blob), alt, folder });
}

/** "12,5" or "12.5" -> 1250 basis points; null when the text is not a percentage between 0 and 100 with two decimals at most. */
export function parsePercent(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}

/** 1250 -> "12,5": the editable form of a percentage stored in basis points. */
export function percentText(bp: number): string {
  return (bp / 100).toFixed(bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2).replace(".", ",");
}

/** A whole number typed in a field, or null when it is empty, not an integer or outside the range. */
export function parseInteger(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
}

/** Hours typed with up to two decimals ("1,5") as minutes, rounded to the minute; null when invalid or zero. */
export function parseHours(text: string): number | null {
  const match = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const hundredths = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  const minutes = Math.round((hundredths * 60) / 100);
  return minutes > 0 ? minutes : null;
}

/** 90 -> "1,5": minutes shown in an hours field. */
export function hoursText(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0$/, "").replace(".", ",");
}

/** 90 -> "1 h 30", 45 -> "45 min". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

export const WEEKDAY_SHORT = ["", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** [1,2,3,4,5] -> "Lun, Mar, Mer, Jeu, Ven"; every day -> "Tous les jours". */
export function weekdaysLabel(days: number[]): string {
  if (days.length === 7) return "Tous les jours";
  return [...days]
    .sort()
    .map((d) => WEEKDAY_SHORT[d])
    .join(", ");
}
