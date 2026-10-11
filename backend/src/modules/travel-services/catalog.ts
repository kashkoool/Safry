import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { ProviderType, ServiceCategory } from "../../generated/prisma/enums.js";

type Field = { key: string; label: string; type?: "number" | "date"; required?: boolean };
type Definition = { label: string; unit: string; dateLabel: string; fields: Field[] };
export const serviceDefinitions: Record<ServiceCategory, Definition> = {
  UMRAH: {
    label: "برنامج عمرة",
    unit: "للمسافر",
    dateLabel: "تاريخ الانطلاق",
    fields: [
      { key: "durationDays", label: "مدة البرنامج بالأيام", type: "number", required: true },
      { key: "departureCity", label: "مدينة الانطلاق", required: true },
      { key: "itinerary", label: "مسار البرنامج والخدمات المشمولة", required: true }
    ]
  },
  PACKAGE: {
    label: "برنامج سياحي",
    unit: "للمسافر",
    dateLabel: "تاريخ الانطلاق",
    fields: [
      { key: "durationDays", label: "المدة بالأيام", type: "number", required: true },
      { key: "departureCity", label: "مدينة الانطلاق", required: true },
      { key: "itinerary", label: "مسار البرنامج", required: true }
    ]
  },
  HOTEL: {
    label: "إقامة فندقية",
    unit: "للغرفة / ليلة",
    dateLabel: "تاريخ الوصول",
    fields: [
      { key: "roomType", label: "نوع الغرفة", required: true },
      { key: "maxGuests", label: "أقصى نزلاء بالغرفة", type: "number", required: true },
      { key: "mealPlan", label: "نظام الوجبات", required: true }
    ]
  },
  FLIGHT: {
    label: "رحلة طيران",
    unit: "للمقعد",
    dateLabel: "تاريخ السفر",
    fields: [
      { key: "flightNumber", label: "رقم الرحلة", required: true },
      { key: "origin", label: "مطار المغادرة", required: true },
      { key: "destination", label: "مطار الوصول", required: true },
      { key: "departureDate", label: "موعد الرحلة", type: "date", required: true },
      { key: "cabin", label: "درجة المقعد", required: true }
    ]
  },
  TRANSPORT: {
    label: "نقل",
    unit: "للمركبة",
    dateLabel: "تاريخ النقل",
    fields: [
      { key: "vehicleType", label: "نوع المركبة", required: true },
      { key: "seats", label: "مقاعد المركبة", type: "number", required: true },
      { key: "origin", label: "نقطة الانطلاق", required: true },
      { key: "destination", label: "الوجهة", required: true }
    ]
  },
  RESTAURANT: {
    label: "وجبات ومطاعم",
    unit: "للشخص",
    dateLabel: "تاريخ الوجبة",
    fields: [
      { key: "mealType", label: "نوع الوجبة", required: true },
      { key: "menu", label: "قائمة الطعام", required: true }
    ]
  },
  VISA: {
    label: "خدمة تأشيرة",
    unit: "للمتقدم",
    dateLabel: "تاريخ طلب الخدمة",
    fields: [
      { key: "visaType", label: "نوع التأشيرة", required: true },
      { key: "requirements", label: "المتطلبات", required: true }
    ]
  },
  VISIT: {
    label: "زيارة",
    unit: "للزائر",
    dateLabel: "تاريخ الزيارة",
    fields: [
      { key: "site", label: "موقع الزيارة", required: true },
      { key: "requirements", label: "متطلبات الزيارة" }
    ]
  },
  TOUR: {
    label: "جولة سياحية",
    unit: "للمسافر",
    dateLabel: "تاريخ الجولة",
    fields: [{ key: "itinerary", label: "مسار الجولة", required: true }]
  },
  OTHER: {
    label: "خدمة أخرى",
    unit: "للشخص",
    dateLabel: "تاريخ الخدمة",
    fields: [{ key: "scope", label: "نطاق الخدمة", required: true }]
  }
};
export const providerDefinitions: Record<
  ProviderType,
  { label: string; categories: ServiceCategory[]; role: string }
> = {
  UMRAH_COMPANY: { label: "شركة عمرة", categories: ["UMRAH", "PACKAGE", "TOUR"], role: "travel-company" },
  TRAVEL_COMPANY: { label: "شركة سياحة", categories: ["PACKAGE", "TOUR", "UMRAH"], role: "travel-company" },
  HOTEL: { label: "فندق", categories: ["HOTEL"], role: "service-provider" },
  AIRLINE: { label: "شركة طيران", categories: ["FLIGHT"], role: "service-provider" },
  TRANSPORT: { label: "شركة نقل", categories: ["TRANSPORT"], role: "service-provider" },
  RESTAURANT: { label: "مطعم", categories: ["RESTAURANT"], role: "service-provider" },
  VISA: { label: "مزود تأشيرات", categories: ["VISA"], role: "service-provider" },
  VISIT: { label: "مزود زيارات", categories: ["VISIT"], role: "service-provider" },
  OTHER: { label: "مزود خدمات أخرى", categories: ["OTHER"], role: "service-provider" }
};

export function assertCategory(type: ProviderType, category: ServiceCategory): void {
  if (!providerDefinitions[type].categories.includes(category)) {
    throw new ForbiddenException("نوع الخدمة لا يتوافق مع نشاط المنشأة");
  }
}
export function validateDetails(category: ServiceCategory, raw: unknown, translation = false): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new BadRequestException("تفاصيل الخدمة مطلوبة");
  const values = raw as Record<string, unknown>;
  const fields = serviceDefinitions[category].fields.filter(field => !translation || !field.type);
  if (Object.keys(values).some((key) => !fields.some((field) => field.key === key)))
    throw new BadRequestException("حقول غير مدعومة لهذا النوع");
  const clean: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value !== undefined && typeof value !== "string")
      throw new BadRequestException(`قيمة غير صالحة: ${field.label}`);
    const text = value?.trim() ?? "";
    if (!translation && field.required && !text) throw new BadRequestException(`الحقل مطلوب: ${field.label}`);
    if (text.length > 1000) throw new BadRequestException("تفاصيل الخدمة طويلة جداً");
    if (text && field.type === "number" && (!/^\d+$/.test(text) || +text < 1 || +text > 1000))
      throw new BadRequestException(`عدد غير صالح: ${field.label}`);
    if (
      text &&
      field.type === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
        !Number.isFinite(Date.parse(text)) ||
        new Date(text).toISOString().slice(0, 10) !== text)
    )
      throw new BadRequestException("تاريخ غير صالح");
    clean[field.key] = text;
  }
  return clean;
}
