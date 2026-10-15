import { createBrowserRouter, Link } from "react-router";
import { RequirePermission, Shell } from "./components/shell";
import { LoginPage } from "./pages/login";
import { EnrolmentWizardPage } from "./pages/enrolment";
import { PaymentsPage } from "./pages/payments";
import { ReceiptPage, ReceiptsPage } from "./pages/receipts";
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
      { path: "/eleves", element: guard("students:read", <StudentsPage />) },
      { path: "/eleves/:id", element: guard("students:read", <StudentPage />) },
      { path: "/inscriptions/nouvelle", element: guard("enrolments:write", <EnrolmentWizardPage />) },
      { path: "/encaissements", element: guard("payments:read", <PaymentsPage />) },
      { path: "/recus", element: guard("payments:read", <ReceiptsPage />) },
      { path: "/recus/:id", element: guard("payments:read", <ReceiptPage />) },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
