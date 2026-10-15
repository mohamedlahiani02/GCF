import { createBrowserRouter, Link } from "react-router";
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
import { PayPeriodPage, PayrollPage } from "./pages/payroll";
import { PlanningPage } from "./pages/planning";
import { ReceiptPage, ReceiptsPage } from "./pages/receipts";
import { ReportsPage } from "./pages/reports";
import { RentalPage, RentalWizardPage, RoomsPage } from "./pages/rooms";
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

export const router = createBrowserRouter([
  { path: "/connexion", element: <LoginPage /> },
  {
    element: <Shell />,
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/eleves", element: guard("students:read", <StudentsPage />) },
      { path: "/eleves/:id", element: guard("students:read", <StudentPage />) },
      { path: "/inscriptions/nouvelle", element: guard("enrolments:write", <EnrolmentWizardPage />) },
      { path: "/intervenants", element: guard("instructors:read", <InstructorsPage />) },
      { path: "/intervenants/:id", element: guard("instructors:read", <InstructorPage />) },
      { path: "/etudes", element: guard("catalogue:read", <StudiesPage />) },
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
      { path: "/paie/:id", element: guard("payroll:read", <PayPeriodPage />) },
      { path: "/salles", element: guard("catalogue:read", <RoomsPage />) },
      { path: "/locations/nouvelle", element: guard("rooms:write", <RentalWizardPage />) },
      { path: "/locations/:id", element: guard("catalogue:read", <RentalPage />) },
      { path: "/planning", element: guard("catalogue:read", <PlanningPage />) },
      { path: "/caisse", element: guard("cash:read", <CashPage />) },
      { path: "/rapports", element: <ReportsPage /> },
      { path: "/administration", element: guard("centre:read", <AdminPage />) },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
