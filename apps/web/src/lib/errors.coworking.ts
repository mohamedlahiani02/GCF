import { CW_BOOKING_MESSAGES } from "./errors.cwBookings";
import { CW_CONFIG_MESSAGES } from "./errors.cwConfig";

/** French wording of the coworking API error codes. */
export const COWORKING_MESSAGES: Record<string, string> = { ...CW_CONFIG_MESSAGES, ...CW_BOOKING_MESSAGES };
