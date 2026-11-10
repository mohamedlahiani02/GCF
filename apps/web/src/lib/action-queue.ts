import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import type { MemberRow, Page, RequestRow } from "../pages/coworking/api";
import { siteKeys, type LeadList } from "../pages/site/api";
import type { Dashboard } from "./dashboard";
import { frDate, tnd } from "./format";

export interface ActionNotice {
  id: string;
  priority: "urgent" | "attention" | "info";
  title: string;
  text: string;
  count: number;
  to: string;
  action: string;
  more?: boolean;
}
const countLabel = (count: number, one: string, many: string) => (count === 1 ? one : many);
export const PRIORITY = { urgent: "Urgent", attention: "À traiter", info: "À suivre" };

/** Live work to do, shared by the bell and dashboard; no acknowledgement can hide an unresolved task. */
export function useActionQueue() {
  const { session, can } = useSession();
  const cwWrite = !!session && can("coworking:write");
  const canDashboard = !!session && (can("dashboard:operational") || can("dashboard:financial"));
  const dashboard = useQuery({
    queryKey: ["dashboard", "day"],
    queryFn: () => api.get<Dashboard>("/dashboard", { granularity: "day" }),
    enabled: canDashboard,
    refetchInterval: 60_000,
  });
  const members = useQuery({
    queryKey: ["cw-members", "pending-summary"],
    queryFn: () => api.get<Page<MemberRow>>("/coworking/members", { status: "pending", pageSize: 1 }),
    enabled: cwWrite,
    refetchInterval: 30_000,
  });
  const requests = useQuery({
    queryKey: ["cw-requests"],
    queryFn: () => api.get<{ items: RequestRow[] }>("/coworking/requests"),
    enabled: cwWrite,
    refetchInterval: 30_000,
  });
  const proposals = useQuery({
    queryKey: ["proposals-count"],
    queryFn: () => api.get<{ pending: number }>("/automations/proposals/count"),
    enabled: !!session && (can("reminders:send") || can("payroll:calculate")),
    refetchInterval: 60_000,
  });
  const leads = useQuery({
    queryKey: [...siteKeys.leads, "notification-summary"],
    queryFn: () => api.get<LeadList>("/site/leads", { status: "new", pageSize: 100 }),
    enabled: !!session && can("website:leads"),
    refetchInterval: 60_000,
  });
  const items: ActionNotice[] = [];
  const memberCount = cwWrite ? (members.data?.total ?? 0) : 0;
  if (memberCount)
    items.push({
      id: "signups",
      priority: "attention",
      count: memberCount,
      title: countLabel(memberCount, "Inscription à valider", "Inscriptions à valider"),
      text: "Ces clients attendent votre accord pour accéder à leur compte.",
      to: "/coworking/demandes?type=comptes",
      action: "Valider les inscriptions",
    });
  const bookingRows = cwWrite ? (requests.data?.items ?? []) : [];
  const expiring = bookingRows.filter((r) => new Date(r.expiresAt).getTime() - Date.now() < 60 * 60_000);
  if (expiring.length)
    items.push({
      id: "expiring",
      priority: "urgent",
      count: expiring.length,
      title: countLabel(expiring.length, "Réservation à confirmer rapidement", "Réservations à confirmer rapidement"),
      text: "Ces demandes expirent dans moins d’une heure.",
      to: "/coworking/demandes?type=reservations",
      action: "Répondre aux demandes",
    });
  const remaining = bookingRows.length - expiring.length;
  if (remaining)
    items.push({
      id: "bookings",
      priority: "attention",
      count: remaining,
      title: countLabel(remaining, "Demande de réservation", "Demandes de réservation"),
      text: "Un client attend votre réponse pour réserver sa place.",
      to: "/coworking/demandes?type=reservations",
      action: "Voir les réservations",
    });
  const o = canDashboard ? dashboard.data?.operational : undefined;
  const f = canDashboard ? dashboard.data?.financial : undefined;
  if (o?.todo.sessionsWithoutSheet.length && can("attendance:read"))
    items.push({
      id: "attendance",
      priority: "attention",
      count: o.todo.sessionsWithoutSheet.length,
      title: countLabel(o.todo.sessionsWithoutSheet.length, "Feuille de présence non validée", "Feuilles de présence non validées"),
      text: "Les séances ont eu lieu ; leur suivi reste à terminer.",
      to: `/presences/${o.todo.sessionsWithoutSheet[0]!.id}`,
      action: "Ouvrir les présences",
    });
  if (can("payments:read")) {
    if (o?.todo.overdueInstallments.count)
      items.push({
        id: "overdue",
        priority: "urgent",
        count: o.todo.overdueInstallments.count,
        title: countLabel(o.todo.overdueInstallments.count, "Échéance en retard", "Échéances en retard"),
        text: `${tnd(o.todo.overdueInstallments.total)} TND restent à encaisser.`,
        to: "/encaissements",
        action: "Voir les impayés",
      });
    else if (!o && f?.unpaidPayers)
      items.push({
        id: "overdue",
        priority: "urgent",
        count: f.unpaidPayers,
        title: countLabel(f.unpaidPayers, "Payeur en retard", "Payeurs en retard"),
        text: `${tnd(f.unpaidTotal)} TND restent à encaisser.`,
        to: "/encaissements",
        action: "Voir les impayés",
      });
  }
  if (o?.todo.unclosedCashDays.length && can("cash:read"))
    items.push({
      id: "cash",
      priority: "attention",
      count: o.todo.unclosedCashDays.length,
      title: countLabel(o.todo.unclosedCashDays.length, "Journée de caisse non clôturée", "Journées de caisse non clôturées"),
      text: `Première journée : ${frDate(o.todo.unclosedCashDays[0]!)}`,
      to: `/caisse?date=${o.todo.unclosedCashDays[0]}`,
      action: "Consulter la caisse",
    });
  if (f?.payroll.toPay && can("payroll:read"))
    items.push({
      id: "payroll",
      priority: "attention",
      count: 1,
      title: "Paie validée à régler",
      text: `${tnd(f.payroll.toPay)} TND restent à régler aux profs / formateurs.`,
      to: "/paie",
      action: "Ouvrir la paie",
    });
  const proposalCount = can("reminders:send") || can("payroll:calculate") ? (proposals.data?.pending ?? 0) : 0;
  if (proposalCount)
    items.push({
      id: "proposals",
      priority: "attention",
      count: proposalCount,
      title: countLabel(proposalCount, "Proposition à confirmer", "Propositions à confirmer"),
      text: "Les automatisations ont préparé des actions pour votre validation.",
      to: "/propositions",
      action: "Examiner les propositions",
    });
  const leadCount = can("website:leads") ? (leads.data?.items.length ?? 0) : 0;
  if (leadCount)
    items.push({
      id: "leads",
      priority: "info",
      count: leadCount,
      more: leads.data?.hasMore ?? false,
      title: countLabel(leadCount, "Nouveau message du site", "Nouveaux messages du site"),
      text: "Contacts, demandes de visite et de devis à suivre.",
      to: "/site/demandes",
      action: "Ouvrir les messages",
    });
  const rank = { urgent: 0, attention: 1, info: 2 };
  items.sort((a, b) => rank[a.priority] - rank[b.priority]);
  const queries = [dashboard, members, requests, proposals, leads].filter((q) => q.isEnabled);
  return {
    items,
    total: items.reduce((sum, i) => sum + i.count, 0),
    more: items.some((i) => i.more),
    memberCount,
    requestCount: bookingRows.length,
    proposalCount,
    leadCount,
    busy: queries.some((q) => q.isPending),
    error: queries.find((q) => q.error)?.error,
    dashboard,
    refresh: () => Promise.all(queries.map((q) => q.refetch())),
  };
}
