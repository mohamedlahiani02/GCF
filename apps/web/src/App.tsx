import { createBrowserRouter, Link, Navigate } from "react-router";
import { useSession } from "./auth/session";
import { RequirePermission, Shell } from "./components/shell";
import { AdminPage } from "./pages/admin";
import { AttendanceDayPage, AttendanceSheetPage } from "./pages/attendance";
import { CashPage } from "./pages/cash";
import { StudiesPage, TrainingPage, TrainingsPage } from "./pages/catalogue";
import { DashboardPage } from "./pages/dashboard";
import { EnrolmentWizardPage } from "./pages/enrolment";
import { GroupCreatePage, GroupPage, GroupsPage } from "./pages/groups";
import { InstructorPage, InstructorsPage } from "./pages/instructors";
import { LoginPage } from "./pages/login";
import { PaymentsPage } from "./pages/payments";
import { InstructorPayPage, PayrollPage } from "./pages/payroll";
import { PlanningPage } from "./pages/planning";
import { coworkingRoutes } from "./pages/coworking/routes";
import { coworkingSettingsRoutes } from "./pages/coworking-settings/routes";
import { ReceiptPage, ReceiptsPage } from "./pages/receipts";
import { ReportsPage } from "./pages/reports";
import { RentalPage, RentalWizardPage, RoomsPage } from "./pages/rooms";
import { siteRoutes } from "./pages/site/routes";
import { StudentPage } from "./pages/student";
import { StudentsPage } from "./pages/students";

const guard = (permission: string, element: React.ReactNode) => <RequirePermission permission={permission}>{element}</RequirePermission>;

function NotFound() {
  return (
    <div className="card">
      <div className="empty">
        <strong style={{ color: "var(--ink)" }}>Page introuvable</strong>
        <Link to="/" className="btn">
          Retour au tableau de bord
        </Link>
      </div>
    </div>
  );
}

/** The training dashboard when that module runs, otherwise the first area the role can open. */
function Home() {
  const { can } = useSession();
  if (can("students:read")) return <DashboardPage />;
  const first = (
    [
      ["coworking:read", "/coworking"],
      ["website:edit", "/site"],
      ["website:leads", "/site/demandes"],
      ["payments:read", "/encaissements"],
      ["cash:read", "/caisse"],
    ] as const
  ).find(([permission]) => can(permission));
  return first ? <Navigate to={first[1]} replace /> : <NotFound />;
}

export const router = createBrowserRouter([
  { path: "/connexion", element: <LoginPage /> },
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/eleves", element: guard("students:read", <StudentsPage />) },
      { path: "/eleves/:id", element: guard("students:read", <StudentPage />) },
      { path: "/inscriptions/nouvelle", element: guard("enrolments:write", <EnrolmentWizardPage />) },
      { path: "/intervenants", element: guard("instructors:read", <InstructorsPage />) },
      { path: "/intervenants/:id", element: guard("instructors:read", <InstructorPage />) },
      { path: "/cours-particuliers", element: guard("catalogue:read", <StudiesPage />) },
      { path: "/formations", element: guard("catalogue:read", <TrainingsPage />) },
      { path: "/formations/:id", element: guard("catalogue:read", <TrainingPage />) },
      { path: "/groupes", element: guard("catalogue:read", <GroupsPage />) },
      { path: "/groupes/nouveau", element: guard("groups:write", <GroupCreatePage />) },
      { path: "/groupes/:id", element: guard("catalogue:read", <GroupPage />) },
      { path: "/presences", element: guard("attendance:read", <AttendanceDayPage />) },
      { path: "/presences/:sessionId", element: guard("attendance:read", <AttendanceSheetPage />) },
      { path: "/encaissements", element: guard("payments:read", <PaymentsPage />) },
      { path: "/recus", element: guard("payments:read", <ReceiptsPage />) },
      { path: "/recus/:id", element: guard("payments:read", <ReceiptPage />) },
      { path: "/paie", element: guard("payroll:read", <PayrollPage />) },
      { path: "/paie/intervenants/:id", element: guard("payroll:read", <InstructorPayPage />) },
      { path: "/salles", element: guard("catalogue:read", <RoomsPage />) },
      { path: "/locations/nouvelle", element: guard("rooms:write", <RentalWizardPage />) },
      { path: "/locations/:id", element: guard("catalogue:read", <RentalPage />) },
      { path: "/planning", element: guard("catalogue:read", <PlanningPage />) },
      { path: "/caisse", element: guard("cash:read", <CashPage />) },
      { path: "/rapports", element: <ReportsPage /> },
      { path: "/administration", element: guard("centre:read", <AdminPage />) },
      ...coworkingRoutes,
      ...coworkingSettingsRoutes,
      ...siteRoutes,
      { path: "*", element: <NotFound /> },
    ],
  },
]);
