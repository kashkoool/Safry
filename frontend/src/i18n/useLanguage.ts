import { useContext } from "react";
import { LanguageContext, type LanguageState } from "./LanguageContext";

export function useLanguage(): LanguageState {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("LanguageProvider is missing");
  return context;
}
