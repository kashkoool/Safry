import { useText } from "../i18n/useText";
import { currentLocale } from "../i18n/locale";
import { useLocalizedData } from "../i18n/useLocalizedData";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import {
  Activity,
  Building2,
  FileClock,
  KeyRound,
  LayoutDashboard,
  LogOut,
  UserRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound
} from "lucide-react";
import { useAuth } from "../auth/auth-context";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../i18n/LanguageSwitch";
import { useLanguage } from "../i18n/useLanguage";
import { Modal } from "../components/BusinessForms";
import { StepUpFields } from "../components/StepUpFields";
import { stepUpError, stepUpOf, type Creds } from "../components/step-up";
import {
  platform,
  type AdminMembership,
  type AdminPage,
  type AdminRecord,
  type AdminReferences,
} from "../lib/platform";
import { CreateTenantDialog, TenantActivityDialog, TenantStatusDialog, UnlockLoginDialog, AccountActionDialog } from "../components/platform/TenantTools";
import type { PlatformTenant } from "../lib/platform";
import { CURRENCY_EXPONENTS, formatMinorUnits } from "../lib/minor-units";
import "./platform-admin.css";

const sections = [
  ["accounts-permissions", "users", "الحسابات والصلاحيات"],
  ["providers", "providers", "الشركات ومقدمو الخدمات"],
  ["services", "services", "جميع الخدمات"],
  ["allreservations", "bookings", "جميع الحجوزات"],
  ["tenants", "tenants", "جهات المنصة"],
  ["audit", "audit", "سجل العمليات"],
  ["sessions", "sessions", "جلسات الدخول"]
] as const;
const states: Record<string, string> = {
  ACTIVE: "نشط",
  SUSPENDED: "موقوف",
  DISABLED: "مغلق",
  REVOKED: "ملغاة",
  INVITED: "دعوة",
  PENDING: "بانتظار التأكيد",
  CONFIRMED: "مؤكد",
  CANCELLED: "ملغي",
  INACTIVE: "غير نشط",
  DRAFT: "مسودة",
  ARCHIVED: "مؤرشف"
};
const permissionLabels: Record<string, string> = {
  "organization.staff.manage": "إدارة موظفي الشركة",
  "tenant.read": "عرض مساحة العمل",
  "tenant.update": "تعديل الجهة",
  "identity.user.read": "عرض مستخدمي الجهة",
  "identity.user.manage": "إدارة مستخدمي الجهة والمنشآت",
  "identity.role.manage": "إدارة الأدوار",
  "audit.read": "قراءة التدقيق",
  "catalog.service.read": "تصفح الخدمات",
  "catalog.service.manage": "إدارة الخدمات",
  "booking.read": "عرض الحجوزات",
  "booking.create": "إنشاء وتعديل حجز المسافر",
  "booking.manage": "إدارة حالات الحجوزات",
  "platform.tenant.create": "إنشاء جهة (واجهة غير منفذة)"
};
const reservedPermissions = new Set(["platform.tenant.create", "tenant.update", "identity.role.manage", "audit.read"]);
const time = (value?: string) =>
  value ? new Date(value).toLocaleString(currentLocale(), { calendar: "gregory" }) : "—";
const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : "تعذر تنفيذ العملية");

export function PlatformAdminPage() {
  const tr = useText();
  const { pick } = useLanguage();
  const { user, logout } = useAuth();
  const { section: sectionSlug } = useParams();
  const section = sections.find(([slug]) => slug === sectionSlug)?.[1];
  const [tenantId, setTenantId] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rawRefs, setRefs] = useState<AdminReferences | null>(null);
  const refs = useLocalizedData(rawRefs);
  const [counts, setCounts] = useState<Record<string, number | string>>({});
  const [rawResult, setResult] = useState<AdminPage>({ items: [], total: 0, page: 1, pageSize: 30 });
  const result = useLocalizedData(rawResult);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [message, setMessage] = useState("");
  const [tick, setTick] = useState(0);
  const [auto, setAuto] = useState(false);
  const [updated, setUpdated] = useState("");
  const [editor, setEditor] = useState<AdminRecord | "new" | null>(null);
  const [access, setAccess] = useState<AdminRecord | null>(null);
  const [detail, setDetail] = useState<AdminRecord | null>(null);
  const [creatingTenant, setCreatingTenant] = useState(false);
  const [statusFor, setStatusFor] = useState<(AdminRecord & PlatformTenant) | null>(null);
  const [activityFor, setActivityFor] = useState<(AdminRecord & PlatformTenant) | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [accountAction, setAccountAction] = useState<{ kind: "unlock" | "resend"; email: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ account: AdminRecord; action: string } | null>(null);
  useEffect(() => {
    if (!user?.isPlatformAdmin || !section) return;
    let live = true;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all([
      platform.records(section, page, tenantId, search, controller.signal),
      platform.overview(),
      platform.references()
    ])
      .then(([data, summary, references]) => {
        if (!live) return;
        setResult(data);
        setCounts(summary);
        setRefs(references);
        setError("");
        setUpdated(new Date().toISOString());
      })
      .catch((reason) => {
        if (!live || (reason instanceof DOMException && reason.name === "AbortError")) return;
        if (reason instanceof ApiError && reason.status === 403 && reason.code === "mfa_enrollment_required") setMfaRequired(true);
        else setError(errorText(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort(); // a superseded page/search request is cancelled, not just ignored
    };
  }, [section, page, tenantId, search, tick, user?.isPlatformAdmin]);
  useEffect(() => {
    if (!auto) return;
    const interval = window.setInterval(() => setTick((t) => t + 1), 30000);
    return () => window.clearInterval(interval);
  }, [auto]);
  if (!user?.isPlatformAdmin) return <Navigate to="/workspace/overview" replace />;
  if (!section) return <Navigate to="/admin/accounts-permissions" replace />;
  if (mfaRequired)
    return (
      <main className="platform-admin">
        <section className="work-panel" role="alert" aria-labelledby="mfa-required-title">
          <h1 id="mfa-required-title">{pick("فعّل المصادقة الثنائية للمتابعة", "Turn on two-factor sign-in to continue")}</h1>
          <p>{pick("حسابات مدير النظام تتطلب المصادقة الثنائية. فعّلها من إعدادات حسابك ثم عد إلى هذه الصفحة.", "Platform administrator accounts require two-factor sign-in. Turn it on in your account settings, then come back to this page.")}</p>
          <p>
            <Link className="primary-button" to="/account/security">{pick("تفعيل المصادقة الثنائية", "Set up two-factor sign-in")}</Link>
          </p>
        </section>
      </main>
    );
  function saved() {
    setTick((t) => t + 1);
    setMessage("تم الحفظ وتسجيل العملية في سجل التدقيق");
  }
  function choose() {
    setPage(1);
    setQuery("");
    setSearch("");
  }
  return (
    <main className="platform-admin">
      <header className="admin-header">
        <Brand compact />
        <div className="admin-header-copy">
          <span className="eyebrow eyebrow--dark">
            <ShieldCheck size={15} /> {pick("مدير النظام", "Platform admin")}
          </span>
          <h1>{pick("مركز إدارة المنصة", "Platform management center")}</h1>
          <p>{pick("رؤية شاملة عبر جميع الجهات · حسابات، صلاحيات، حجوزات ونشاط", "A platform-wide view of accounts, permissions, bookings, and activity")}</p>
        </div>
        <div className="admin-header-actions">
          <LanguageSwitch />
          <Link className="ghost-button" to="/workspace/overview">
            <LayoutDashboard size={17} /> {pick("إدارة الجهة الحالية", "Current workspace")}
          </Link>
          <Link className="ghost-button" to="/account/profile">
            <UserRound size={17} /> {pick("حسابي", "My account")}
          </Link>
          <button
            className="ghost-button"
            onClick={() => void logout().catch(() => window.location.reload())}
          >
            <LogOut size={17} /> {pick("خروج", "Sign out")}
          </button>
        </div>
      </header>
      <div className="admin-stats">
        {[
          ["users", "إجمالي الحسابات", UsersRound],
          ["activeUsers", "حسابات نشطة", ShieldCheck],
          ["providers", "المنشآت", Building2],
          ["bookings", "الحجوزات", FileClock],
          ["pending", "طلبات معلقة", Activity]
        ].map(([key, label, Icon]) => {
          const StatIcon = Icon as typeof UsersRound;
          return (
            <article key={String(key)}>
              <StatIcon size={22} />
          <span>{tr(pick(String(label), ({ users: "Total accounts", activeUsers: "Active accounts", providers: "Companies", bookings: "Bookings", pending: "Pending requests" } as Record<string, string>)[String(key)] ?? String(label)))}</span>
              <strong>{tr(counts[String(key)] ?? "—")}</strong>
            </article>
          );
        })}
      </div>
      <nav className="admin-tabs" aria-label={pick("أقسام إدارة النظام", "Admin sections")}>
        {sections.map(([slug, key, label]) => (
          <Link key={slug} to={`/admin/${slug}`} className={section === key ? "active" : ""}
            aria-current={section === key ? "page" : undefined} onClick={choose}>
            {tr(pick(label, ({ "accounts-permissions": "Accounts and permissions", providers: "Companies and providers", services: "All services", allreservations: "All bookings", tenants: "Workspaces", audit: "Audit log", sessions: "Login sessions" } as Record<string, string>)[slug] ?? label))}
          </Link>
        ))}
      </nav>
      <section className="work-panel admin-panel" aria-busy={loading}>
        <div className="admin-section-heading">
          <div>
            <span className="admin-section-kicker">{pick("مركز التحكم", "CONTROL CENTER")}</span>
            <h2>{tr(sections.find(([, key]) => key === section)?.[2] ?? "")}</h2>
          </div>
          <span className="admin-record-count">{pick("السجلات", "Records")} <strong>{result.total.toLocaleString(currentLocale())}</strong></span>
        </div>
        <div className="admin-toolbar">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query);
              setPage(1);
            }}
          >
            <Search size={18} />
            <input
              aria-label={pick("بحث في سجلات المنصة", "Search platform records")}
              placeholder={pick("اسم، بريد، خدمة أو عملية…", "Name, email, service, or action…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={200}
            />
            <button className="ghost-button">{pick("بحث", "Search")}</button>
          </form>
          <select
            aria-label={pick("الجهة", "Workspace")}
            value={tenantId}
            onChange={(e) => {
              setTenantId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{pick("جميع الجهات", "All workspaces")}</option>
            {refs?.tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {tr(t.name)}{tr(" · ")}{tr(t.code)}
              </option>
            ))}
          </select>
          <button className="ghost-button" disabled={loading} onClick={() => setTick((t) => t + 1)}>
            <RefreshCw size={16} /> {pick("تحديث", "Refresh")}
          </button>
          {section === "users" && (
            <button className="secondary-button" onClick={() => setEditor("new")} disabled={!refs}>
              <Plus size={16} /> {pick("حساب جديد", "New account")}
            </button>
          )}
          {section === "users" && (
            <button className="ghost-button" onClick={() => setUnlocking(true)}>
              <KeyRound size={16} /> {pick("رفع حظر الدخول", "Unlock sign-in")}
            </button>
          )}
          {section === "tenants" && (
            <button className="secondary-button" onClick={() => setCreatingTenant(true)}>
              <Plus size={16} /> {pick("مساحة عمل جديدة", "New workspace")}
            </button>
          )}
        </div>
        <div className="admin-live">
          <label>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {pick("تحديث تلقائي كل 30 ثانية", "Auto-refresh every 30 seconds")}
          </label>
          <small>
            {pick("آخر تحديث:", "Last updated:")} {tr(time(updated))}{tr(" · ")}{pick("السجلات", "Records")}: {result.total.toLocaleString(currentLocale())}
          </small>
        </div>
        <p className="form-hint">
          {pick("تعرض اللوحة البيانات المحفوظة فعلياً فقط. كلمات المرور ورموز الدخول لا تُعرض. حذف الحساب منطقي مع الاحتفاظ بالسجلات المرتبطة.", "The dashboard shows stored records only. Passwords and tokens are never displayed. Account deletion is soft and retains related records.")}
        </p>
        {tr(error && (
          <p className="form-error" role="alert">
            {tr(error)}
          </p>
        ))}
        {tr(message && (
          <p className="workspace-alert" role="status">
            {tr(message)}
            <button onClick={() => setMessage("")}>{pick("إغلاق", "Close")}</button>
          </p>
        ))}
        {loading ? (
          <p role="status">{pick("جاري تحميل البيانات…", "Loading data…")}</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{tr(section === "audit" ? pick("العملية والمنفذ", "Action and actor") : pick("الاسم / السجل", "Name / record"))}</th>
                  <th>{pick("الجهة / الارتباط", "Workspace / association")}</th>
                  <th>{pick("الحالة / التاريخ", "Status / date")}</th>
                  <th>{pick("الإجراءات", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <td data-label={pick("الاسم / السجل", "Name / record")}>
                      <strong>
                        {tr(item.displayName ??
                          item.title ??
                          item.name ??
                          item.service?.title ??
                          item.action ??
                          item.user?.displayName ??
                          item.id)}
                      </strong>
                      <small>
                        {tr(item.email ??
                          item.actor?.email ??
                          item.user?.email ??
                          item.organization?.name ??
                          item.code ??
                          item.category)}
                      </small>
                      {item.isPlatformAdmin && <span className="role-pill">{pick("مدير النظام", "Platform admin")}</span>}
                    </td>
                    <td data-label={pick("الجهة / الارتباط", "Workspace / association")}>
                      {tr(item.tenant?.name ??
                        item.memberships
                          ?.map((m) => `${tr(m.tenant.name)} (${m.roles.map((r) => tr(r.role.name)).join(", ")})`)
                          .join(" · ") ??
                        pick("على مستوى المنصة", "Platform-wide"))}
                    </td>
                    <td data-label={pick("الحالة / التاريخ", "Status / date")}>
                      <span
                        className={`admin-state ${item.deletedAt || ["SUSPENDED", "DISABLED", "REVOKED", "CANCELLED", "INACTIVE", "ARCHIVED"].includes(item.status ?? "") ? "warning" : ""}`}
                      >
                        {tr(item.deletedAt
                          ? "محذوف منطقياً"
                          : item.status
                            ? (states[item.status] ?? item.status)
                            : section === "sessions"
                              ? item.revokedAt
                                ? "منتهية / ملغاة"
                                : item.expiresAt && new Date(item.expiresAt) < new Date()
                                  ? "منتهية"
                                  : "نشطة"
                              : "مسجلة")}
                      </span>
                      {section === "users" && item.lockedUntil && new Date(item.lockedUntil) > new Date() && (
                        <span className="admin-state warning">{pick("محظور حتى", "Locked until")} {tr(time(item.lockedUntil))}</span>
                      )}
                      {section === "users" && item.email && item.emailVerifiedAt === null && (
                        <span className="admin-state warning">{pick("البريد غير مؤكَّد", "Email not verified")}</span>
                      )}
                      <small>{tr(time(item.occurredAt ?? item.createdAt))}</small>
                    </td>
                    <td data-label={pick("الإجراءات", "Actions")}>
                      <div className="admin-actions">
                        <button onClick={() => setDetail(item)}>{pick("التفاصيل", "Details")}</button>
                        {section === "tenants" && (
                          <>
                            <button onClick={() => setActivityFor(item as AdminRecord & PlatformTenant)}>{pick("النشاط", "Activity")}</button>
                            <button onClick={() => setStatusFor(item as AdminRecord & PlatformTenant)}>{pick("تغيير الحالة", "Change status")}</button>
                          </>
                        )}
                        {section === "users" && (
                          <>
                            <button disabled={Boolean(item.deletedAt)} onClick={() => setEditor(item)}>
                              {pick("تعديل", "Edit")}
                            </button>
                            {item.email && item.lockedUntil && new Date(item.lockedUntil) > new Date() && (
                              <button onClick={() => setAccountAction({ kind: "unlock", email: item.email! })}>{pick("رفع الحظر", "Unlock sign-in")}</button>
                            )}
                            {item.email && item.emailVerifiedAt === null && !item.deletedAt && (
                              <button onClick={() => setAccountAction({ kind: "resend", email: item.email! })}>{pick("إعادة إرسال رسالة التأكيد", "Resend verification email")}</button>
                            )}
                            {item.id !== user.userId && <details className="admin-action-menu" onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.currentTarget.open = false;
                                event.currentTarget.querySelector("summary")?.focus();
                              }
                            }}>
                              <summary aria-label={pick(`إجراءات حساب ${item.displayName ?? item.email ?? ""}`, `Account actions for ${item.displayName ?? item.email ?? ""}`)}>
                                <MoreHorizontal size={17} /> {pick("المزيد", "More")}
                              </summary>
                              <div className="admin-action-menu__content">
                            <button
                              disabled={item.id === user.userId || Boolean(item.deletedAt)}
                              onClick={() => setAccess(item)}
                            >
                              {pick("الأدوار والصلاحيات", "Roles and permissions")}
                            </button>
                            {item.id !== user.userId && (
                              <>
                                {item.deletedAt ? (
                                  <button
                                    onClick={() => setConfirmation({ account: item, action: "RESTORE" })}
                                  >{tr(" استعادة ")}</button>
                                ) : (
                                  <>
                                    <button
                                      onClick={() =>
                                        setConfirmation({
                                          account: item,
                                          action: item.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"
                                        })
                                      }
                                    >
                                      {tr(item.status === "ACTIVE" ? "إيقاف" : "تفعيل")}
                                    </button>
                                    <button
                                      className="danger"
                                      onClick={() => setConfirmation({ account: item, action: "DISABLED" })}
                                    >{tr(" إغلاق الحساب ")}</button>
                                    <button
                                      className="danger"
                                      onClick={() => setConfirmation({ account: item, action: "DELETE" })}
                                    >{tr(" حذف منطقي ")}</button>
                                  </>
                                )}
                                <button className="danger" onClick={() => setConfirmation({ account: item, action: "REVOKE" })}>{tr(" إنهاء الجلسات ")}</button>
                              </>
                            )}
                              </div>
                            </details>}
                          </>
                        )}
                        {section === "sessions" && item.user && item.user.id !== user.userId && (
                          <button
                            onClick={() =>
                              setConfirmation({
                                account: { id: item.user!.id, displayName: item.user!.displayName },
                                action: "REVOKE"
                              })
                            }
                          >{tr(" إنهاء جلسات الحساب ")}</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!result.items.length && <p className="empty-state">{tr("لا توجد سجلات مطابقة.")}</p>}
          </div>
        )}
        <footer className="admin-pagination">
          <button
            className="ghost-button"
            disabled={loading || page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >{tr(" السابق ")}</button>
          <span>{tr(" صفحة ")}{page}{tr(" من ")}{Math.max(1, Math.ceil(result.total / result.pageSize))}
          </span>
          <button
            className="ghost-button"
            disabled={loading || page * result.pageSize >= result.total}
            onClick={() => setPage((p) => p + 1)}
          >{tr(" التالي ")}</button>
        </footer>
      </section>
      {editor && refs && (
        <AccountEditor
          key={editor === "new" ? "new" : editor.id}
          account={editor === "new" ? undefined : editor}
          references={refs}
          selfId={user.userId}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      )}
      {access && refs && (
        <AccessEditor account={access} references={refs} onClose={() => setAccess(null)} onSaved={saved} />
      )}
      {confirmation && (
        <StateEditor {...confirmation} onClose={() => setConfirmation(null)} onSaved={saved} />
      )}
      {creatingTenant && <CreateTenantDialog onClose={() => setCreatingTenant(false)} onSaved={() => { setCreatingTenant(false); saved(); }} />}
      {statusFor && <TenantStatusDialog tenant={statusFor} ownTenantId={user.tenantId} onClose={() => setStatusFor(null)} onSaved={() => { setStatusFor(null); saved(); }} />}
      {activityFor && <TenantActivityDialog tenant={activityFor} onClose={() => setActivityFor(null)} />}
      {unlocking && <UnlockLoginDialog onClose={() => setUnlocking(false)} onDone={(text) => { setUnlocking(false); setMessage(text); }} />}
      {accountAction && <AccountActionDialog {...accountAction} onClose={() => setAccountAction(null)} onDone={(text) => { setAccountAction(null); setMessage(text); setTick((t) => t + 1); }} />}
      {detail && (
        <Modal title={tr("تفاصيل السجل")} onClose={() => setDetail(null)}>
          <p className="form-hint">{tr("بيانات السجل كما هي محفوظة، بدون كلمات مرور أو رموز دخول.")}</p>
          <RecordDetails value={detail} />
        </Modal>
      )}
    </main>
  );
}

const fieldNames: Record<string, string> = {
  nameAr: "اسم الشركة بالعربية", nameEn: "اسم الشركة بالإنجليزية", titleAr: "العنوان بالعربية", titleEn: "العنوان بالإنجليزية", descriptionAr: "الوصف بالعربية", descriptionEn: "الوصف بالإنجليزية", cityAr: "المدينة بالعربية", cityEn: "المدينة بالإنجليزية", detailsAr: "تفاصيل الخدمة بالعربية", detailsEn: "تفاصيل الخدمة بالإنجليزية",
  id: "المعرف", name: "الاسم", displayName: "اسم المستخدم", email: "البريد", phone: "الهاتف", status: "الحالة", isPlatformAdmin: "مدير نظام", deletedAt: "تاريخ الحذف", createdAt: "تاريخ الإنشاء", updatedAt: "آخر تعديل", memberships: "العضويات", tenant: "الجهة", tenantId: "معرف الجهة", organization: "المنشأة", providerOrganizationId: "معرف المنشأة", roles: "الأدوار", role: "الدور", permissions: "الصلاحيات", permission: "الصلاحية", permissionOverrides: "استثناءات الصلاحيات", code: "الرمز", title: "العنوان", description: "الوصف", category: "نوع الخدمة", type: "نوع النشاط", city: "المدينة", priceCents: "السعر الأصلي", totalCents: "إجمالي الحجز", unitPriceCents: "سعر الوحدة المتفق عليه", currency: "العملة", capacity: "السعة", details: "تفاصيل الخدمة", components: "مكونات البرنامج", service: "الخدمة", serviceId: "معرف الخدمة", packageId: "معرف البرنامج", traveler: "المسافر", user: "المستخدم", travelersCount: "عدد المسافرين", units: "عدد الوحدات", serviceDate: "تاريخ الخدمة", endDate: "تاريخ المغادرة", notes: "الملاحظات", action: "العملية", actor: "المنفذ", entityId: "معرف السجل المتأثر", entityType: "نوع السجل", occurredAt: "وقت العملية", metadata: "تفاصيل التغيير", before: "قبل التغيير", after: "بعد التغيير", reason: "السبب", roleIds: "معرفات الأدوار", retainedBusinessRecords: "تم الاحتفاظ بالسجلات", expiresAt: "تنتهي في", revokedAt: "أُلغيت في", lastUsedAt: "آخر استخدام", userAgent: "المتصفح", contactEmail: "بريد التواصل", licenseNumber: "رقم الترخيص", _count: "أعداد السجلات", services: "الخدمات", bookings: "الحجوزات", members: "الأعضاء", roomType: "نوع الغرفة", maxGuests: "أقصى نزلاء", mealPlan: "نظام الوجبات", durationDays: "عدد الأيام", departureCity: "مدينة الانطلاق", departureDate: "موعد الإقلاع", itinerary: "مسار البرنامج", origin: "من", destination: "إلى", flightNumber: "رقم الرحلة", cabin: "الدرجة", vehicleType: "نوع المركبة", seats: "المقاعد", mealType: "نوع الوجبة", menu: "قائمة الطعام", visaType: "نوع التأشيرة", requirements: "المتطلبات", site: "الموقع", scope: "النطاق"
};
function RecordDetails({ value, field = "", currency }: { value: unknown; field?: string; currency?: string }) {
  const tr = useText();
  if (value === null || value === undefined) return <span>{tr("—")}</span>;
  if (typeof value === "boolean") return <span>{tr(value ? "نعم / سماح" : "لا / منع")}</span>;
  if (Array.isArray(value)) return value.length ? <div className="admin-detail-array">{value.map((item, i) => <div key={i}><RecordDetails value={item} currency={currency} /></div>)}</div> : <span>{tr("لا توجد سجلات")}</span>;
  if (typeof value === "object") return <dl className="admin-detail-list">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{tr(fieldNames[key] ?? permissionLabels[key] ?? key)}</dt><dd><RecordDetails value={item} field={key} currency={typeof (value as { currency?: unknown }).currency === "string" ? (value as { currency: string }).currency : currency} /></dd></div>)}</dl>;
  if (["priceCents", "totalCents", "unitPriceCents"].includes(field) && typeof value === "number") return <span>{tr(formatMinorUnits(value, currency && Object.hasOwn(CURRENCY_EXPONENTS, currency) ? currency : "USD", currentLocale(), false))}</span>;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return <span>{tr(time(value))}</span>;
  return <span>{tr(states[String(value)] ?? String(value))}</span>;
}

const TENANT_ADMIN = "tenant-admin";
function AccountEditor({
  account,
  references,
  selfId,
  onClose,
  onSaved
}: {
  account?: AdminRecord;
  references: AdminReferences;
  selfId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const [form, setForm] = useState({
    displayName: account?.displayName ?? "",
    email: account?.email ?? "",
    phone: account?.phone ?? "",
    isPlatformAdmin: account?.isPlatformAdmin ?? false,
    password: "",
    currentPassword: "",
    mfaCode: "",
    tenantId: references.tenants[0]?.id ?? "",
    roleId: "",
    providerOrganizationId: ""
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Granting administration (false -> true) needs the acting admin's password, and a code when they use MFA.
  const granting = Boolean(account && !account.isPlatformAdmin && form.isPlatformAdmin);
  // Creating an account directly as a tenant administrator needs the same re-authentication.
  const creatingAdmin = !account && references.roles.some((r) => r.id === form.roleId && r.code === TENANT_ADMIN);
  const stepUp = granting || creatingAdmin;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (account)
        await platform.update(account.id, {
          displayName: form.displayName,
          email: form.email,
          phone: form.phone,
          isPlatformAdmin: form.isPlatformAdmin,
          ...(granting ? stepUpOf(form) : {})
        });
      else
        await platform.create({
          displayName: form.displayName,
          email: form.email,
          phone: form.phone,
          password: form.password,
          tenantId: form.tenantId,
          roleId: form.roleId,
          ...(form.providerOrganizationId ? { providerOrganizationId: form.providerOrganizationId } : {}),
          ...(creatingAdmin ? stepUpOf(form) : {})
        });
      onSaved();
      onClose();
    } catch (reason) {
      setError(stepUpError(reason, stepUp, pick("كلمة المرور أو رمز التحقق غير صحيح.", "The password or verification code is incorrect.")) ?? errorText(reason));
      setForm((current) => ({ ...current, currentPassword: "", mfaCode: "" }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={tr(account ? "تعديل الحساب" : "إنشاء حساب")} onClose={onClose}>
      <form className="business-form" onSubmit={submit}>
        <label>{tr(" اسم المستخدم ")}<input
            required
            minLength={2}
            maxLength={200}
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </label>
        <label>{tr(" البريد الإلكتروني ")}<input
            required
            type="email"
            maxLength={320}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label>{tr(" الهاتف ")}<input
            maxLength={32}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </label>
        {account ? (
          <>
          <label className="admin-check">
            <input
              type="checkbox"
              disabled={account.id === selfId}
              checked={form.isPlatformAdmin}
              onChange={(e) => setForm({ ...form, isPlatformAdmin: e.target.checked })}
            />{tr(" ")}{tr(" مدير نظام: وصول إلى جميع الجهات والحسابات ")}</label>
          {granting && <StepUpFields value={form} onChange={(next) => setForm({ ...form, ...next })} />}
          </>
        ) : (
          <>
            <label>{tr(" كلمة مرور أولية ")}<input
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <label>{tr(" الجهة ")}<select
                required
                value={form.tenantId}
                onChange={(e) =>
                  setForm({ ...form, tenantId: e.target.value, roleId: "", providerOrganizationId: "" })
                }
              >
                {references.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {tr(t.name)}
                  </option>
                ))}
              </select>
            </label>
            <label>{tr(" الدور ")}<select
                required
                value={form.roleId}
                onChange={(e) => setForm({ ...form, roleId: e.target.value })}
              >
                <option value="">{tr("اختر الدور")}</option>
                {references.roles
                  .filter((r) => r.tenantId === form.tenantId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {tr(r.name)}
                    </option>
                  ))}
              </select>
            </label>
            <label>{tr(" المنشأة (مطلوبة لمقدمي الخدمة) ")}<select
                value={form.providerOrganizationId}
                onChange={(e) => setForm({ ...form, providerOrganizationId: e.target.value })}
              >
                <option value="">{tr("بدون منشأة")}</option>
                {references.organizations
                  .filter((o) => o.tenantId === form.tenantId)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {tr(o.name)}
                    </option>
                  ))}
              </select>
            </label>
            {creatingAdmin && <StepUpFields value={form} onChange={(next) => setForm({ ...form, ...next })} />}
          </>
        )}
        <p className="full-width form-hint">{tr(" تغيير صلاحية مدير النظام ينهي جلسات الحساب. منحها يتيح إدارة المنصة كلها وليس جهة واحدة فقط. ")}</p>
        {tr(error && (
          <p className="full-width form-error" role="alert">
            {tr(error)}
          </p>
        ))}
        <div className="form-actions full-width">
          <button type="button" className="ghost-button" onClick={onClose}>{tr(" رجوع ")}</button>
          <button className="primary-button" disabled={busy}>
            {tr(busy ? "جاري الحفظ…" : "حفظ الحساب")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AccessEditor({
  account,
  references,
  onClose,
  onSaved
}: {
  account: AdminRecord;
  references: AdminReferences;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tr = useText();
  const [membershipId, setMembershipId] = useState(account.memberships?.[0]?.id ?? "");
  const member = account.memberships?.find((m) => m.id === membershipId);
  return (
    <Modal title={tr(`صلاحيات ${account.displayName}`)} onClose={onClose}>
      <label className="admin-member-select">{tr(" العضوية ")}<select value={membershipId} onChange={(e) => setMembershipId(e.target.value)}>
          {account.memberships?.map((m) => (
            <option key={m.id} value={m.id}>
              {tr(m.tenant.name)}{tr(" · ")}{tr(m.tenant.code)}
            </option>
          ))}
        </select>
      </label>
      {member ? (
        <MembershipForm
          key={member.id}
          member={member}
          references={references}
          onSaved={() => {
            onSaved();
            onClose();
          }}
        />
      ) : (
        <p>{tr("لا توجد عضوية لهذا الحساب.")}</p>
      )}
    </Modal>
  );
}
function MembershipForm({
  member,
  references,
  onSaved
}: {
  member: AdminMembership;
  references: AdminReferences;
  onSaved: () => void;
}) {
  const tr = useText();
  const [roleIds, setRoleIds] = useState(member.roles.map((r) => r.role.id));
  const [overrides, setOverrides] = useState(member.permissionOverrides);
  const [status, setStatus] = useState(member.status);
  const [orgId, setOrgId] = useState(member.providerOrganizationId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creds, setCreds] = useState<Creds>({ currentPassword: "", mfaCode: "" });
  const { pick } = useLanguage();
  // Newly adding the tenant-admin role needs the acting admin's re-authentication; demotion or re-saving does not.
  const adminRoleIds = references.roles.filter((r) => r.code === TENANT_ADMIN).map((r) => r.id);
  const heldAdmin = member.roles.some((r) => adminRoleIds.includes(r.role.id));
  const grantsAdmin = !heldAdmin && roleIds.some((id) => adminRoleIds.includes(id));
  const base = new Set(
    references.roles
      .filter((r) => roleIds.includes(r.id))
      .flatMap((r) => r.permissions.map((p) => p.permission.code))
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await platform.access(member.id, {
        roleIds,
        permissionOverrides: overrides,
        status,
        providerOrganizationId: orgId || null,
        ...(grantsAdmin ? stepUpOf(creds) : {})
      });
      onSaved();
    } catch (reason) {
      setError(stepUpError(reason, grantsAdmin, pick("كلمة المرور أو رمز التحقق غير صحيح.", "The password or verification code is incorrect.")) ?? errorText(reason));
      setCreds({ currentPassword: "", mfaCode: "" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="business-form" onSubmit={submit}>
      <label>{tr(" حالة العضوية ")}<select value={status} onChange={(e) => setStatus(e.target.value)}>
          {["ACTIVE", "SUSPENDED", "REVOKED"].map((s) => (
            <option key={s} value={s}>
              {tr(states[s])}
            </option>
          ))}
        </select>
      </label>
      <label>{tr(" المنشأة المرتبطة ")}<select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          <option value="">{tr("بدون منشأة")}</option>
          {references.organizations
            .filter((o) => o.tenantId === member.tenantId)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {tr(o.name)}
              </option>
            ))}
        </select>
      </label>
      <fieldset className="full-width component-picker">
        <legend>{tr("الأدوار")}</legend>
        {references.roles
          .filter((r) => r.tenantId === member.tenantId)
          .map((r) => (
            <label className="admin-check" key={r.id}>
              <input
                type="checkbox"
                checked={roleIds.includes(r.id)}
                onChange={(e) =>
                  setRoleIds(e.target.checked ? [...roleIds, r.id] : roleIds.filter((id) => id !== r.id))
                }
              />
              {tr(r.name)}
            </label>
          ))}
      </fieldset>
      <p className="full-width form-hint">{tr(" الصلاحيات التالية تخص الوظائف الموجودة وتبقى مقيدة بملكية السجل ونشاط المنشأة. «منع» يتغلب على سماح الدور. لا تمنح صلاحيات مدير النظام بهذه القائمة. ")}</p>
      <div className="full-width admin-permissions">
        {references.permissions.map((p) => (
          <label key={p.code}>
            <span>
              {tr(permissionLabels[p.code] ?? p.code)}
                <small dir="ltr">{tr(p.code)}</small>
                {reservedPermissions.has(p.code) && <small>{tr("رمز محجوز؛ لا توجد له وظيفة مستقلة حالياً")}</small>}
              <small>{tr("النتيجة: ")}{tr((overrides[p.code] ?? base.has(p.code)) ? "مسموح" : "ممنوع")}</small>
            </span>
            <select
                aria-label={tr(`صلاحية ${p.code}`)}
                disabled={reservedPermissions.has(p.code)}
              value={overrides[p.code] === undefined ? "inherit" : overrides[p.code] ? "allow" : "deny"}
              onChange={(e) =>
                setOverrides((current) => {
                  const next = { ...current };
                  if (e.target.value === "inherit") delete next[p.code];
                  else next[p.code] = e.target.value === "allow";
                  return next;
                })
              }
            >
              <option value="inherit">{tr("حسب الدور")}</option>
              <option value="allow">{tr("سماح")}</option>
              <option value="deny">{tr("منع")}</option>
            </select>
          </label>
        ))}
      </div>
      {grantsAdmin && <StepUpFields value={creds} onChange={setCreds} />}
      <p className="full-width form-hint">{tr(" الحفظ ينهي جميع جلسات المستخدم لتطبيق التغيير عند تسجيل دخوله مجدداً. ")}</p>
      {tr(error && (
        <p className="full-width form-error" role="alert">
          {tr(error)}
        </p>
      ))}
      <button className="primary-button full-width" disabled={busy || !roleIds.length}>
        {tr(busy ? "جاري الحفظ…" : "حفظ الأدوار والصلاحيات")}
      </button>
    </form>
  );
}
function StateEditor({
  account,
  action,
  onClose,
  onSaved
}: {
  account: AdminRecord;
  action: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tr = useText();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creds, setCreds] = useState<Creds>({ currentPassword: "", mfaCode: "" });
  const { pick } = useLanguage();
  // Every state change of a platform administrator is a step-up action (the API rejects it otherwise).
  const needsStepUp = action !== "REVOKE" && Boolean(account.isPlatformAdmin);
  const title = (
    {
      ACTIVE: "تفعيل الحساب",
      SUSPENDED: "إيقاف الحساب",
      DISABLED: "إغلاق الحساب",
      DELETE: "حذف الحساب منطقياً",
      RESTORE: "استعادة الحساب إلى حالة موقوف",
      REVOKE: "إنهاء جميع جلسات الحساب"
    } as Record<string, string>
  )[action];
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (action === "REVOKE") await platform.revoke(account.id);
      else await platform.state(account.id, action, reason, needsStepUp ? stepUpOf(creds) : undefined);
      onSaved();
      onClose();
    } catch (r) {
      setError(stepUpError(r, needsStepUp, pick("كلمة المرور أو رمز التحقق غير صحيح.", "The password or verification code is incorrect.")) ?? errorText(r));
      setCreds({ currentPassword: "", mfaCode: "" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={tr(title ?? "تأكيد الإجراء")} onClose={onClose}>
      <form className="business-form" onSubmit={submit}>
        <p className="full-width">
          {tr(account.displayName)}{tr(" · ")}{tr(account.email)}
        </p>
        <p className="full-width form-hint">{tr(" ستُنهى الجلسات الحالية. تبقى الحجوزات والخدمات والسجلات محفوظة. الحذف قابل للاستعادة، ولا يلغي الحجوزات تلقائياً. ")}</p>
        {action !== "REVOKE" && (
          <label className="full-width">{tr(" سبب الإجراء ")}<textarea
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        {needsStepUp && <StepUpFields value={creds} onChange={setCreds} />}
        {tr(error && (
          <p className="full-width form-error" role="alert">
            {tr(error)}
          </p>
        ))}
        <div className="full-width form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>{tr(" رجوع ")}</button>
          <button className="primary-button" disabled={busy}>
            {tr(busy ? "جاري التنفيذ…" : "تأكيد الإجراء")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
