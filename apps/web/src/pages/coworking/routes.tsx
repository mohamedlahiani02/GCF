import type { RouteObject } from "react-router";
import { RequirePermission } from "../../components/shell";
import { BookingPage } from "./booking";
import { CheckInPage } from "./checkin";
import { LivePlanPage } from "./live";
import { MailPage } from "./mail";
import { MemberPage } from "./member";
import { MembersPage } from "./members";
import { CoworkingPlanningPage } from "./planning";
import { RequestsPage } from "./requests";
import { StatsPage } from "./stats";
import { SubscriptionsPage } from "./subscriptions";

const guard = (permission: string, element: React.ReactNode) => <RequirePermission permission={permission}>{element}</RequirePermission>;

/** Coworking operations: live plan, requests, planning, members, subscriptions, mail and statistics. */
export const coworkingRoutes: RouteObject[] = [
  { path: "/coworking", element: guard("coworking:read", <LivePlanPage />) },
  { path: "/coworking/demandes", element: guard("coworking:write", <RequestsPage />) },
  { path: "/coworking/planning", element: guard("coworking:read", <CoworkingPlanningPage />) },
  { path: "/coworking/reservations/:id", element: guard("coworking:read", <BookingPage />) },
  { path: "/coworking/arrivee/:code", element: guard("coworking:write", <CheckInPage />) },
  { path: "/coworking/membres", element: guard("coworking:read", <MembersPage />) },
  { path: "/coworking/membres/:id", element: guard("coworking:read", <MemberPage />) },
  { path: "/coworking/abonnements", element: guard("coworking:read", <SubscriptionsPage />) },
  { path: "/coworking/courrier", element: guard("coworking:read", <MailPage />) },
  { path: "/coworking/statistiques", element: guard("coworking:reports", <StatsPage />) },
];
