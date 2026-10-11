import { useCallback } from "react";
import { useLanguage } from "./useLanguage";
import { translateText } from "./translate";

export function useText() {
  const { language } = useLanguage();
  return useCallback(function text<T>(value: T): T {
    return (typeof value === "string" ? translateText(value, language) : value) as T;
  }, [language]);
}
