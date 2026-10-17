import { SITE_LANGUAGES, type SiteLanguage } from "@gcf/shared";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DICTIONARIES, type Dictionary } from "./dictionary";

export type Language = SiteLanguage;

const STORAGE_KEY = "gcf-portal-language";

/** The language chosen earlier on this browser; storage can be unavailable (private mode, blocked site data). */
function storedLanguage(): Language {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return SITE_LANGUAGES.find((l) => l === value) ?? "fr";
  } catch {
    return "fr";
  }
}

function storeLanguage(language: Language): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // The choice then lasts for this page only.
  }
}

interface I18nValue {
  language: Language;
  t: Dictionary;
  setLanguage(language: Language): void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setState] = useState<Language>(storedLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = DICTIONARIES[language].common.appName;
  }, [language]);
  const value: I18nValue = {
    language,
    t: DICTIONARIES[language],
    setLanguage: (next) => {
      storeLanguage(next);
      setState(next);
    },
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
