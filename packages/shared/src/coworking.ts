/** Coworking vocabulary shared by the API, the back-office and the client portal. */

export const CW_CATEGORIES = ["hot_desk", "dedicated_desk", "private_office", "meeting_room", "phone_booth", "event_space"] as const;
export type CwCategory = (typeof CW_CATEGORIES)[number];

/** Dedicated desks and private offices are assigned through a subscription; the other categories are booked. */
export const ASSIGNED_CATEGORIES: readonly CwCategory[] = ["dedicated_desk", "private_office"];
export const isBookableCategory = (category: CwCategory) => !ASSIGNED_CATEGORIES.includes(category);

export const CW_CATEGORY_LABELS: Record<"fr" | "en", Record<CwCategory, string>> = {
  fr: {
    hot_desk: "Poste flexible",
    dedicated_desk: "Bureau dédié",
    private_office: "Bureau privé",
    meeting_room: "Salle de réunion",
    phone_booth: "Cabine téléphonique",
    event_space: "Espace événementiel",
  },
  en: {
    hot_desk: "Hot desk",
    dedicated_desk: "Dedicated desk",
    private_office: "Private office",
    meeting_room: "Meeting room",
    phone_booth: "Phone booth",
    event_space: "Event space",
  },
};

export const CW_BOOKING_STATUSES = ["requested", "confirmed", "checked_in", "completed", "cancelled", "refused", "expired", "no_show"] as const;
export type CwBookingStatus = (typeof CW_BOOKING_STATUSES)[number];

/** Statuses that occupy the resource. */
export const OCCUPYING_STATUSES: readonly CwBookingStatus[] = ["requested", "confirmed", "checked_in"];

/**
 * State of a resource on the plan at a given instant, shared by the back-office legend and the portal:
 * free, requested (waiting for validation), booked, occupied (checked in), blocked or out of service,
 * assigned (dedicated through a subscription).
 */
export const PLAN_STATES = ["free", "requested", "booked", "occupied", "blocked", "assigned"] as const;
export type PlanState = (typeof PLAN_STATES)[number];
