import { Languages } from "lucide-react";
import { useLanguage } from "./useLanguage";

export function LanguageSwitch() {
  const { language, setLanguage } = useLanguage();
  const next = language === "ar" ? "en" : "ar";
  return <button type="button" className="language-switch" onClick={() => setLanguage(next)}
    aria-label={language === "ar" ? "Switch to English" : "التبديل إلى العربية"}>
    <Languages size={16} aria-hidden="true" /> {next === "en" ? "English" : "العربية"}
  </button>;
}
