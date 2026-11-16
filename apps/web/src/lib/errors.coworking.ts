import { CW_BOOKING_MESSAGES } from "./errors.cwBookings";
import { CW_CONFIG_MESSAGES } from "./errors.cwConfig";

const CW_VISITOR_MESSAGES: Record<string, string> = {
  visitor_date_past: "La date de la visite est passée.",
  visitor_wrong_status: "Cette visite a déjà changé d'état : rechargez la liste.",
  visitor_host_mismatch: "Un client annonce seulement ses propres visiteurs.",
};

/** French wording of the coworking API error codes. */
export const COWORKING_MESSAGES: Record<string, string> = { ...CW_CONFIG_MESSAGES, ...CW_BOOKING_MESSAGES, ...CW_VISITOR_MESSAGES };
