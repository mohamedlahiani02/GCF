import { mulDivRound } from "./money.js";

/**
 * Attendance statuses recorded on the sheet of the student's own group.
 * `present_other_group` is the make-up case: the student attended a session of another (host) group.
 */
export const ATTENDANCE_STATUSES = ["present", "absent", "absent_justified", "present_other_group"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface AttendanceRateSettings {
  /** A justified absence counts as present in the rate. Global setting, overridable per group. Default false. */
  countJustifiedAsPresent: boolean;
  /** A make-up in another group counts as present for the origin group. Global setting, overridable per group. Default true. */
  countOtherGroupAsPresent: boolean;
}

export const DEFAULT_ATTENDANCE_RATE_SETTINGS: AttendanceRateSettings = {
  countJustifiedAsPresent: false,
  countOtherGroupAsPresent: true,
};

/** An exact rate: counted / total. Kept as a fraction so nothing is rounded before it is applied to an amount. */
export interface Rate {
  numerator: number;
  denominator: number;
}

/**
 * Rate = counted presences / (enrolled students x sessions held).
 * Only records of enrolled students are passed in: guests invited for a make-up belong to the host sheet
 * but never enter the host group's denominator.
 */
export function attendanceRate(statuses: readonly AttendanceStatus[], settings: AttendanceRateSettings = DEFAULT_ATTENDANCE_RATE_SETTINGS): Rate {
  let counted = 0;
  for (const status of statuses) {
    if (status === "present") counted += 1;
    else if (status === "absent_justified" && settings.countJustifiedAsPresent) counted += 1;
    else if (status === "present_other_group" && settings.countOtherGroupAsPresent) counted += 1;
  }
  return { numerator: counted, denominator: statuses.length };
}

/** The rate as whole basis points (8500 = 85 %), rounded half up. Undefined when there is nothing to count. */
export function rateToBasisPoints(rate: Rate): number | undefined {
  if (rate.denominator === 0) return undefined;
  return mulDivRound(10_000, rate.numerator, rate.denominator);
}
