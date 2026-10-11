import { createContext } from "react";

export type Language = "ar" | "en";
export type LanguageState = {
  language: Language;
  direction: "rtl" | "ltr";
  setLanguage: (next: Language) => void;
  pick: (arabic: string, english: string) => string;
};

export const LanguageContext = createContext<LanguageState | null>(null);
