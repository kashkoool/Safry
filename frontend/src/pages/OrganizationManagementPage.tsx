import { useText } from "../i18n/useText";
import { useLocalizedData } from "../i18n/useLocalizedData";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Building2, Layers3, Plus, RefreshCw, ShieldCheck, UsersRound } from "lucide-react";
import { currentLocale } from "../i18n/locale";
import { useAuth } from "../auth/auth-context";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../i18n/LanguageSwitch";
import { useLanguage } from "../i18n/useLanguage";
import { Modal } from "../components/BusinessForms";
import { organizationApi, type Department, type Employee, type OrganizationManagement } from "../lib/organization";
import "./organization-management.css";

const sections = [
  ["specialties", "اختصاصات الشركة"],
  ["departments", "الأقسام"],
  ["roles", "الأدوار والصلاحيات"],
  ["employees", "الموظفون والصلاحيات"]
] as const;
const permissionLabels = [
  ["catalog.service.read", "عرض الخدمات"],
  ["catalog.service.manage", "إدارة الخدمات"],
  ["booking.read", "عرض الحجوزات"],
  ["booking.manage", "إدارة الحجوزات"]
] as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : "تعذر تنفيذ العملية";

export function OrganizationManagementPage() {
  const tr = useText();
  const { pick } = useLanguage();
  const { user } = useAuth();
  const { organizationId, section } = useParams();
  const [rawData, setData] = useState<OrganizationManagement | null>(null);
  const data = useLocalizedData(rawData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tick, setTick] = useState(0);
  const [specialties, setSpecialties] = useState("");
  const [departmentForm, setDepartmentForm] = useState({ code: "", name: "" });
  const [departmentEditor, setDepartmentEditor] = useState<Department | null>(null);
  const [employeeEditor, setEmployeeEditor] = useState<Employee | "new" | null>(null);
  const [roleEditor, setRoleEditor] = useState<OrganizationManagement["organizationRoles"][number] | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!organizationId || !sections.some(([slug]) => slug === section)) return;
    let live = true;
    organizationApi.overview(organizationId)
      .then((result) => {
        if (!live) return;
        setData(result);
        setSpecialties(result.organization.specialties.join("، "));
        setError("");
      })
      .catch((reason) => { if (live) setError(errorText(reason)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [organizationId, section, tick]);

  if (!user) return <Navigate to="/login" replace />;
  if (!organizationId) return <Navigate to="/workspace/providers" replace />;
  if (!sections.some(([slug]) => slug === section))
    return <Navigate to={`/workspace/organizations/${organizationId}/specialties`} replace />;

  async function act(work: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      setMessage(success);
      setTick((value) => value + 1);
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="org-management">
      <header className="org-management__header">
        <Brand compact />
        <div className="org-management__header-copy">
          <span className="eyebrow eyebrow--dark"><Building2 size={16} /> {pick("إدارة المنشأة", "Company management")}</span>
          <h1>{tr(data?.organization.name ?? pick("تنظيم الشركة", "Company organization"))}</h1>
          <p>{pick("اختصاصات واضحة، أقسام محددة، وموظفون بصلاحيات مناسبة لمهامهم.", "Define specialties and departments, then give staff permissions suited to their work.")}</p>
        </div>
        <div className="org-management__header-actions">
          <LanguageSwitch />
          <Link className="ghost-button" to="/workspace/providers"><ArrowLeft size={17} />{pick("العودة إلى المنشآت", "Back to companies")}</Link>
        </div>
      </header>
      {data && <div className="org-management__summary" aria-label={pick("ملخص المنشأة", "Company overview")}>
        <article><span className="org-management__summary-icon"><Layers3 size={21} /></span><div><span>{pick("الأقسام النشطة", "Active departments")}</span><strong>{data.departments.filter((department) => department.active).length.toLocaleString(currentLocale())}</strong></div></article>
        <article><span className="org-management__summary-icon"><UsersRound size={21} /></span><div><span>{pick("الموظفون النشطون", "Active employees")}</span><strong>{data.employees.filter((employee) => employee.status === "ACTIVE").length.toLocaleString(currentLocale())}</strong></div></article>
        <article><span className="org-management__summary-icon"><ShieldCheck size={21} /></span><div><span>{pick("أدوار الشركة", "Company roles")}</span><strong>{data.organizationRoles.length.toLocaleString(currentLocale())}</strong></div></article>
      </div>}
      <nav className="org-management__nav" aria-label={pick("أقسام المنشأة", "Company sections")}>
        {sections.map(([slug, label]) => (
          <Link key={slug} className={section === slug ? "active" : ""}
            aria-current={section === slug ? "page" : undefined}
            to={`/workspace/organizations/${organizationId}/${slug}`}>{tr(pick(label, ({ specialties: "Specialties", departments: "Departments", roles: "Roles and permissions", employees: "Staff and permissions" } as Record<string, string>)[slug] ?? label))}</Link>
        ))}
      </nav>
      {tr(error && <p className="form-error" role="alert">{tr(error)}</p>)}
      {tr(message && <p className="workspace-alert" role="status">{tr(message)}</p>)}
      {loading && <p role="status">{pick("جاري تحميل بيانات الشركة…", "Loading company data…")}</p>}
      {data && <section className="work-panel org-management__panel">
        {section === "specialties" && <>
          <h2>{pick("اختصاصات الشركة", "Company specialties")}</h2>
          <p className="form-hint">{pick("اكتب اختصاصات الشركة مفصولة بفاصلة أو بسطر جديد. مثال: برامج العمرة، الإقامة، النقل.", "Separate specialties with commas or new lines. For example: Umrah, accommodation, transport.")}</p>
          <form className="org-management__form" onSubmit={(event) => {
            event.preventDefault();
            void act(() => organizationApi.specialties(organizationId,
              specialties.split(/[,،\n]/).map((value) => value.trim()).filter(Boolean)), "حُفظت الاختصاصات");
          }}>
            <textarea aria-label={tr("اختصاصات الشركة")} value={specialties} onChange={(event) => setSpecialties(event.target.value)} rows={5} />
            <button className="secondary-button" disabled={busy}>{pick("حفظ الاختصاصات", "Save specialties")}</button>
          </form>
          <div className="org-management__tags">{data.organization.specialties.map((item) => <span key={item}>{tr(item)}</span>)}</div>
        </>}
        {section === "departments" && <>
          <div className="org-management__heading"><div><span className="org-management__kicker">{pick("هيكل المنشأة", "COMPANY STRUCTURE")}</span><h2>{pick("أقسام الشركة", "Company departments")}</h2></div><small className="org-management__count">{pick("الأقسام", "Departments")}: {data.departments.length.toLocaleString(currentLocale())}</small></div>
          <form className="org-management__form org-management__form--row" onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await organizationApi.createDepartment(organizationId, departmentForm);
              setDepartmentForm({ code: "", name: "" });
            }, "أُضيف القسم");
          }}>
            <label>{tr("رمز القسم")}<input value={departmentForm.code} required pattern="[a-z][a-z0-9-]+" placeholder={tr("bookings")}
              onChange={(event) => setDepartmentForm({ ...departmentForm, code: event.target.value })} /></label>
            <label>{tr("اسم القسم")}<input value={departmentForm.name} required minLength={2} placeholder={tr("إدارة الحجوزات")}
              onChange={(event) => setDepartmentForm({ ...departmentForm, name: event.target.value })} /></label>
            <button className="secondary-button" disabled={busy}><Plus size={16} />{tr(" إضافة قسم")}</button>
          </form>
          <div className="org-management__cards">{data.departments.map((department) => <article key={department.id}>
            <span className="org-management__card-icon"><Layers3 size={21} /></span>
            <h3>{tr(department.name)}</h3><small><bdi>{department.code}</bdi> · {pick("عدد الموظفين", "Employees")}: {department._count.members.toLocaleString(currentLocale())}</small>
            <span className={`org-management__status ${department.active ? "" : "is-inactive"}`}>{tr(department.active ? "نشط" : "موقوف")}</span>
            <div><button className="ghost-button" onClick={() => setDepartmentEditor(department)}>{tr("تعديل الاسم")}</button>
              <button className="ghost-button" disabled={busy} onClick={() => void act(() => organizationApi.updateDepartment(
                organizationId, department.id, { active: !department.active }), "حُدثت حالة القسم")}>{tr(department.active ? "إيقاف" : "تفعيل")}</button></div>
          </article>)}</div>
          {!data.departments.length && <p className="empty-state">{tr("أضف أول قسم لتبدأ بتوزيع الموظفين.")}</p>}
        </>}
        {section === "roles" && <>
          <div className="org-management__heading"><div><h2>{pick("أدوار الشركة", "Company roles")}</h2>
            <p className="form-hint">{pick("أنشئ دوراً لموظفي هذه الشركة فقط، وحدد صلاحيات الخدمات والحجوزات التي يحتاجها.", "Create roles for this company's staff only, with the service and booking permissions they need.")}</p></div>
            <button className="secondary-button" onClick={() => setRoleEditor("new")}><Plus size={16} /> {pick("دور جديد", "New role")}</button></div>
          <div className="org-management__cards">{data.organizationRoles.map((role) => <article key={role.id}>
            <span className="org-management__card-icon"><ShieldCheck size={21} /></span>
            <h3>{tr(role.name)}</h3><small>{tr(role.code)}</small>
            <p>{tr(role.permissions.length ? role.permissions.map((code) => permissionLabels.find(([key]) => key === code)?.[1] ?? code).join("، ") : "دور بلا صلاحيات تشغيلية")}</p>
            <button className="ghost-button" onClick={() => setRoleEditor(role)}>{tr("تعديل الدور")}</button>
          </article>)}</div>
          {!data.organizationRoles.length && <p className="empty-state">{tr("لا توجد أدوار خاصة بهذه الشركة بعد. يمكنك إنشاء أول دور الآن.")}</p>}
        </>}
        {section === "employees" && <>
          <div className="org-management__heading"><div><h2>{pick("الموظفون والصلاحيات", "Staff and permissions")}</h2><p className="form-hint">{pick("كل موظف يرتبط بقسم ودور، ويمكن تقييد صلاحياته بشكل فردي.", "Each employee has a department and role, with optional individual permission overrides.")}</p></div>
            <button className="secondary-button" onClick={() => setEmployeeEditor("new")} disabled={!data.departments.some((item) => item.active)}
              aria-describedby={!data.departments.some((item) => item.active) ? "employee-department-required" : undefined}>
              <Plus size={16} /> {pick("موظف جديد", "New employee")}</button></div>
          {!data.departments.some((item) => item.active) && <div className="org-management__setup" id="employee-department-required">
            <Layers3 size={22} />
            <div><strong>{pick("ابدأ بإضافة قسم للشركة", "Start with a company department")}</strong>
              <p>{pick("يلزم وجود قسم نشط قبل إضافة الموظفين وتحديد مسؤولياتهم. أضف قسماً جديداً أو فعّل قسماً موجوداً.", "An active department is needed before adding employees and assigning responsibilities. Create a department or activate an existing one.")}</p></div>
            <Link className="ghost-button" to={`/workspace/organizations/${organizationId}/departments`}>{pick("إدارة الأقسام", "Manage departments")}</Link>
          </div>}
          <p className="form-hint">{tr("هذه قائمة موظفي منشأتك فقط. الإيقاف مؤقت ويمكن التراجع عنه؛ إلغاء العضوية يقطع وصول الموظف إلى المنشأة، مع الاحتفاظ بسجل أعماله وحجوزاته.")}</p>
          <div className="org-management__cards">{data.employees.map((employee) => <article key={employee.id}>
            <span className="org-management__card-icon"><UsersRound size={21} /></span><h3>{tr(employee.user.displayName)}</h3>
            <small><bdi>{employee.user.email}</bdi></small>
            <p>{tr(data.departments.find((item) => item.id === employee.departmentId)?.name ?? "غير مرتبط بقسم")}{tr(" · ")}{tr(employee.jobTitle ?? "بدون مسمى")}</p>
            <small>{tr(employee.roles.map((item) => tr(item.role.name)).join("، ") || "بانتظار تحديد الدور")}</small>
            <span className={`org-management__status ${employee.status === "ACTIVE" ? "" : "is-inactive"}`}>{tr(employee.status === "ACTIVE" ? "نشط" : employee.status === "INVITED" ? "طلب انضمام بانتظار الموافقة" : employee.status === "REVOKED" ? "ملغى" : "موقوف مؤقتاً")}</span>
            {!employee.roles.some((item) => ["organization-manager", "tenant-admin"].includes(item.role.code)) &&
              <div><button className="ghost-button" onClick={() => setEmployeeEditor(employee)}>{tr("تعديل المهام والصلاحيات")}</button>
                {employee.status === "ACTIVE" && <button className="ghost-button" disabled={busy} onClick={() => void act(
                  () => organizationApi.updateEmployee(organizationId, employee.id, { status: "SUSPENDED" }), "أُوقف الموظف وأُنهِيت جلساته")}>{tr("إيقاف مؤقت")}</button>}
                {employee.status === "SUSPENDED" && <button className="ghost-button" disabled={busy} onClick={() => void act(
                  () => organizationApi.updateEmployee(organizationId, employee.id, { status: "ACTIVE" }), "أُعيد تفعيل الموظف")}>{tr("إعادة التفعيل")}</button>}
                {employee.status !== "REVOKED" && <button className="ghost-button org-management__danger" disabled={busy} onClick={() => {
                  if (window.confirm(pick(`إلغاء عضوية ${employee.user.displayName} في هذه المنشأة؟ سيُمنع من الدخول فوراً وستبقى سجلاته محفوظة.`, `Revoke ${employee.user.displayName}'s membership? Access will end immediately and records will be retained.`)))
                    void act(() => organizationApi.updateEmployee(organizationId, employee.id, { status: "REVOKED" }), "أُلغيت عضوية الموظف وأُنهِيت جلساته");
                }}>{tr("إلغاء العضوية")}</button>}
              </div>}
          </article>)}</div>
          {!data.employees.length && <p className="empty-state">{tr("لا يوجد موظفون بعد.")}</p>}
        </>}
        <button className="ghost-button org-management__refresh" onClick={() => setTick((value) => value + 1)}><RefreshCw size={16} />{tr(" تحديث")}</button>
      </section>}
      {departmentEditor && <DepartmentEditor department={departmentEditor} onClose={() => setDepartmentEditor(null)}
        onSave={async (name) => {
          if (await act(() => organizationApi.updateDepartment(organizationId, departmentEditor.id, { name }), "حُفظ اسم القسم"))
            setDepartmentEditor(null);
        }} />}
      {employeeEditor && data && <EmployeeEditor key={employeeEditor === "new" ? "new" : employeeEditor.id}
        organizationId={organizationId} data={data} employee={employeeEditor === "new" ? undefined : employeeEditor}
        onClose={() => setEmployeeEditor(null)} onSaved={() => { setEmployeeEditor(null); setMessage("حُفظت بيانات الموظف وأُنهِيت جلساته القديمة"); setTick((value) => value + 1); }} />}
      {roleEditor && <RoleEditor key={roleEditor === "new" ? "new" : roleEditor.id}
        role={roleEditor === "new" ? undefined : roleEditor} onClose={() => setRoleEditor(null)}
        onSave={async (input) => {
          const saved = await act(() => roleEditor === "new" ? organizationApi.createRole(organizationId, input) :
            organizationApi.updateRole(organizationId, roleEditor.id, { name: input.name, permissions: input.permissions }),
          "حُفظ الدور وصلاحياته");
          if (saved) setRoleEditor(null);
        }} />}
    </main>
  );
}

function RoleEditor({ role, onClose, onSave }: {
  role?: OrganizationManagement["organizationRoles"][number]; onClose: () => void;
  onSave: (input: { code: string; name: string; permissions: string[] }) => Promise<void>;
}) {
  const tr = useText();
  const [code, setCode] = useState(role?.code ?? "");
  const [name, setName] = useState(role?.name ?? "");
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  return <Modal title={tr(role ? "تعديل دور الشركة" : "إنشاء دور للشركة")} onClose={onClose}>
    <form className="business-form" onSubmit={(event) => { event.preventDefault(); void onSave({ code, name, permissions }); }}>
      {!role && <label>{tr("رمز الدور")}<input required pattern="[a-z][a-z0-9-]+" minLength={2} maxLength={40}
        value={code} onChange={(event) => setCode(event.target.value)} placeholder={tr("booking-agent")} /></label>}
      <label>{tr("اسم الدور")}<input required minLength={2} maxLength={160} value={name}
        onChange={(event) => setName(event.target.value)} placeholder={tr("موظف الحجوزات")} /></label>
      <fieldset className="org-management__wide"><legend>{tr("صلاحيات الدور")}</legend>
        {permissionLabels.map(([key, label]) => <label key={key}><input type="checkbox" checked={permissions.includes(key)}
          onChange={(event) => setPermissions(event.target.checked ? [...permissions, key] : permissions.filter((item) => item !== key))} /> {tr(label)}</label>)}
      </fieldset>
      <button className="secondary-button org-management__wide">{tr("حفظ الدور")}</button>
    </form>
  </Modal>;
}

function DepartmentEditor({ department, onClose, onSave }: { department: Department; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const tr = useText();
  const [name, setName] = useState(department.name);
  return <Modal title={tr("تعديل القسم")} onClose={onClose}><form className="business-form" onSubmit={(event) => {
    event.preventDefault(); void onSave(name);
  }}><label>{tr("اسم القسم")}<input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <button className="secondary-button">{tr("حفظ")}</button></form></Modal>;
}

function EmployeeEditor({ organizationId, data, employee, onClose, onSaved }: {
  organizationId: string; data: OrganizationManagement; employee?: Employee; onClose: () => void; onSaved: () => void;
}) {
  const tr = useText();
  const [form, setForm] = useState({
    email: employee?.user.email ?? "", displayName: employee?.user.displayName ?? "", password: "",
    jobTitle: employee?.jobTitle ?? "", departmentId: employee?.departmentId ?? data.departments.find((item) => item.active)?.id ?? "",
    roleIds: employee?.roles.map((item) => item.role.id) ?? [] as string[],
    permissionOverrides: employee?.permissionOverrides ?? {} as Record<string, boolean>,
    status: employee?.status === "SUSPENDED" ? "SUSPENDED" : employee?.status === "REVOKED" ? "REVOKED" : "ACTIVE" as "ACTIVE" | "SUSPENDED" | "REVOKED"
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      if (!form.roleIds.length) throw new Error("اختر دوراً واحداً على الأقل");
      if (employee) await organizationApi.updateEmployee(organizationId, employee.id, {
        jobTitle: form.jobTitle, departmentId: form.departmentId, roleIds: form.roleIds,
        permissionOverrides: form.permissionOverrides, status: form.status
      });
      else await organizationApi.createEmployee(organizationId, {
        email: form.email, displayName: form.displayName, password: form.password,
        jobTitle: form.jobTitle, departmentId: form.departmentId, roleIds: form.roleIds,
        permissionOverrides: form.permissionOverrides
      });
      onSaved();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  return <Modal title={tr(employee?.status === "INVITED" ? "قبول طلب انضمام الموظف" : employee ? "تعديل الموظف وصلاحياته" : "إضافة موظف")} onClose={onClose}>
    <form className="business-form org-management__employee-form" onSubmit={(event) => void submit(event)}>
      {!employee && <><label>{tr("اسم الموظف")}<input required minLength={2} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
        <label>{tr("البريد الإلكتروني")}<input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label>{tr("كلمة مرور أولية")}<input type="password" required minLength={12} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label></>}
      <label>{tr("المسمى الوظيفي")}<input required minLength={2} value={form.jobTitle} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} /></label>
      <label>{tr("القسم")}<select required value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>
        <option value="">{tr("اختر القسم")}</option>{data.departments.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{tr(item.name)}</option>)}</select></label>
      {employee && <label>{tr("الحالة")}<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as "ACTIVE" | "SUSPENDED" | "REVOKED" })}>
        <option value="ACTIVE">{tr("نشط")}</option><option value="SUSPENDED">{tr("موقوف مؤقتاً")}</option><option value="REVOKED">{tr("عضوية ملغاة")}</option></select></label>}
      <fieldset className="org-management__wide"><legend>{tr("الأدوار التشغيلية")}</legend>{data.assignableRoles.map((role) => <label key={role.id}>
        <input type="checkbox" checked={form.roleIds.includes(role.id)} onChange={(event) => setForm({ ...form,
          roleIds: event.target.checked ? [...form.roleIds, role.id] : form.roleIds.filter((id) => id !== role.id) })} /> {tr(role.name)}</label>)}</fieldset>
      <fieldset className="org-management__wide"><legend>{tr("استثناءات الصلاحيات")}</legend><p className="form-hint">{tr("«حسب الدور» يستخدم صلاحيات الدور. المنع أو السماح يطبّق على هذا الموظف فقط.")}</p>
        {permissionLabels.map(([code, label]) => <label key={code}>{tr(label)}<select value={form.permissionOverrides[code] === undefined ? "inherit" : form.permissionOverrides[code] ? "allow" : "deny"}
          onChange={(event) => { const next = { ...form.permissionOverrides }; if (event.target.value === "inherit") delete next[code]; else next[code] = event.target.value === "allow";
            setForm({ ...form, permissionOverrides: next }); }}><option value="inherit">{tr("حسب الدور")}</option><option value="allow">{tr("سماح")}</option><option value="deny">{tr("منع")}</option></select></label>)}</fieldset>
      {tr(error && <p className="form-error org-management__wide" role="alert">{tr(error)}</p>)}
      <button className="secondary-button org-management__wide" disabled={busy}>{tr(busy ? "جاري الحفظ…" : "حفظ الموظف")}</button>
    </form>
  </Modal>;
}
