import { useText } from "../i18n/useText";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useLanguage } from "../i18n/useLanguage";
import { englishCurrencyNames } from "../i18n/labels";
import { minorToDecimal, toMinorUnits } from "../lib/minor-units";
import {
  api,
  ApiError,
  type Booking,
  type ExchangeRates,
  type Organization,
  type ProviderInput,
  type ProviderType,
  type ServiceCategory,
  supportedCurrencies,
  currencyNames,
  type SupportedCurrency,
  type TravelService,
  type WorkspaceMetadata
} from "../lib/api";

import { convertedMoney, money } from "../lib/format";
const today = (): string => new Date().toISOString().slice(0, 10);

export function Modal({
  title,
  onClose,
  children
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="business-dialog"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-label={tr(title)}
    >
      <header>
        <h2>{tr(title)}</h2>
        <button className="icon-button" aria-label={pick("إغلاق", "Close")} onClick={onClose}>
          <X />
        </button>
      </header>
      {tr(children)}
    </dialog>
  );
}
function Feedback({ error }: { error: string }) {
  const tr = useText();
  return error ? (
    <p role="alert" className="form-error">
      {tr(error)}
    </p>
  ) : null;
}
const errorText = (reason: unknown): string => (reason instanceof Error ? reason.message : "تعذر الحفظ");

export function ServiceEditor({
  service,
  metadata,
  organizations,
  marketplace,
  onClose,
  onSaved
}: {
  service?: TravelService;
  metadata: WorkspaceMetadata;
  organizations: Organization[];
  marketplace: TravelService[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const [orgId, setOrgId] = useState(
    service?.organization.id ??
      metadata.organization?.id ??
      organizations.find((item) => item.status === "ACTIVE")?.id ??
      ""
  );
  const organization = organizations.find((item) => item.id === orgId) ?? metadata.organization;
  const categories = organization ? metadata.providerDefinitions[organization.type].categories : [];
  const [category, setCategory] = useState<ServiceCategory>(service?.category ?? categories[0] ?? "OTHER");
  const [form, setForm] = useState({
    title: service?.titleAr ?? service?.title ?? "",
    titleEn: service?.titleEn ?? "",
    city: service?.cityAr ?? service?.city ?? organization?.city ?? "",
    cityEn: service?.cityEn ?? "",
    description: service?.descriptionAr ?? service?.description ?? "",
    descriptionEn: service?.descriptionEn ?? "",
    price: service?.priceCents ? minorToDecimal(service.priceCents, service.currency) : "",
    currency: service?.currency ?? "SAR" as SupportedCurrency,
    capacity: String(service?.capacity ?? 20)
  });
  const [details, setDetails] = useState<Record<string, string>>(service?.detailsAr ?? service?.details ?? {});
  const [detailsEn, setDetailsEn] = useState<Record<string, string>>(service?.detailsEn ?? {});
  const [componentIds, setComponentIds] = useState(service?.components.map((item) => item.serviceId) ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const definition = metadata.serviceDefinitions[category];
  const packageMode = ["UMRAH", "PACKAGE"].includes(category);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const input = {
        title: form.title,
        titleEn: form.titleEn,
        descriptionEn: form.descriptionEn,
        cityEn: form.cityEn,
        detailsEn,
        city: form.city,
        description: form.description,
        category,
        priceCents: toMinorUnits(form.price, form.currency),
        currency: form.currency,
        capacity: Number(form.capacity),
        details,
        componentIds: packageMode ? componentIds : []
      };
      if (service) await api.updateService(service.id, input);
      else await api.createService({ ...input, providerOrganizationId: orgId });
      await onSaved();
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={tr(service ? pick("تعديل الخدمة", "Edit service") : pick("إضافة خدمة أو برنامج", "Add service or package"))} onClose={onClose}>
      <form className="business-form" onSubmit={submit}>
        {!metadata.organization && !service && (
          <label>
            {pick("المنشأة المسؤولة", "Responsible company")}
            <select
              value={orgId}
              required
              onChange={(e) => {
                setOrgId(e.target.value);
                const org = organizations.find((item) => item.id === e.target.value);
                if (!org) return; // the list changed between render and event: keep the form as it is
                const firstCategory = metadata.providerDefinitions[org.type].categories[0];
                if (!firstCategory) return;
                setCategory(firstCategory);
                setDetails({});
                setDetailsEn({});
                setComponentIds([]);
              }}
            >
              {organizations
                .filter((item) => item.status === "ACTIVE")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {tr(item.name)}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          {pick("نوع الخدمة", "Service type")}
          <select
            value={category}
            disabled={Boolean(service)}
            onChange={(e) => {
              setCategory(e.target.value as ServiceCategory);
              setDetails({});
              setDetailsEn({});
              setComponentIds([]);
            }}
          >
            {[...new Set([...categories, ...(service ? [service.category] : [])])].map((item) => (
              <option key={item} value={item}>
                {tr(metadata.serviceDefinitions[item].label)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {pick("اسم العرض بالعربية", "Offer name in Arabic")}
          <input
            value={form.title}
            dir="rtl" lang="ar"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
            minLength={3}
            maxLength={200}
          />
        </label>
        <label>
          {pick("المدينة بالعربية", "City in Arabic")}
          <input
            value={form.city}
            dir="rtl" lang="ar"
            onChange={(e) => setForm({ ...form, city: e.target.value })}
            required
            minLength={2}
            maxLength={120}
          />
        </label>
        <label>
          {pick("السعر الأصلي", "Original price")} {tr(definition.unit)}
          <input
            type="number"
            min="1"
            max="1000000"
            step="0.01"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            required
          />
        </label>
        <label>{pick("عملة السعر الأصلي", "Original currency")}<select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as SupportedCurrency })}>
          {supportedCurrencies.map((code) => <option key={code} value={code}>{tr(pick(currencyNames[code], englishCurrencyNames[code]))}{tr(" (")}{tr(code)}{tr(")")}</option>)}
        </select></label>
        <label>
          {tr(category === "HOTEL"
            ? pick("عدد الغرف المتاحة يومياً", "Rooms available per day")
            : category === "TRANSPORT"
              ? pick("عدد المركبات المتاحة يومياً", "Vehicles available per day")
              : pick("السعة المتاحة لكل موعد", "Capacity per date"))}
          <input
            type="number"
            min="1"
            max="100000"
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            required
          />
        </label>
        <label className="full-width">
          {pick("وصف العرض بالعربية", "Offer description in Arabic")}
          <textarea
            value={form.description}
            dir="rtl" lang="ar"
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            required
            minLength={10}
            maxLength={1000}
          />
        </label>
        <p className="full-width form-hint">{pick("أضف النص الإنجليزي لعرض خدمتك بوضوح عند تبديل اللغة. إذا تركته فارغاً سيظهر النص العربي.", "Add English content so your service reads naturally in both languages. Empty translations will display the Arabic original.")}</p>
        <label>{pick("اسم العرض بالإنجليزية", "Offer name in English")}<input dir="ltr" lang="en" maxLength={200} value={form.titleEn} onChange={e => setForm({ ...form, titleEn: e.target.value })} /></label>
        <label>{pick("المدينة بالإنجليزية", "City in English")}<input dir="ltr" maxLength={120} value={form.cityEn} onChange={e => setForm({ ...form, cityEn: e.target.value })} /></label>
        <label className="full-width">{pick("وصف العرض بالإنجليزية", "Offer description in English")}<textarea dir="ltr" maxLength={1000} value={form.descriptionEn} onChange={e => setForm({ ...form, descriptionEn: e.target.value })} /></label>
        <h3 className="full-width">{pick("تفاصيل", "Details:")} {tr(definition.label)}</h3>
        {definition.fields.map((field) => (
          <label key={field.key}>
            {tr(field.label)}
            <input
              type={field.type ?? "text"}
              required={field.required}
              min={field.type === "number" ? 1 : undefined}
              max={field.type === "number" ? 1000 : undefined}
              maxLength={1000}
              value={details[field.key] ?? ""}
              onChange={(e) => setDetails({ ...details, [field.key]: e.target.value })}
            />
          </label>
        ))}
        {definition.fields.filter(field => !field.type).map(field => <label key={`en-${field.key}`}>
          {tr(field.label)} — {pick("بالإنجليزية", "in English")}
          <input dir="ltr" maxLength={1000} value={detailsEn[field.key] ?? ""} onChange={e => setDetailsEn({ ...detailsEn, [field.key]: e.target.value })} />
        </label>)}
        {packageMode && (
          <fieldset className="full-width component-picker">
            <legend>{pick("الخدمات المرتبطة بالبرنامج", "Services linked to this package")}</legend>
            <p>
              {pick("حدد الفندق والنقل والخدمات المشمولة. هذا الربط يصف مكونات البرنامج؛ تأكيد حجز البرنامج لا يحجز مخزون الموردين تلقائياً.", "Choose included hotels, transport, and services. Linking them describes the package; confirming a package booking does not automatically reserve supplier inventory.")}
            </p>
            {marketplace
              .filter((item) => !["UMRAH", "PACKAGE"].includes(item.category) && item.id !== service?.id)
              .map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={componentIds.includes(item.id)}
                    onChange={(e) =>
                      setComponentIds(
                        e.target.checked
                          ? [...componentIds, item.id]
                          : componentIds.filter((id) => id !== item.id)
                      )
                    }
                  />
                  <span>
                    {tr(item.title)}
                    <small>{tr(item.organization.name)}</small>
                  </span>
                </label>
              ))}
          </fieldset>
        )}
        <div className="full-width">
          <Feedback error={error} />
        </div>
        <div className="form-actions full-width">
          <button type="button" className="ghost-button" onClick={onClose}>
            {pick("رجوع", "Back")}
          </button>
          <button className="primary-button" disabled={saving}>
            {tr(saving ? pick("جاري الحفظ…", "Saving…") : pick("حفظ العرض", "Save offer"))}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function BookingEditor({
  service,
  booking,
  metadata,
  displayCurrency,
  exchangeRates,
  onClose,
  onSaved
}: {
  service: TravelService;
  booking?: Booking;
  metadata: WorkspaceMetadata;
  displayCurrency: SupportedCurrency;
  exchangeRates: ExchangeRates | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const [form, setForm] = useState({
    travelersCount: String(booking?.travelersCount ?? 1),
    units: String(booking?.units ?? 1),
    serviceDate: booking?.serviceDate?.slice(0, 10) ?? service.details.departureDate ?? today(),
    endDate: booking?.endDate?.slice(0, 10) ?? "",
    notes: booking?.notes ?? ""
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // One Idempotency-Key per user action: reused when the same booking is re-submitted after a lost response,
  // replaced when the payload changes or the server rejected the request outright (4xx).
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const hotel = service.category === "HOTEL";
  const byUnit = hotel || service.category === "TRANSPORT";
  const nights = hotel
    ? Math.max(0, (Date.parse(form.endDate) - Date.parse(form.serviceDate)) / 86400000)
    : 1;
  const total =
    (booking?.unitPriceCents ?? service.priceCents) *
    Number(byUnit ? form.units : form.travelersCount) *
    nights;
  const originalCurrency = booking?.currency ?? service.currency;
  const unitPrice = booking?.unitPriceCents ?? service.priceCents;
  const definition = metadata.serviceDefinitions[service.category];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const input = {
        travelersCount: +form.travelersCount,
        units: byUnit ? +form.units : +form.travelersCount,
        serviceDate: form.serviceDate,
        ...(hotel ? { endDate: form.endDate } : {}),
        notes: form.notes
      };
      if (booking) await api.updateBooking(booking.id, input);
      else {
        const body = { serviceId: service.id, ...input };
        const payload = JSON.stringify(body);
        if (attempt.current?.payload !== payload) attempt.current = { key: crypto.randomUUID(), payload };
        await api.createBooking(body, attempt.current.key);
      }
      await onSaved();
      onClose();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && reason.status !== 429)
        attempt.current = null;
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={tr(`${booking ? pick("تعديل حجز", "Edit booking") : pick("حجز", "Book")} ${service.title}`)} onClose={onClose}>
      <form className="business-form" onSubmit={submit}>
        <p className="full-width form-hint">
          {pick("مقدم الخدمة:", "Provider:")} {tr(service.organization.name)}{tr(" · ")}{tr(convertedMoney(unitPrice, originalCurrency, displayCurrency, exchangeRates) ?? money(unitPrice, originalCurrency))}{tr(" ")}
          {tr(definition.unit)}
        </p>
        <label>
          {tr(definition.dateLabel)}
          <input
            type="date"
            required
            min={today()}
            value={form.serviceDate}
            onChange={(e) => setForm({ ...form, serviceDate: e.target.value })}
            readOnly={service.category === "FLIGHT" && Boolean(service.details.departureDate)}
          />
        </label>
        {hotel && (
          <label>
            {pick("تاريخ المغادرة", "Departure date")}
            <input
              type="date"
              required
              min={form.serviceDate}
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
          </label>
        )}
        <label>
          {pick("عدد المسافرين", "Number of travelers")}
          <input
            type="number"
            min="1"
            max="20"
            required
            value={form.travelersCount}
            onChange={(e) => setForm({ ...form, travelersCount: e.target.value })}
          />
        </label>
        {byUnit && (
          <label>
            {tr(hotel ? pick("عدد الغرف", "Number of rooms") : pick("عدد المركبات", "Number of vehicles"))}
            <input
              type="number"
              min="1"
              max="20"
              required
              value={form.units}
              onChange={(e) => setForm({ ...form, units: e.target.value })}
            />
          </label>
        )}
        <label className="full-width">
          {pick("ملاحظات", "Notes")}
          <textarea
            maxLength={1000}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </label>
        <div className="quote-total full-width">
          <span>{tr(hotel ? pick(`${Number.isFinite(nights) ? nights : 0} ليالٍ · الإجمالي`, `${Number.isFinite(nights) ? nights : 0} nights · total`) : pick("الإجمالي", "Total"))}</span>
          <strong>{tr(Number.isFinite(total) && total > 0 ?
            (convertedMoney(total, originalCurrency, displayCurrency, exchangeRates) ?? money(total, originalCurrency)) : pick("حدد المواعيد", "Choose dates"))}</strong>
        </div>
        <p className="full-width form-hint">
          {pick("قيمة الطلب المسجلة:", "Recorded booking value:")} {tr(Number.isFinite(total) && total > 0 ? money(total, originalCurrency) : pick("تُحسب بعد تحديد الموعد", "Calculated after dates are chosen"))}{tr(". ")}{tr(originalCurrency !== displayCurrency && pick(" السعر بالعملة المختارة للعرض التقريبي فقط.", " The selected display currency is approximate only."))}
          {tr(" ")}{pick("يُرسل الطلب للمورد للتأكيد وتُحجز السعة عند تقديم الطلب. لا يتم تحصيل دفعة إلكترونية حالياً.", "The request is sent to the provider for confirmation, and capacity is reserved when submitted. No online payment is collected yet.")}
        </p>
        <div className="full-width">
          <Feedback error={error} />
        </div>
        <div className="form-actions full-width">
          <button className="ghost-button" type="button" onClick={onClose}>
            {pick("رجوع", "Back")}
          </button>
          <button className="primary-button" disabled={saving}>
            {tr(saving ? pick("جاري الحفظ…", "Saving…") : pick("حفظ طلب الحجز", "Save booking request"))}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ProviderEditor({
  organization,
  metadata,
  onClose,
  onSaved
}: {
  organization?: Organization;
  metadata: WorkspaceMetadata;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const [form, setForm] = useState<ProviderInput>({
    name: organization?.name ?? "",
    nameAr: organization?.nameAr || organization?.name || "",
    nameEn: organization?.nameEn ?? "",
    type: organization?.type ?? "UMRAH_COMPANY",
    city: organization?.city ?? "",
    contactEmail: organization?.contactEmail ?? "",
    phone: organization?.phone ?? "",
    licenseNumber: organization?.licenseNumber ?? "",
    password: ""
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (organization)
        await api.updateProvider(organization.id, {
          name: form.name,
          nameAr: form.nameAr,
          nameEn: form.nameEn,
          city: form.city,
          phone: form.phone,
          licenseNumber: form.licenseNumber
        });
      else await api.createProvider(form);
      await onSaved();
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={tr(organization ? pick("تعديل بيانات المنشأة", "Edit company details") : pick("إضافة منشأة وحساب مسؤولها", "Add company and manager account"))} onClose={onClose}>
      <form className="business-form" onSubmit={submit}>
        <label>
          {tr("اسم الشركة بالعربية")}
          <input
            required
            minLength={3}
            maxLength={200}
            dir="rtl" lang="ar"
            value={form.nameAr}
            onChange={(e) => setForm({ ...form, name: e.target.value, nameAr: e.target.value })}
          />
        </label>
        <label>{tr("اسم الشركة بالإنجليزية")}<input required minLength={3} maxLength={200} dir="ltr" lang="en"
          value={form.nameEn} onChange={(event) => setForm({ ...form, nameEn: event.target.value })} /></label>
        <label>
          {pick("نوع النشاط", "Business type")}
          <select
            value={form.type}
            disabled={Boolean(organization)}
            onChange={(e) => setForm({ ...form, type: e.target.value as ProviderType })}
          >
            {Object.entries(metadata.providerDefinitions).map(([type, item]) => (
              <option key={type} value={type}>
                {tr(item.label)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {pick("المدينة", "City")}
          <input
            required
            minLength={2}
            maxLength={120}
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
        </label>
        <label>
          {pick("هاتف التواصل", "Contact phone")}
          <input
            maxLength={32}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </label>
        <label>
          {pick("رقم الترخيص", "License number")}
          <input
            maxLength={120}
            value={form.licenseNumber}
            onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })}
          />
        </label>
        <label>
          {pick("بريد مسؤول المنشأة", "Company manager email")}
          <input
            type="email"
            required
            readOnly={Boolean(organization)}
            value={form.contactEmail}
            onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
          />
        </label>
        {!organization && (
          <label>
            {pick("كلمة مرور الحساب", "Account password")}
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
        )}
        <div className="full-width">
          <Feedback error={error} />
        </div>
        <div className="form-actions full-width">
          <button className="ghost-button" type="button" onClick={onClose}>
            {pick("رجوع", "Back")}
          </button>
          <button className="primary-button" disabled={saving}>
            {tr(saving ? pick("جاري الحفظ…", "Saving…") : pick("حفظ المنشأة", "Save company"))}
          </button>
        </div>
      </form>
    </Modal>
  );
}
