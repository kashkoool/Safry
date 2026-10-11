import { useMemo } from "react";
import { useLanguage } from "./useLanguage";
import type { Language } from "./LanguageContext";

// Only explicitly stored bilingual content is selected. User-authored text is never guessed.
export function localizeData<T>(value: T, language: Language): T {
  if (Array.isArray(value)) return value.map(item => localizeData(item, language)) as T;
  if (!value || typeof value !== "object") return value;
  const record = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localizeData(item, language)]));
  if (typeof record.nameAr === "string" || typeof record.nameEn === "string") {
    record.name = (language === "en" ? record.nameEn : record.nameAr) || record.name;
  }
  for (const field of ["title", "description", "city"]) {
    if (typeof record[`${field}En`] === "string") {
      record[`${field}Ar`] = record[`${field}Ar`] ?? record[field];
      record[field] = language === "en" && record[`${field}En`] ? record[`${field}En`] : record[`${field}Ar`];
    }
  }
  if (record.detailsEn && typeof record.detailsEn === "object") {
    record.detailsAr = record.detailsAr ?? record.details;
    record.details = language === "en" ? { ...(record.detailsAr as object), ...Object.fromEntries(Object.entries(record.detailsEn).filter(([, v]) => v !== "")) } : record.detailsAr;
  }
  return record as T;
}

export function useLocalizedData<T>(value: T): T {
  const { language } = useLanguage();
  return useMemo(() => localizeData(value, language), [value, language]);
}
