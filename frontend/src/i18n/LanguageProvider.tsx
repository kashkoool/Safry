import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { LoadingScreen } from "../components/LoadingScreen";
import { LanguageContext, type Language } from "./LanguageContext";
import { ensureMessages } from "./translate";

const storageKey = "safry.language";

function initialLanguage(): Language {
  try { return window.localStorage.getItem(storageKey) === "en" ? "en" : "ar"; }
  catch { return "ar"; }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  const [ready, setReady] = useState(language === "ar");
  const direction = language === "ar" ? "rtl" : "ltr";
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
    document.title = language === "ar" ? "سفري | منصة إدارة السفر" : "Safry | Travel Management Platform";
  }, [language, direction]);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void ensureMessages(language).then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [ready, language]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const next: Language = event.newValue === "en" ? "en" : "ar";
      void ensureMessages(next).then(() => setLanguageState(next));
    };
    const clearValidity = (event: Event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) event.target.setCustomValidity("");
    };
    const invalid = (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) return;
      const validity = input.validity;
      input.setCustomValidity(language === "ar"
        ? validity.valueMissing ? "يرجى تعبئة هذا الحقل" : validity.typeMismatch ? "يرجى إدخال قيمة بالتنسيق الصحيح" : "يرجى مراجعة القيمة والحدود المسموحة لهذا الحقل"
        : validity.valueMissing ? "Please fill in this field" : validity.typeMismatch ? "Please enter a value in the correct format" : "Please check this value and the allowed limits");
    };
    window.addEventListener("storage", sync);
    document.addEventListener("input", clearValidity, true);
    document.addEventListener("change", clearValidity, true);
    document.addEventListener("invalid", invalid, true);
    return () => {
      window.removeEventListener("storage", sync);
      document.removeEventListener("input", clearValidity, true);
      document.removeEventListener("change", clearValidity, true);
      document.removeEventListener("invalid", invalid, true);
    };
  }, [language]);
  const setLanguage = (next: Language) => {
    try { window.localStorage.setItem(storageKey, next); } catch { /* private browsing */ }
    // Load the dictionary first so the UI never flashes untranslated text and no page state is unmounted.
    void ensureMessages(next).then(() => setLanguageState(next));
  };
  return <LanguageContext.Provider value={{ language, direction, setLanguage,
    pick: (arabic, english) => language === "ar" ? arabic : english }}>
    {ready ? children : <LoadingScreen />}
  </LanguageContext.Provider>;
}
