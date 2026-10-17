import { createBrowserRouter, Link, Navigate, Outlet, useLocation } from "react-router";
import { usePortal } from "./auth/session";
import { Shell } from "./components/shell";
import { Card, Empty, ErrorBanner, Loading } from "./components/ui";
import { useI18n } from "./i18n/i18n";
import { AccountPage, TeamPage } from "./pages/account";
import { ForgotPage, LoginPage, SignupPage, TokenPasswordPage } from "./pages/auth";
import { BookPage } from "./pages/book";
import { BookingDetailPage } from "./pages/bookingDetail";
import { BookingsPage } from "./pages/bookings";
import { DashboardPage } from "./pages/dashboard";
import { MailPage, PaymentsPage } from "./pages/money";
import { PacksPage, SubscriptionPage } from "./pages/subscription";

/** Waits for the portal information and the session; shows the closed page when the centre does not open the portal. */
function Gate() {
  const { info, loading, error } = usePortal();
  const { t } = useI18n();
  if (loading) return <Loading />;
  if (!info && error) return <ErrorBanner error={error} />;
  if (!info?.portalEnabled) {
    return (
      <Card>
        <Empty title={t.closed.title} text={t.closed.text} />
      </Card>
    );
  }
  return <Outlet />;
}

function RequireMember() {
  const { member } = usePortal();
  const location = useLocation();
  if (!member) return <Navigate to="/connexion" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

function GuestOnly() {
  const { member } = usePortal();
  if (member) return <Navigate to="/" replace />;
  return <Outlet />;
}

function RequireCompanyAdmin() {
  const { member } = usePortal();
  if (member?.company?.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet />;
}

function NotFound() {
  const { t } = useI18n();
  return (
    <Card>
      <Empty
        title={t.common.notFoundTitle}
        text={t.common.notFoundText}
        action={
          <Link to="/" className="btn">
            {t.common.home}
          </Link>
        }
      />
    </Card>
  );
}

export const router = createBrowserRouter(
  [
    {
      element: <Shell />,
      children: [
        {
          element: <Gate />,
          children: [
            {
              element: <GuestOnly />,
              children: [
                { path: "connexion", element: <LoginPage /> },
                { path: "inscription", element: <SignupPage /> },
                { path: "mot-de-passe-oublie", element: <ForgotPage /> },
              ],
            },
            { path: "activation", element: <TokenPasswordPage key="activate" purpose="activate" /> },
            { path: "mot-de-passe", element: <TokenPasswordPage key="reset" purpose="reset" /> },
            {
              element: <RequireMember />,
              children: [
                { index: true, element: <DashboardPage /> },
                { path: "reserver", element: <BookPage /> },
                { path: "reservations", element: <BookingsPage /> },
                { path: "reservations/:id", element: <BookingDetailPage /> },
                { path: "abonnement", element: <SubscriptionPage /> },
                { path: "packs", element: <PacksPage /> },
                { path: "courrier", element: <MailPage /> },
                { path: "paiements", element: <PaymentsPage /> },
                { path: "compte", element: <AccountPage /> },
                { element: <RequireCompanyAdmin />, children: [{ path: "equipe", element: <TeamPage /> }] },
              ],
            },
            { path: "*", element: <NotFound /> },
          ],
        },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, "") },
);
