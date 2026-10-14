import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/auth-context";
import { LoadingScreen } from "./components/LoadingScreen";
import { LoginPage } from "./pages/LoginPage";
import { getLoginPortal } from "./lib/api";

// Only the sign-in screen is in the entry bundle; every other page is fetched when its route is first opened.
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const PlatformAdminPage = lazy(() => import("./pages/PlatformAdminPage").then((m) => ({ default: m.PlatformAdminPage })));
const OrganizationManagementPage = lazy(() => import("./pages/OrganizationManagementPage").then((m) => ({ default: m.OrganizationManagementPage })));
const AccountPage = lazy(() => import("./pages/AccountPage").then((m) => ({ default: m.AccountPage })));
const RegisterPage = lazy(() => import("./pages/RegisterPage").then((m) => ({ default: m.RegisterPage })));
import { MfaRecoveryNotice } from "./components/MfaRecoveryNotice";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingScreen />;
  const portal = location.pathname.startsWith("/admin/") ? "admin"
    : location.pathname.startsWith("/workspace/organizations/") ? "provider"
      : getLoginPortal() ?? "customer";
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  return user ? <>{children}<MfaRecoveryNotice /></> : <Navigate to={`/login/${portal}?returnTo=${encodeURIComponent(returnTo)}`} replace />;
}

export function App() {
  return (
    <Suspense fallback={<LoadingScreen />}>
    <Routes>
      <Route path="/login" element={<Navigate to="/login/customer" replace />} />
      <Route path="/login/customer" element={<LoginPage portal="customer" />} />
      <Route path="/login/provider" element={<LoginPage portal="provider" />} />
      <Route path="/login/admin" element={<LoginPage portal="admin" />} />
      <Route path="/register/:kind" element={<RegisterPage />} />
      <Route path="/admin/login" element={<Navigate to="/login/admin" replace />} />
      <Route path="/admin" element={<Navigate to="/admin/accounts-permissions" replace />} />
      <Route path="/admin/accounts&permission" element={<Navigate to="/admin/accounts-permissions" replace />} />
      <Route
        path="/admin/:section"
        element={
          <ProtectedRoute>
            <PlatformAdminPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/workspace/:view"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/workspace/organizations/:organizationId/:section"
        element={<ProtectedRoute><OrganizationManagementPage /></ProtectedRoute>}
      />
      <Route path="/account" element={<Navigate to="/account/profile" replace />} />
      <Route path="/account/:section" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
      <Route path="/" element={<Navigate to="/workspace/overview" replace />} />
      <Route path="*" element={<Navigate to="/workspace/overview" replace />} />
    </Routes>
    </Suspense>
  );
}
