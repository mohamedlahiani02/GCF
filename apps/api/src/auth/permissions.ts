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
  ]),
  accountant: new Set<Permission>(["centre:read", "audit:read", "students:read", "catalogue:read", "instructors:read"]),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].has(p));
}
