import { useText } from "../i18n/useText";
import { currentLocale } from "../i18n/locale";
import { useLocalizedData } from "../i18n/useLocalizedData";
import { Skeleton } from "../components/LoadingScreen";
import { InvitationsBanner } from "../components/InvitationsBanner";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SessionsPanel } from "../components/SessionsPanel";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import {
  Bell,
  ArrowUpRight,
  BedDouble,
  Building2,
  BusFront,
  CalendarDays,
  CircleUserRound,
  Compass,
  Globe2,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Pencil,
  PlaneTakeoff,
  Plus,
  RefreshCw,
  Search,
  Store,
  TicketCheck,
  UtensilsCrossed,
  WalletCards,
  UsersRound,
  X
} from "lucide-react";
import { useAuth } from "../auth/auth-context";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../i18n/LanguageSwitch";
import { useLanguage } from "../i18n/useLanguage";
import { englishCurrencyNames } from "../i18n/labels";
import { BookingEditor, Modal, ProviderEditor, ServiceEditor } from "../components/BusinessForms";
import { convertedMoney, money } from "../lib/format";
import {
  api,
  type Booking,
  type ExchangeRates,
  type Organization,
  type Tenant,
  type TenantMember,
  type TravelService,
  type ServiceCategory,
  supportedCurrencies,
  currencyNames,
  type SupportedCurrency,
  type WorkspaceMetadata,
  PAGE_SIZE
} from "../lib/api";
import "./workspace-premium.css";

const serviceIcons = {
  FLIGHT: PlaneTakeoff, HOTEL: BedDouble, TRANSPORT: BusFront, TOUR: Compass,
  OTHER: Globe2, UMRAH: Globe2, PACKAGE: WalletCards, RESTAURANT: UtensilsCrossed,
  VISA: TicketCheck, VISIT: MapPin
};

function ServiceArtwork({ category }: { category: ServiceCategory }) {
  const Icon = serviceIcons[category];
  return <div className={`service-artwork service-artwork--${category.toLowerCase()}`} aria-hidden="true">
    <span className="service-artwork__orbit" />
    <span className="service-artwork__orbit service-artwork__orbit--inner" />
    <span className="service-artwork__horizon" />
    <Icon strokeWidth={1.1} />
    <span className="service-artwork__point" />
  </div>;
}

type View = "overview" | "services" | "marketplace" | "bookings" | "providers" | "people" | "profile";
const statusLabels = { PENDING: "بانتظار التأكيد", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };
const roleNames: Record<string, string> = {
  "tenant-admin": "مدير الجهة",
  "service-provider": "مقدم خدمة",
  "travel-company": "شركة سياحة",
  traveler: "مسافر"
};
const dateText = (date: string | null): string =>
  date
    ? new Date(date).toLocaleDateString(currentLocale(), { calendar: "gregory", timeZone: "UTC" })
    : "حجز سابق دون موعد";
const currencyStorageKey = "safry.displayCurrency";
function preferredCurrency(): SupportedCurrency {
  try {
    const stored = window.localStorage.getItem(currencyStorageKey);
    return supportedCurrencies.find((currency) => currency === stored) ?? "SAR";
  } catch {
    return "SAR";
  }
}

/** English booking status labels (one map, with a fallback at the call sites so an unknown status never renders `undefined`). */
const bookingStatusEnglish: Record<string, string> = { PENDING: "Pending", CONFIRMED: "Confirmed", CANCELLED: "Cancelled" };

function includesNeedle(text: string, search: string): boolean {
  return text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}

export function DashboardPage() {
  const tr = useText();
  const { pick } = useLanguage();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { view: viewSlug } = useParams();
  const view = viewSlug as View;
  const isAdmin = Boolean(user?.roles.includes("tenant-admin"));
  const isTraveler = !isAdmin && Boolean(user?.roles.includes("traveler"));
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [rawMetadata, setMetadata] = useState<WorkspaceMetadata | null>(null);
  const metadata = useLocalizedData(rawMetadata);
  const [rawServices, setServices] = useState<TravelService[]>([]);
  const services = useLocalizedData(rawServices);
  const [rawMarketplace, setMarketplace] = useState<TravelService[]>([]);
  const marketplace = useLocalizedData(rawMarketplace);
  const [rawBookings, setBookings] = useState<Booking[]>([]);
  const bookings = useLocalizedData(rawBookings);
  const [rawProviders, setProviders] = useState<Organization[]>([]);
  const providers = useLocalizedData(rawProviders);
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const [hasMore, setHasMore] = useState({ services: false, marketplace: false, bookings: false });
  const [filter, setFilter] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [serviceEditor, setServiceEditor] = useState<TravelService | "new" | null>(null);
  const [bookingEditor, setBookingEditor] = useState<{ service: TravelService; booking?: Booking } | null>(
    null
  );
  const [providerEditor, setProviderEditor] = useState<Organization | "new" | null>(null);
  const [detail, setDetail] = useState<TravelService | null>(null);
  const [displayCurrency, setDisplayCurrency] = useState<SupportedCurrency>(preferredCurrency);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRates | null>(null);
  const [exchangeError, setExchangeError] = useState(false);
  const [confirmation, setConfirmation] = useState<{ text: string; run: () => Promise<unknown> } | null>(
    null
  );

  useEffect(() => {
    if (!menuOpen && !notificationsOpen) return;
    const closeOverlays = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setNotificationsOpen(false);
      }
    };
    window.addEventListener("keydown", closeOverlays);
    return () => window.removeEventListener("keydown", closeOverlays);
  }, [menuOpen, notificationsOpen]);

  function chooseCurrency(currency: SupportedCurrency): void {
    setDisplayCurrency(currency);
    try { window.localStorage.setItem(currencyStorageKey, currency); } catch { /* private browsing */ }
  }

  const reload = useCallback(async () => {
    const [
      nextTenant,
      nextMetadata,
      nextServices,
      nextMarketplace,
      nextBookings,
      nextProviders,
      nextMembers
    ] = await Promise.all([
      user?.permissions.includes("tenant.read") ? api.currentTenant() : Promise.resolve(null),
      user?.permissions.includes("tenant.read") ? api.workspace() : Promise.resolve(null),
      user?.permissions.includes("catalog.service.read") ? api.services() : Promise.resolve([]),
      user?.permissions.includes("catalog.service.read") ? api.marketplace() : Promise.resolve([]),
      user?.permissions.includes("booking.read") ? api.bookings() : Promise.resolve([]),
      user?.permissions.includes("catalog.service.read") ? api.providers() : Promise.resolve([]),
      isAdmin && user?.permissions.includes("identity.user.read") ? api.members() : Promise.resolve([])
    ]);
    setTenant(nextTenant);
    setMetadata(nextMetadata);
    setServices(nextServices);
    setMarketplace(nextMarketplace);
    setBookings(nextBookings);
    setProviders(nextProviders);
    setMembers(nextMembers);
    setHasMore({
      services: nextServices.length >= PAGE_SIZE,
      marketplace: nextMarketplace.length >= PAGE_SIZE,
      bookings: nextBookings.length >= PAGE_SIZE
    });
  }, [isAdmin, user?.permissions]);
  // The API returns at most PAGE_SIZE rows per request; "load more" appends the next page by offset.
  async function loadMore(kind: "services" | "marketplace" | "bookings"): Promise<void> {
    setBusy(true);
    try {
      if (kind === "bookings") {
        const next = await api.bookings(rawBookings.length);
        setBookings((current) => [...current, ...next]);
        setHasMore((current) => ({ ...current, bookings: next.length >= PAGE_SIZE }));
      } else {
        const next = await (kind === "services" ? api.services(rawServices.length) : api.marketplace(rawMarketplace.length));
        (kind === "services" ? setServices : setMarketplace)((current) => [...current, ...next]);
        setHasMore((current) => ({ ...current, [kind]: next.length >= PAGE_SIZE }));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحميل البيانات");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let live = true;
    // Network state is applied after all requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload()
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : "تعذر تحميل البيانات");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reload]);
  useEffect(() => {
    let live = true;
    const refresh = () => api.exchangeRates().then((rates) => {
      if (live) { setExchangeRates(rates); setExchangeError(false); }
    }).catch(() => { if (live) { setExchangeRates(null); setExchangeError(true); } });
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60 * 60 * 1000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  const org = metadata?.organization;
  const providerLabel = org ? metadata?.providerDefinitions[org.type].label : null;
  const canManage =
    (isAdmin || Boolean(org)) && Boolean(user?.permissions.includes("catalog.service.manage"));
  const isCompany = org?.type === "UMRAH_COMPANY" || org?.type === "TRAVEL_COMPANY";
  const scopeLabel = isAdmin
    ? pick("إدارة الجهة الحالية", "Current workspace administration")
    : isTraveler
      ? pick("مساحة المسافر", "Traveler workspace")
      : pick(`بوابة ${providerLabel ?? "مقدم الخدمة"}`, "Provider workspace");
  const serviceLabel = isCompany
    ? "برامجي وخدماتي"
    : org?.type === "HOTEL"
      ? "الغرف والإقامة"
      : org?.type === "AIRLINE"
        ? "الرحلات والمقاعد"
        : org?.type === "TRANSPORT"
          ? "المركبات والمسارات"
          : "خدماتي";
  const pending = bookings.filter((item) => item.status === "PENDING");
  const confirmed = bookings.filter((item) => item.status === "CONFIRMED");
  const matches = (text: string): boolean => includesNeedle(text, debouncedSearch);
  const nav = [
    { id: "overview" as View, label: pick("نظرة عامة", "Overview"), icon: LayoutDashboard },
    ...(canManage
      ? [{ id: "services" as View, label: isAdmin ? pick("إدارة الخدمات", "Manage services") : pick(serviceLabel, "My services"), icon: PlaneTakeoff }]
      : []),
    { id: "marketplace" as View, label: pick("سوق السفر", "Travel marketplace"), icon: Store },
    { id: "bookings" as View, label: isTraveler ? pick("حجوزاتي", "My bookings") : pick("طلبات الحجز", "Booking requests"), icon: TicketCheck },
    { id: "providers" as View, label: pick("الشركات ومزودو الخدمات", "Companies and providers"), icon: Building2 },
    ...(isAdmin ? [{ id: "people" as View, label: pick("المستخدمون", "Users"), icon: UsersRound }] : []),
    { id: "profile" as View, label: org ? pick("ملف المنشأة والحساب", "Company and account") : pick("حسابي", "My account"), icon: CircleUserRound }
  ];
  function go(next: View): void {
    navigate(`/workspace/${next}`);
    setSearch("");
    setFilter("");
    setMenuOpen(false);
  }
  async function action(
    work: () => Promise<unknown>,
    success = "تم حفظ التغيير",
    refresh = true
  ): Promise<void> {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      if (refresh) await reload();
      setMessage(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تنفيذ العملية");
    } finally {
      setBusy(false);
      setConfirmation(null);
    }
  }
  async function saved(): Promise<void> {
    await reload();
    setMessage("تم حفظ البيانات بنجاح");
  }

  // Derived lists are recomputed only when their inputs change, not on every keystroke-driven render.
  const shownServices = useMemo(
    () =>
      (view === "marketplace" ? marketplace : services).filter(
        (item) =>
          includesNeedle(`${item.title} ${item.city} ${item.organization.name}`, debouncedSearch) && (!filter || item.category === filter)
      ),
    [view, marketplace, services, debouncedSearch, filter]
  );
  const shownBookings = useMemo(
    () =>
      bookings.filter(
        (item) =>
          includesNeedle(`${item.service.title} ${item.service.organization.name} ${item.traveler?.user.displayName ?? ""}`, debouncedSearch) &&
          (!filter || item.status === filter)
      ),
    [bookings, debouncedSearch, filter]
  );

  if (!loading && !nav.some((item) => item.id === view)) {
    return <Navigate to="/workspace/overview" replace />;
  }

  return (
    <div className={`app-shell premium-workspace-shell ${isTraveler ? "premium-workspace-shell--traveler" : "premium-workspace-shell--business"}`}>
      <a className="workspace-skip-link" href="#workspace-content">{pick("تخطي إلى المحتوى", "Skip to content")}</a>
      {menuOpen && (
        <button className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-label={tr("إغلاق القائمة")} />
      )}
      <aside id="workspace-navigation" className={`sidebar ${menuOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__header">
          <Brand compact />
          <button className="sidebar-close" onClick={() => setMenuOpen(false)} aria-label={tr("إغلاق القائمة")}>
            <X size={20} />
          </button>
        </div>
        <div className="portal-identity">
          <span>{tr(scopeLabel)}</span>
          <strong>{tr(org?.name ?? tenant?.name ?? "سفري")}</strong>
        </div>
        <nav className="sidebar__nav" aria-label={pick("القائمة الرئيسية", "Main navigation")}>
          <span className="workspace-nav-label">{pick("مساحة عملك", "YOUR WORKSPACE")}</span>
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "nav-item--active" : ""}`}
              onClick={() => go(id)}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{tr(label)}</span>
              {id === "bookings" && pending.length > 0 && <small className="workspace-nav-count">{pending.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar__footer">
          {org && user?.permissions.includes("organization.staff.manage") && (
            <Link className="secondary-button" to={`/workspace/organizations/${org.id}/specialties`}>
              {pick("أقسام المنشأة والموظفون", "Company departments and staff")}
            </Link>
          )}
          <button className="workspace-account-card" onClick={() => go("profile")}>
            <span className="avatar"><CircleUserRound size={21} /></span>
            <span><strong>{pick("إعدادات حسابك", "Your account")}</strong><small dir="ltr">{user?.email}</small></span>
          </button>
          <small className="workspace-tenant-label">{pick("مساحة العمل", "Workspace")}{tr(" · ")}{tr(tenant?.code)}</small>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="topbar__start">
            <button className="menu-button" aria-label={pick("فتح القائمة", "Open menu")} aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(true)}>
              <Menu size={22} />
            </button>
            <div className="business-search">
              <Search size={18} />
              <input
                aria-label={pick("البحث في القسم", "Search this section")}
                placeholder={view === "bookings" ? pick("ابحث في حجوزاتك…", "Search your bookings…") : pick("ابحث باسم خدمة أو شركة…", "Search services or companies…")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="topbar__actions notification-wrap">
            <LanguageSwitch />
            <label className="topbar-currency"><span>{pick("عملة العرض", "Currency")}</span>
              <select aria-label={pick("عملة عرض الأسعار", "Price display currency")} value={displayCurrency}
                onChange={(event) => chooseCurrency(event.target.value as SupportedCurrency)}>
                {supportedCurrencies.map((code) => <option key={code} value={code} title={pick(currencyNames[code], englishCurrencyNames[code])}>{code}</option>)}
              </select>
            </label>
            <button
              className="notification-button"
              aria-label={pick("طلبات تحتاج متابعة", "Requests needing attention")}
              aria-expanded={notificationsOpen}
              aria-controls="workspace-notifications"
              onClick={() => setNotificationsOpen(!notificationsOpen)}
            >
              <Bell size={19} />
              {pending.length > 0 && <i>{pending.length}</i>}
            </button>
            {notificationsOpen && (
              <div className="notification-panel" id="workspace-notifications">
                <strong>{pick("متابعة الحجوزات", "Booking follow-up")}</strong>
                <button
                  onClick={() => {
                    go("bookings");
                    setFilter("PENDING");
                    setNotificationsOpen(false);
                  }}
                >
                  {pending.length ? pick(`بانتظار التأكيد: ${pending.length}`, `Pending confirmation: ${pending.length}`) : pick("عرض سجل الحجوزات", "View booking history")}
                </button>
              </div>
            )}
            <button className="avatar profile-link" aria-label={pick("فتح الحساب", "Open account")} onClick={() => go("profile")}>
              <CircleUserRound size={22} />
            </button>
            <button
              className="logout-button"
              aria-label={pick("تسجيل الخروج", "Sign out")}
              onClick={() => void logout().catch(() => window.location.reload())}
            >
              <LogOut size={19} />
            </button>
          </div>
        </header>
        <main className="dashboard" id="workspace-content" tabIndex={-1}>
          {user?.isPlatformAdmin && (
            <Link className="secondary-button" to="/admin/accounts-permissions">
              {pick("لوحة مدير النظام · جميع الجهات والحسابات", "Platform admin · all workspaces and accounts")}
            </Link>
          )}
          <InvitationsBanner />
          <section className="welcome-row">
            <div>
              <span className="eyebrow eyebrow--dark">{tr(scopeLabel)}</span>
              <h1>{tr(nav.find((item) => item.id === view)?.label)}</h1>
              <p>{tr(org ? pick(`إدارة أعمال ${org.name}`, `Manage ${org.name}`) : pick("اكتشف البرامج والخدمات وتابع حجوزاتك من مكان واحد", "Explore services and manage bookings in one place"))}</p>
            </div>
            <button
              className="ghost-button"
              disabled={busy || loading}
              onClick={() => void action(reload, "تم تحديث البيانات", false)}
            >
              <RefreshCw size={16} /> {pick("تحديث", "Refresh")}
            </button>
          </section>
          {org?.status !== "ACTIVE" && org && (
            <p className="form-error">{pick("نشاط المنشأة موقوف حالياً. تواصل مع مدير المنصة لإعادة التفعيل.", "This company is currently suspended. Contact the platform admin to reactivate it.")}</p>
          )}
          {tr((message || error) && (
            <div
              className={`workspace-alert ${error ? "workspace-alert--error" : ""}`}
              role={error ? "alert" : "status"}
            >
              <span>{tr(error || message)}</span>
              <button
                aria-label={tr("إغلاق الرسالة")}
                onClick={() => {
                  setError("");
                  setMessage("");
                }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
          {loading && <div role="status" aria-label={pick("جاري تحميل مساحة العمل…", "Loading workspace…")}><Skeleton rows={4} /></div>}

          {view === "overview" && (
            <>
              <section className="workspace-hero">
                <div className="workspace-hero__copy">
                  <span className="workspace-kicker"><span />{pick("كل رحلة تبدأ من هنا", "EVERY JOURNEY STARTS HERE")}</span>
                  <h2>{isTraveler ? pick("خطط لرحلتك. واستمتع بالتفاصيل.", "A great journey starts with a clear plan.") : pick("أعمال السفر، في مساحة أوضح.", "Your travel business. One clear view.")}</h2>
                  <p>{isTraveler ? pick("اكتشف الإقامة والطيران والبرامج، وقارن الخدمات وتابع حجوزاتك بكل وضوح.", "Explore stays, flights, and experiences. Compare services and keep every booking in view.") : pick("نظّم عروضك، تابع طلبات المسافرين، وامنح فريقك صورة واضحة عن العمل.", "Organize your offers, follow traveler requests, and keep your team focused on what matters.")}</p>
                  <div className="workspace-hero__actions">
                    <button className="secondary-button" onClick={() => canManage ? setServiceEditor("new") : go("marketplace")} disabled={canManage && Boolean(org && org.status !== "ACTIVE")}>
                      {canManage ? <Plus size={18} /> : <Compass size={18} />}
                      {canManage ? pick("إضافة خدمة جديدة", "Create a service") : pick("استكشف خدمات السفر", "Explore travel services")}
                    </button>
                    <button className="ghost-button" onClick={() => go("bookings")}><TicketCheck size={18} />{pick("متابعة الحجوزات", "View bookings")}</button>
                  </div>
                </div>
                <div className="workspace-hero__visual" aria-hidden="true">
                  <div className="journey-globe"><Globe2 strokeWidth={0.65} /><span className="journey-globe__plane"><PlaneTakeoff strokeWidth={1.5} /></span></div>
                  <div className="journey-route"><span /> <i /> <MapPin size={22} /></div>
                </div>
              </section>
              <div className="status-grid">
                <button
                  className="status-card status-card--button"
                  onClick={() => go(canManage ? "services" : "marketplace")}
                >
                  <span className="workspace-metric-icon"><Store size={21} /></span>
                  <span>{tr(canManage ? pick("خدمات المنشأة", "Company services") : pick("العروض المتاحة", "Available offers"))}</span>
                  <strong>{canManage ? services.length : marketplace.length}</strong>
                  <small>{pick("عرض الخدمات والتفاصيل", "View services and details")}<ArrowUpRight size={16} /></small>
                </button>
                <button className="status-card status-card--button" onClick={() => go("bookings")}>
                  <span className="workspace-metric-icon"><TicketCheck size={21} /></span>
                  <span>{pick("طلبات الحجز", "Booking requests")}</span>
                  <strong>{bookings.length}</strong>
                  <small>{pick("حجوزات مؤكدة:", "Confirmed bookings:")} {confirmed.length}<ArrowUpRight size={16} /></small>
                </button>
                <button className="status-card status-card--button status-card--attention" onClick={() => { go("bookings"); setFilter("PENDING"); }}>
                  <span className="workspace-metric-icon"><CalendarDays size={21} /></span>
                  <span>{pick("بانتظار التأكيد", "Awaiting confirmation")}</span>
                  <strong>{pending.length}</strong>
                  <small>{pick("الطلبات التي تحتاج متابعة", "Requests to follow up")}<ArrowUpRight size={16} /></small>
                </button>
              </div>
              <section className="work-panel">
                <div className="section-heading">
                  <div><span className="workspace-kicker">{pick("خطوتك التالية", "YOUR NEXT STEP")}</span><h2>{pick("كل ما تحتاجه، أقرب إليك", "Everything you need, within reach")}</h2></div>
                </div>
                <div className="quick-grid">
                  {canManage && (
                    <button
                      onClick={() => setServiceEditor("new")}
                      disabled={Boolean(org && org.status !== "ACTIVE")}
                    >
                      <Plus />
                      <strong>{tr(isCompany ? pick("برنامج جديد", "New program") : pick("إضافة عرض", "Add offer"))}</strong>
                      <span>{pick("حقول تناسب نشاط منشأتك", "Details tailored to your business")}</span>
                    </button>
                  )}
                  <button onClick={() => go("marketplace")}>
                    <Store />
                    <strong>{pick("سوق السفر", "Travel marketplace")}</strong>
                    <span>{pick("فندق، طيران، نقل وبرامج متكاملة", "Hotels, flights, transport, and travel packages")}</span>
                  </button>
                  <button onClick={() => go("bookings")}>
                    <TicketCheck />
                    <strong>{pick("متابعة الحجوزات", "Track bookings")}</strong>
                    <span>{pick("المواعيد والكميات وحالة الطلب", "Dates, quantities, and booking status")}</span>
                  </button>
                  <button onClick={() => go("providers")}>
                    <Building2 />
                    <strong>{pick("دليل المنشآت", "Company directory")}</strong>
                    <span>{pick("الشركات وتخصصاتها وخدماتها", "Companies, specialties, and services")}</span>
                  </button>
                </div>
              </section>
              {bookings.length > 0 && <section className="work-panel workspace-recent">
                <div className="section-heading"><div><span className="workspace-kicker">{pick("ابقَ على اطلاع", "STAY IN THE LOOP")}</span><h2>{pick("لمحة عن حجوزاتك", "Your bookings at a glance")}</h2></div><button className="ghost-button" onClick={() => go("bookings")}>{pick("عرض الكل", "View all")}<ArrowUpRight size={16} /></button></div>
                <div className="workspace-recent__list">{bookings.slice(0, 3).map((booking) => <button key={booking.id} className="workspace-recent__item" onClick={() => go("bookings")}>
                  <span className="workspace-recent__icon"><TicketCheck size={22} /></span><span className="workspace-recent__name"><strong>{booking.service.title}</strong><small>{booking.service.organization.name} · {dateText(booking.serviceDate)}</small></span><span className={`booking-status booking-status--${booking.status.toLowerCase()}`}>{tr(statusLabels[booking.status])}</span>
                </button>)}</div>
              </section>}
            </>
          )}

          {(view === "services" || view === "marketplace") && metadata && (
            <section className={`work-panel workspace-catalog ${view === "marketplace" ? "workspace-catalog--marketplace" : ""}`}>
              {view === "marketplace" && <div className="marketplace-intro">
                <div><span className="workspace-kicker">{pick("عالم من الخيارات", "A WORLD OF POSSIBILITIES")}</span><h2>{pick("رحلتك، على طريقتك.", "Travel, your way.")}</h2><p>{pick("من أول رحلة طيران إلى آخر تجربة، اكتشف الخدمات المناسبة لخططك.", "From the first flight to the final experience, find the services that fit your plans.")}</p></div><Compass size={78} strokeWidth={1} aria-hidden="true" />
              </div>}
              <div className="section-heading">
                <div><h2>{tr(view === "services" ? pick(serviceLabel, "My services") : pick("اكتشف الخدمات", "Explore services"))}</h2><span className="workspace-results-count">{pick("النتائج:", "Results:")} {shownServices.length}</span></div>
                <div className="section-controls">
                  <select
                    aria-label={pick("تصفية نوع الخدمة", "Filter service type")}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="">{pick("كل الأنواع", "All types")}</option>
                    {Object.entries(metadata.serviceDefinitions).map(([key, def]) => (
                      <option key={key} value={key}>
                        {tr(def.label)}
                      </option>
                    ))}
                  </select>
                  {view === "services" && canManage && (
                    <button
                      className="secondary-button"
                      onClick={() => setServiceEditor("new")}
                      disabled={Boolean(org && org.status !== "ACTIVE")}
                    >
                      <Plus size={17} /> {pick("إضافة عرض", "Add offer")}
                    </button>
                  )}
                </div>
              </div>
              {view === "marketplace" && <div className="workspace-category-tabs" role="group" aria-label={pick("نوع الخدمة", "Service category")}>
                <button className={!filter ? "is-selected" : ""} aria-pressed={!filter} onClick={() => setFilter("")}><Globe2 size={17} />{pick("كل الخدمات", "All services")}</button>
                {Object.entries(metadata.serviceDefinitions).filter(([key]) => marketplace.some((item) => item.category === key)).map(([key, definition]) => {
                  const Icon = serviceIcons[key as ServiceCategory];
                  return <button key={key} className={filter === key ? "is-selected" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}><Icon size={17} />{tr(definition.label)}</button>;
                })}
              </div>}
              <details className="workspace-currency-note"><summary><WalletCards size={16} />{pick("الأسعار معروضة بـ", "Prices displayed in")} {displayCurrency} · {pick("حول تحويل العملة", "About currency conversion")}</summary><p className="form-hint">{pick("اختر عملة العرض من أعلى الصفحة؛ لكل خدمة سعر أصلي واحد، وتُعرض قيمته التقريبية بالعملة التي اخترتها. يُسجل الحجز بالسعر الأصلي.", "Choose a display currency above. Each service has one original price; other currencies are approximate conversions. Bookings retain the original price.")}
                {tr(exchangeRates ? pick(` المصدر: Frankfurter، آخر تحديث ${new Date(exchangeRates.fetchedAt).toLocaleString("ar-SA")}.`, ` Source: Frankfurter. Last updated ${new Date(exchangeRates.fetchedAt).toLocaleString("en-US")}.`) :
                  exchangeError ? pick(" تعذّر تحديث الصرف الآن، لذلك يظهر السعر الأصلي فقط.", " Exchange rates are unavailable, so only original prices are shown.") : pick(" جارٍ تحميل أسعار الصرف.", " Loading exchange rates."))}</p></details>
              <div className="service-grid">
                {shownServices.map((item) => (
                  <article
                    className={`service-card ${item.status !== "ACTIVE" ? "service-card--inactive" : ""}`}
                    key={item.id}
                  >
                    <ServiceArtwork category={item.category} />
                    <div className="service-card__head">
                      <span>{tr(metadata.serviceDefinitions[item.category].label)}</span>
                      <small><MapPin size={13} />{tr(item.city)}</small>
                    </div>
                    <h3>{tr(item.title)}</h3>
                    <p>{tr(item.description)}</p>
                    <small className="provider-name">
                      {tr(item.organization.name)}{tr(" · ")}{tr(metadata.providerDefinitions[item.organization.type].label)}
                    </small>
                    <div className="service-specs">
                      <span>{tr(item.status === "ACTIVE" ? pick("نشط", "Active") : pick("متوقف", "Inactive"))}</span>
                      <span>{pick("السعة:", "Capacity:")} {item.capacity}</span>
                      {tr(item.details.durationDays && <span>{pick("الأيام:", "Days:")} {tr(item.details.durationDays)}</span>)}
                      {tr(item.details.roomType && <span>{tr(item.details.roomType)}</span>)}
                      {tr(item.details.flightNumber && <span>{tr(item.details.flightNumber)}</span>)}
                    </div>
                    <div className="service-card__footer">
                      <div>
                        <strong>{tr(convertedMoney(item.priceCents, item.currency, displayCurrency, exchangeRates) ?? money(item.priceCents, item.currency))}</strong>
                        <small className="price-unit">
                          {tr(metadata.serviceDefinitions[item.category].unit)}
                        </small>
                      </div>
                      <div className="card-actions">
                        <button className="ghost-action" onClick={() => setDetail(item)}>
                          {pick("التفاصيل", "Details")}
                        </button>
                        {isTraveler && (
                          <button disabled={item.status !== "ACTIVE"} onClick={() => setBookingEditor({ service: item })}>{pick("احجز الآن", "Book now")}<ArrowUpRight size={15} /></button>
                        )}
                      </div>
                    </div>
                    {view === "services" && canManage && (
                      <div className="management-actions">
                        <button className="ghost-button" onClick={() => setServiceEditor(item)}>
                          <Pencil size={14} /> {pick("تعديل", "Edit")}
                        </button>
                        <button
                          className="ghost-button"
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              text:
                                item.status === "ACTIVE"
                                  ? "إيقاف العرض عن استقبال حجوزات جديدة؟ ستبقى الحجوزات الحالية محفوظة."
                                  : "تفعيل العرض في سوق السفر؟",
                              run: () =>
                                api.updateService(item.id, {
                                  status: item.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"
                                })
                            })
                          }
                        >
                          {tr(item.status === "ACTIVE" ? pick("إيقاف العرض", "Pause offer") : pick("تفعيل العرض", "Activate offer"))}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {(view === "marketplace" ? hasMore.marketplace : hasMore.services) && <div className="load-more"><button className="ghost-button" disabled={busy} onClick={() => void loadMore(view === "marketplace" ? "marketplace" : "services")}>{pick("عرض المزيد", "Load more")}</button></div>}
              {!loading && !shownServices.length && (
                <div className="empty-state workspace-empty"><Search size={32} /><h3>{pick("لم نجد خدمة مطابقة", "No matching services")}</h3><p>{pick("جرّب كلمة أخرى أو أزل الفلاتر لاكتشاف المزيد.", "Try another search or clear your filters to explore more.")}</p><button className="ghost-button" onClick={() => { setSearch(""); setFilter(""); }}>{pick("مسح البحث والفلاتر", "Clear search and filters")}</button></div>
              )}
            </section>
          )}

          {view === "bookings" && (
            <section className="work-panel">
              <div className="section-heading">
                <div><h2>{tr(isTraveler ? pick("حجوزاتي", "My bookings") : pick("الحجوزات الواردة", "Incoming bookings"))}</h2><span className="workspace-results-count">{pick("النتائج:", "Results:")} {shownBookings.length}</span></div>
                <select
                  className="filter-select"
                  aria-label={pick("حالة الحجز", "Booking status")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="">{pick("كل الحالات", "All statuses")}</option>
                  {Object.entries(statusLabels).map(([key, value]) => (
                    <option value={key} key={key}>
                      {tr(pick(value, bookingStatusEnglish[key] ?? value))}
                    </option>
                  ))}
                </select>
              </div>
              <div className="workspace-booking-tabs" role="group" aria-label={pick("تصفية الحجوزات", "Filter bookings")}>
                {[{ status: "", label: pick("الكل", "All"), count: bookings.length }, { status: "PENDING", label: pick("بانتظار التأكيد", "Pending"), count: pending.length }, { status: "CONFIRMED", label: pick("مؤكد", "Confirmed"), count: confirmed.length }, { status: "CANCELLED", label: pick("ملغي", "Cancelled"), count: bookings.filter((booking) => booking.status === "CANCELLED").length }].map((item) => <button key={item.status} aria-pressed={filter === item.status} className={filter === item.status ? "is-selected" : ""} onClick={() => setFilter(item.status)}>{item.label}<span>{item.count}</span></button>)}
              </div>
              <div className="booking-list">
                {shownBookings.map((item) => (
                  <article className="booking-row" key={item.id}>
                    <div className="booking-row__description">
                      <strong>{tr(item.service.title)}</strong>
                      <small>{tr(item.service.organization.name)}</small>
                      <small className="booking-row__schedule"><CalendarDays size={14} />
                        {tr(dateText(item.serviceDate))}
                        {item.endDate ? ` — ${dateText(item.endDate)}` : ""}
                      </small>
                      <small>{pick("المسافرون:", "Travelers:")} {item.travelersCount} · {item.service.category === "HOTEL"
                          ? pick("الغرف:", "Rooms:")
                          : item.service.category === "TRANSPORT"
                            ? pick("المركبات:", "Vehicles:")
                            : pick("الوحدات:", "Units:")} {item.units}
                      </small>
                      {!isTraveler && (
                        <small>
                          {tr(item.traveler?.user.displayName)}{tr(" · ")}{tr(item.traveler?.user.email)}
                        </small>
                      )}
                      {tr(item.notes && <small>{pick("ملاحظات:", "Notes:")} {tr(item.notes)}</small>)}
                    </div>
                    <div className="booking-row__amount">
                      <strong>{tr(convertedMoney(item.totalCents, item.currency, displayCurrency, exchangeRates) ?? money(item.totalCents, item.currency))}</strong>
                      {item.currency !== displayCurrency &&
                        <small>{pick("قيمة الحجز الأصلية:", "Original booking value:")} {tr(money(item.totalCents, item.currency))}</small>}
                      <span className={`booking-status booking-status--${item.status.toLowerCase()}`}>
                        {tr(pick(statusLabels[item.status], bookingStatusEnglish[item.status] ?? statusLabels[item.status]))}
                      </span>
                    </div>
                    <div className="booking-actions">
                      {(isTraveler || isAdmin) && item.status === "PENDING" && (
                        <button onClick={() => setBookingEditor({ service: item.service, booking: item })}>
                          {pick("تعديل", "Edit")}
                        </button>
                      )}
                      {canManage && item.status === "PENDING" && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(() => api.updateBookingStatus(item.id, "CONFIRMED"), "تم تأكيد الحجز")
                          }
                        >
                          {pick("تأكيد", "Confirm")}
                        </button>
                      )}
                      {item.status !== "CANCELLED" && (
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              text: "إلغاء طلب الحجز وتحرير سعته؟",
                              run: () => api.updateBookingStatus(item.id, "CANCELLED")
                            })
                          }
                        >
                          {pick("إلغاء الحجز", "Cancel booking")}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {hasMore.bookings && <div className="load-more"><button className="ghost-button" disabled={busy} onClick={() => void loadMore("bookings")}>{pick("عرض المزيد", "Load more")}</button></div>}
              {!loading && !shownBookings.length && <div className="empty-state workspace-empty"><TicketCheck size={32} /><h3>{pick("لا توجد حجوزات هنا بعد", "No bookings here yet")}</h3><p>{search || filter ? pick("جرّب تغيير البحث أو حالة الحجز.", "Try changing your search or booking status.") : pick("ستظهر طلبات الحجز هنا لتتابع تفاصيلها وحالتها.", "Booking requests will appear here, with their details and status.")}</p>{isTraveler && <button className="secondary-button" onClick={() => go("marketplace")}>{pick("اكتشف الخدمات", "Explore services")}</button>}</div>}
            </section>
          )}

          {view === "providers" && metadata && (
            <section className="work-panel">
              <div className="section-heading">
                <h2>{pick("دليل الشركات والمنشآت", "Company directory")}</h2>
                {isAdmin && (
                  <button className="secondary-button" onClick={() => setProviderEditor("new")}>
                    <Plus size={17} /> {pick("إضافة منشأة وحساب", "Add company and account")}
                  </button>
                )}
              </div>
              <div className="provider-grid">
                {providers
                  .filter((item) =>
                    matches(`${item.name} ${item.city} ${metadata.providerDefinitions[item.type].label}`)
                  )
                  .map((item) => (
                    <article className="provider-card" key={item.id}>
                      <span className="module-icon module-icon--ocean">
                        <Building2 />
                      </span>
                      <span className="eyebrow eyebrow--dark">
                        {tr(metadata.providerDefinitions[item.type].label)}
                      </span>
                      <h3>{tr(item.name)}</h3>
                      <p>
                        {tr(item.city)}{tr(" · ")}{tr(item.status === "ACTIVE" ? pick("نشطة", "Active") : pick("موقوفة", "Suspended"))}
                      </p>
                      <p>{tr(item.contactEmail)}</p>
                      <small>{pick("العروض:", "Offers:")} {item._count?.services ?? 0}</small>
                      <div className="management-actions">
                        {(isAdmin || (org?.id === item.id && user?.permissions.includes("organization.staff.manage"))) && (
                          <Link className="ghost-button" to={`/workspace/organizations/${item.id}/specialties`}>
                            {pick("الاختصاصات والأقسام والموظفون", "Specialties, departments, and staff")}
                          </Link>
                        )}
                        <button
                          className="ghost-button"
                          onClick={() => {
                            go("marketplace");
                            setSearch(item.name);
                          }}
                        >
                          {pick("عرض الخدمات", "View services")}
                        </button>
                        {isAdmin && (
                          <>
                            <button className="ghost-button" onClick={() => setProviderEditor(item)}>
                              {pick("تعديل", "Edit")}
                            </button>
                            <button
                              className="ghost-button"
                              disabled={busy}
                              onClick={() =>
                                setConfirmation({
                                  text:
                                    item.status === "ACTIVE"
                                      ? "إيقاف نشاط المنشأة وعروضها عن استقبال الطلبات الجديدة؟"
                                      : "إعادة تفعيل المنشأة؟",
                                  run: () =>
                                    api.providerStatus(
                                      item.id,
                                      item.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"
                                    )
                                })
                              }
                            >
                              {tr(item.status === "ACTIVE" ? pick("إيقاف", "Suspend") : pick("تفعيل", "Activate"))}
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
            </section>
          )}

          {view === "people" && isAdmin && (
            <section className="work-panel">
              <h2>{pick("مستخدمو مساحة العمل", "Workspace users")}</h2>
              <div className="members-list">
                {members
                  .filter((item) => matches(`${item.user.displayName} ${item.user.email}`))
                  .map((item) => (
                    <article className="member-row" key={item.id}>
                      <span className="avatar">
                        <CircleUserRound />
                      </span>
                      <div>
                        <strong>{tr(item.user.displayName)}</strong>
                        <small>{tr(item.user.email)}</small>
                      </div>
                      <span>{tr(item.jobTitle)}</span>
                      <span className="role-pill">
                        {tr(item.roles.map(({ role }) => roleNames[role.code] ?? role.name).join("، "))}
                      </span>
                      <span>{tr(item.status === "ACTIVE" ? pick("نشط", "Active") : item.status)}</span>
                    </article>
                  ))}
              </div>
            </section>
          )}
          {view === "profile" && (
            <section className="settings-grid">
              <article className="work-panel">
                <h2>{tr(org?.name ?? pick("حساب المسافر", "Traveler account"))}</h2>
                <p>{tr(user?.email)}</p>
                <dl className="details-list">
                  <div>
                    <dt>{pick("الدور", "Role")}</dt>
                    <dd>{tr(scopeLabel)}</dd>
                  </div>
                  <div>
                    <dt>{pick("مساحة العمل", "Workspace")}</dt>
                    <dd>{tr(tenant?.name)}</dd>
                  </div>
                  {org && (
                    <>
                      <div>
                        <dt>{pick("نشاط المنشأة", "Company activity")}</dt>
                        <dd>{tr(providerLabel)}</dd>
                      </div>
                      <div>
                        <dt>{pick("المدينة", "City")}</dt>
                        <dd>{tr(org.city)}</dd>
                      </div>
                      <div>
                        <dt>{pick("الهاتف", "Phone")}</dt>
                        <dd>{tr(org.phone || "غير محدد")}</dd>
                      </div>
                      <div>
                        <dt>{pick("الترخيص", "License")}</dt>
                        <dd>{tr(org.licenseNumber || "لم يضف بعد")}</dd>
                      </div>
                    </>
                  )}
                </dl>
                {org && (
                  <button className="secondary-button" onClick={() => setProviderEditor(org)}>
                    {pick("تعديل ملف المنشأة", "Edit company profile")}
                  </button>
                )}
              </article>
              <article className="work-panel">
                <h2>{pick("مهام حسابك", "Your account tasks")}</h2>
                <p className="business-description">
                  {tr(isTraveler
                    ? "تصفح السوق، حجز الخدمات والبرامج، تعديل طلباتك المعلقة وإلغاؤها ومتابعة تأكيدها."
                    : isAdmin
                      ? "إضافة منشآت وربطها بحسابات، الإشراف على الخدمات والحجوزات، وإدارة حالة تشغيل الموردين."
                      : isCompany
                        ? "إنشاء برامج العمرة والسياحة، ربط الإقامة والنقل والخدمات بالبرنامج، ومتابعة حجوزات المسافرين على برامج منشأتك."
                        : "إدارة العروض ضمن تخصص منشأتك، تحديد الأسعار والسعات، ومتابعة الطلبات الخاصة بخدمات منشأتك فقط.")}
                </p>
                <p className="form-hint">{tr(" رقم الترخيص بيانات مسجلة من المنشأة؛ لا يشير وحده إلى تحقق رسمي من الترخيص. ")}</p>
              </article>
              <SessionsPanel />
            </section>
          )}
        </main>
      </section>
      {metadata && serviceEditor && (
        <ServiceEditor
          service={serviceEditor === "new" ? undefined : serviceEditor}
          metadata={metadata}
          organizations={providers}
          marketplace={marketplace}
          onClose={() => setServiceEditor(null)}
          onSaved={saved}
        />
      )}
      {metadata && bookingEditor && (
        <BookingEditor
          {...bookingEditor}
          metadata={metadata}
          displayCurrency={displayCurrency}
          exchangeRates={exchangeRates}
          onClose={() => setBookingEditor(null)}
          onSaved={async () => {
            await saved();
            go("bookings");
          }}
        />
      )}
      {metadata && providerEditor && (
        <ProviderEditor
          organization={providerEditor === "new" ? undefined : providerEditor}
          metadata={metadata}
          onClose={() => setProviderEditor(null)}
          onSaved={saved}
        />
      )}
      {detail && metadata && (
        <Modal title={tr(detail.title)} onClose={() => setDetail(null)}>
          <p>{tr(detail.description)}</p>
          <p>
            {tr(detail.organization.name)}{tr(" · ")}{tr(detail.city)}
          </p>
          <dl className="details-list">
            {metadata.serviceDefinitions[detail.category].fields.map((field) => (
              <div key={field.key}>
                <dt>{tr(field.label)}</dt>
                <dd>{tr(detail.details[field.key] || "لم تحدد بعد")}</dd>
              </div>
            ))}
            <div>
              <dt>{tr("السعر ")}{tr(metadata.serviceDefinitions[detail.category].unit)}</dt>
              <dd>{tr(convertedMoney(detail.priceCents, detail.currency, displayCurrency, exchangeRates) ?? money(detail.priceCents, detail.currency))}
                {detail.currency !== displayCurrency && <>{tr(" · السعر الأصلي: ")}{tr(money(detail.priceCents, detail.currency))}</>}</dd>
            </div>
            <div>
              <dt>{tr("السعة لكل موعد")}</dt>
              <dd>{detail.capacity}</dd>
            </div>
          </dl>
          {detail.components.length > 0 && (
            <div className="component-list">
              <h3>{tr("مكونات البرنامج")}</h3>
              {detail.components.map((item) => (
                <p key={item.serviceId}>
                  {tr(item.service.title)}{tr(" · ")}{tr(item.service.organization.name)}
                </p>
              ))}
              <small>{tr("تُدار ترتيبات هذه الخدمات بواسطة الشركة المنظمة.")}</small>
            </div>
          )}
          {isTraveler && (
            <button
              className="primary-button"
              onClick={() => {
                setBookingEditor({ service: detail });
                setDetail(null);
              }}
            >{tr(" طلب حجز ")}</button>
          )}
        </Modal>
      )}
      {confirmation && (
        <Modal title={tr("تأكيد الإجراء")} onClose={() => setConfirmation(null)}>
          <p>{tr(confirmation.text)}</p>
          <div className="form-actions">
            <button className="ghost-button" onClick={() => setConfirmation(null)}>{tr(" رجوع ")}</button>
            <button className="primary-button" disabled={busy} onClick={() => void action(confirmation.run)}>
              {tr(busy ? "جاري التنفيذ…" : "تأكيد")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
