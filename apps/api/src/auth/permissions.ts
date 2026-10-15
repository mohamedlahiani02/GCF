import type { Role } from "../db/types.js";

/**
 * Permissions follow the role matrix of the specification (section 7). Areas that a role cannot use are
 * absent from its set, so the web client hides them rather than disabling them.
 */
export const PERMISSIONS = [
  "centre:read",
  "centre:manage",
  "users:manage",
  "audit:read",
  "students:read",
  "students:write",
  "catalogue:read",
  "catalogue:write",
  "groups:write",
  "instructors:read",
  "instructors:write",
  "rooms:write",
  "enrolments:write",
  "discounts:approve",
  "attendance:read",
  "attendance:write",
  "attendance:correct",
  "payments:read",
  "payments:write",
  "payments:cancel",
  "postponements:approve",
  "reminders:send",
  "payroll:read",
  "payroll:rules",
  "payroll:calculate",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(PERMISSIONS),
  secretariat: new Set<Permission>([
    "centre:read",
    "students:read",
    "students:write",
    "catalogue:read",
    "groups:write",
    "instructors:read",
    "rooms:write",
    "enrolments:write",
    "attendance:read",
    "attendance:write",
    "payments:read",
    "payments:write",
    "reminders:send",
  ]),
  accountant: new Set<Permission>(["centre:read", "audit:read", "students:read", "catalogue:read", "instructors:read", "attendance:read", "payments:read", "payroll:read", "payroll:calculate"]),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].has(p));
}
