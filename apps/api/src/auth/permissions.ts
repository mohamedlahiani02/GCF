import type { Module, Role } from "../db/types.js";

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
  "cash:read",
  "cash:close",
  "reports:operational",
  "reports:financial",
  "dashboard:operational",
  "dashboard:financial",
  "coworking:read",
  "coworking:write",
  "coworking:manage",
  "coworking:reports",
  "website:edit",
  "website:publish",
  "website:leads",
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
    "cash:read",
    "reports:operational",
    "dashboard:operational",
    "coworking:read",
    "coworking:write",
    "website:leads",
  ]),
  accountant: new Set<Permission>([
    "centre:read",
    "audit:read",
    "students:read",
    "catalogue:read",
    "instructors:read",
    "attendance:read",
    "payments:read",
    "payroll:read",
    "payroll:calculate",
    "cash:read",
    "cash:close",
    "reports:financial",
    "dashboard:financial",
    "coworking:read",
    "coworking:reports",
  ]),
  editor: new Set<Permission>(["centre:read", "website:edit", "website:publish", "website:leads"]),
};

/** Permissions that only exist when their module is enabled; the others belong to the core. */
const PERMISSION_MODULE: Partial<Record<Permission, Module>> = {
  "students:read": "training",
  "students:write": "training",
  "catalogue:read": "training",
  "catalogue:write": "training",
  "groups:write": "training",
  "instructors:read": "training",
  "instructors:write": "training",
  "rooms:write": "training",
  "enrolments:write": "training",
  "discounts:approve": "training",
  "attendance:read": "training",
  "attendance:write": "training",
  "attendance:correct": "training",
  "postponements:approve": "training",
  "reminders:send": "training",
  "payroll:read": "training",
  "payroll:rules": "training",
  "payroll:calculate": "training",
  "coworking:read": "coworking",
  "coworking:write": "coworking",
  "coworking:manage": "coworking",
  "coworking:reports": "coworking",
  "website:edit": "website",
  "website:publish": "website",
  "website:leads": "website",
};

/** Who is asking: a role, within a centre that runs some modules. */
export interface Actor {
  role: Role;
  modules: readonly Module[];
}

export function moduleOf(permission: Permission): Module | undefined {
  return PERMISSION_MODULE[permission];
}

export function can(actor: Actor, permission: Permission): boolean {
  const module = PERMISSION_MODULE[permission];
  return ROLE_PERMISSIONS[actor.role].has(permission) && (module === undefined || actor.modules.includes(module));
}

export function permissionsOf(actor: Actor): Permission[] {
  return PERMISSIONS.filter((p) => can(actor, p));
}
