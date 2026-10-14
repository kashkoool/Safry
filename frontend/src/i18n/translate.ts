import type { Language } from "./LanguageContext";

// The English dictionary is a separate chunk: Arabic (the default) never downloads it.
let messages: Record<string, string> = {};
const memo: Record<Language, Map<string, string>> = { ar: new Map(), en: new Map() };
export async function ensureMessages(language: Language): Promise<void> {
  if (language !== "en" || Object.keys(messages).length) return;
  messages = (await import("./en-messages")).default;
  memo.en.clear();
}
const systemText: Record<string, [string, string]> = {
  "platform.access.update": ["تعديل صلاحيات العضوية", "Update membership access"],
  "Invalid credentials or tenant": ["بيانات الدخول أو رمز الجهة غير صحيحة", "Invalid credentials or workspace code"],
  Unauthorized: ["انتهت الجلسة أو يلزم تسجيل الدخول", "Please sign in again"],
  "Forbidden resource": ["ليس لديك صلاحية لتنفيذ هذه العملية", "You do not have permission for this action"],
  Forbidden: ["ليس لديك صلاحية لتنفيذ هذه العملية", "You do not have permission for this action"],
  "Internal server error": ["حدث خطأ في الخادم؛ حاول مجدداً", "Server error; please try again"],
  "ThrottlerException: Too Many Requests": ["محاولات كثيرة؛ انتظر قليلاً وحاول مجدداً", "Too many attempts; please wait and try again"],
  "Refresh token is invalid or expired": ["انتهت الجلسة؛ سجل الدخول مجدداً", "Session expired; sign in again"],
  "Refresh token has already been used": ["انتهت الجلسة؛ سجل الدخول مجدداً", "Session expired; sign in again"],
  "Failed to fetch": ["تعذر الاتصال بالخادم", "Unable to connect to the server"],
  "Demo booking": ["حجز تجريبي", "Demo booking"],
  "identity.login": ["تسجيل الدخول", "Sign in"], "identity.refresh": ["تجديد الجلسة", "Refresh session"], "identity.logout": ["تسجيل الخروج", "Sign out"],
  "identity.customer.register": ["تسجيل مسافر", "Register traveler"], "identity.provider.register": ["تسجيل شركة", "Register company"],
  "provider.create": ["إنشاء منشأة", "Create company"], "provider.update": ["تعديل منشأة", "Update company"], "provider.active": ["تفعيل منشأة", "Activate company"], "provider.suspended": ["إيقاف منشأة", "Suspend company"],
  "catalog.service.create": ["إنشاء خدمة", "Create service"], "catalog.service.update": ["تعديل خدمة", "Update service"],
  "booking.create": ["إنشاء حجز", "Create booking"], "booking.update": ["تعديل حجز", "Update booking"], "booking.confirmed": ["تأكيد حجز", "Confirm booking"], "booking.cancelled": ["إلغاء حجز", "Cancel booking"],
  "organization.role.create": ["إنشاء دور للشركة", "Create company role"], "organization.role.update": ["تعديل دور الشركة", "Update company role"], "organization.specialties.update": ["تعديل الاختصاصات", "Update specialties"],
  "organization.department.create": ["إنشاء قسم", "Create department"], "organization.department.update": ["تعديل قسم", "Update department"], "organization.employee.create": ["إضافة موظف", "Add employee"], "organization.employee.update": ["تعديل موظف", "Update employee"],
  "platform.account.create": ["إنشاء حساب", "Create account"], "platform.account.update": ["تعديل حساب", "Update account"], "platform.account.activate": ["تفعيل حساب", "Activate account"], "platform.account.suspend": ["إيقاف حساب", "Suspend account"], "platform.account.disable": ["إغلاق حساب", "Disable account"], "platform.account.delete": ["حذف حساب", "Delete account"], "platform.account.restore": ["استعادة حساب", "Restore account"], "platform.sessions.revoke": ["إنهاء الجلسات", "End sessions"], "platform.membership.access.update": ["تعديل صلاحيات العضوية", "Update membership access"], "demo.catalog.replace": ["استبدال البيانات التجريبية", "Replace demo data"], "demo.organization.manager.grant": ["تعيين مدير تجريبي", "Assign demo manager"],
  "identity.login.mfa": ["تسجيل الدخول بالتحقق الثنائي", "Sign in with two-factor"], "identity.login.failed": ["محاولة دخول فاشلة", "Failed sign-in attempt"], "identity.account.locked": ["قفل الحساب مؤقتاً", "Account temporarily locked"], "identity.login_throttle.unlock": ["رفع حظر تسجيل الدخول", "Unlock sign-in"],
  "identity.logout.all": ["تسجيل الخروج من جميع الأجهزة", "Sign out everywhere"], "identity.session.refresh": ["تجديد الجلسة", "Refresh session"], "identity.session.end": ["إنهاء جلسة", "End session"], "identity.session.reuse_detected": ["رصد إعادة استخدام رمز الجلسة", "Session token reuse detected"],
  "identity.password.change": ["تغيير كلمة المرور", "Change password"], "identity.user.profile.update": ["تعديل الملف الشخصي", "Update profile"],
  "identity.mfa.setup": ["بدء إعداد التحقق الثنائي", "Start two-factor setup"], "identity.mfa.enable": ["تفعيل التحقق الثنائي", "Enable two-factor"], "identity.mfa.disable": ["إيقاف التحقق الثنائي", "Disable two-factor"], "identity.mfa.recovery_codes_regenerated": ["إنشاء رموز استرداد جديدة", "Regenerate recovery codes"],
  "identity.tenant.update": ["تعديل إعدادات مساحة العمل", "Update workspace settings"],
  "identity.membership.status": ["تغيير حالة عضو", "Change member status"], "identity.membership.roles.update": ["تعديل أدوار عضو", "Update member roles"], "identity.membership.invitation.accept": ["قبول دعوة", "Accept invitation"], "identity.membership.invitation.decline": ["رفض دعوة", "Decline invitation"],
  "identity.role.create": ["إنشاء دور", "Create role"], "identity.role.update": ["تعديل دور", "Update role"], "identity.role.delete": ["حذف دور", "Delete role"],
  "platform.tenant.create": ["إنشاء مساحة عمل", "Create workspace"], "platform.tenant.active": ["تفعيل مساحة عمل", "Activate workspace"], "platform.tenant.suspended": ["تعليق مساحة عمل", "Suspend workspace"], "platform.tenant.archived": ["أرشفة مساحة عمل", "Archive workspace"],
  "Safry Platform": ["منصة سفري", "Safry Platform"],
  "Safry Administrator": ["مدير منصة سفري", "Safry Administrator"],
  UMRAH_COMPANY: ["شركة عمرة", "Umrah company"], TRAVEL_COMPANY: ["شركة سياحة", "Travel company"],
  HOTEL: ["فندق", "Hotel"], AIRLINE: ["شركة طيران", "Airline"], FLIGHT: ["رحلة طيران", "Flight"], TRANSPORT: ["نقل", "Transport"], UMRAH: ["برنامج عمرة", "Umrah package"], PACKAGE: ["برنامج سياحي", "Travel package"], RESTAURANT: ["مطعم", "Restaurant"], VISA: ["تأشيرة", "Visa"], VISIT: ["زيارة", "Visit"], TOUR: ["جولة سياحية", "Tour"], OTHER: ["أخرى", "Other"],
  ACTIVE: ["نشط", "Active"], SUSPENDED: ["موقوف", "Suspended"], REVOKED: ["ملغى", "Revoked"], PENDING: ["بانتظار التأكيد", "Pending"], CONFIRMED: ["مؤكد", "Confirmed"], CANCELLED: ["ملغي", "Cancelled"], DISABLED: ["مغلق", "Disabled"], INVITED: ["دعوة", "Invited"], INACTIVE: ["غير نشط", "Inactive"], DRAFT: ["مسودة", "Draft"], ARCHIVED: ["مؤرشف", "Archived"]
};
export function translateText(value: string, language: Language): string {
  const hit = memo[language].get(value);
  if (hit !== undefined) return hit;
  const result = translate(value, language);
  if (memo[language].size < 5000) memo[language].set(value, result);
  return result;
}
function translate(value: string, language: Language): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (systemText[normalized]) return systemText[normalized][language === "ar" ? 0 : 1];
  if (normalized.includes("، ") && !messages[normalized]) return normalized.split("، ").map(part => translateText(part, language)).join(language === "ar" ? "، " : ", ");
  if (/^[\w.]+ (must |should |each value |has failed )/.test(normalized)) {
    const field = normalized.split(" ")[0];
    const fields: Record<string, string> = { nameAr: "اسم الشركة بالعربية", nameEn: "اسم الشركة بالإنجليزية", organizationName: "اسم الشركة بالعربية", organizationNameEn: "اسم الشركة بالإنجليزية", email: "البريد الإلكتروني", password: "كلمة المرور", displayName: "الاسم الكامل", tenantCode: "رمز الجهة", city: "المدينة", phone: "الهاتف", title: "اسم العرض", description: "الوصف" };
    const label = fields[field] ?? field;
    const minimum = normalized.match(/longer than or equal to (\d+) characters/);
    const maximum = normalized.match(/shorter than or equal to (\d+) characters/);
    return language === "ar" ? minimum ? `${label}: الحد الأدنى ${minimum[1]} أحرف` : maximum ? `${label}: الحد الأقصى ${maximum[1]} أحرف` : `${label}: يرجى إدخال قيمة صحيحة` : normalized;
  }
  if (language === "ar") return value;
  const match = messages[normalized];
  if (match !== undefined) return value.replace(value.trim(), match);
  if (normalized.startsWith("صلاحيات ")) return `Permissions for ${normalized.slice(8)}`;
  if (normalized.startsWith("صلاحية ")) return `Permission ${normalized.slice(7)}`;
  // Joined role labels and contextual labels keep their separators and dynamic values.
  return value.split(/( · |، |: |\n)/).map(part => messages[part.trim()] ?? part).join("").replace(/، /g, ", ");
}
