import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

export type Theme = "dark" | "light" | "system";
export const ACCENTS = ["neutral", "blue", "cyan", "emerald", "amber", "rose", "pink", "purple"] as const;
export type Accent = (typeof ACCENTS)[number];

type ThemeProviderContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
};

const ThemeProviderContext = createContext<ThemeProviderContextValue | undefined>(undefined);
const THEME_STORAGE_KEY = "ocode-theme";
const LEGACY_THEME_STORAGE_KEY = "anvil-theme";
const ACCENT_STORAGE_KEY = "ocode-accent";

function isAccent(value: string | null): value is Accent {
  return value !== null && (ACCENTS as readonly string[]).includes(value);
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const dark = theme === "dark" || (
    theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = THEME_STORAGE_KEY,
}: {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === "dark" || stored === "light" || stored === "system") return stored;
      if (storageKey === THEME_STORAGE_KEY) {
        const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
        if (legacy === "dark" || legacy === "light" || legacy === "system") {
          try {
            localStorage.setItem(THEME_STORAGE_KEY, legacy);
          } catch {
            // Continue using the legacy selection when migration storage is unavailable.
          }
          return legacy;
        }
      }
      return defaultTheme;
    } catch {
      return defaultTheme;
    }
  });
  const [accent, setAccentState] = useState<Accent>(() => {
    try {
      const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
      return isAccent(stored) ? stored : "neutral";
    } catch {
      return "neutral";
    }
  });

  useLayoutEffect(() => applyTheme(theme), [theme]);
  useLayoutEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);

  const value = useMemo<ThemeProviderContextValue>(() => ({
    theme,
    setTheme: (nextTheme) => {
      try {
        localStorage.setItem(storageKey, nextTheme);
      } catch {
        // Theme selection still applies for the current page when storage is unavailable.
      }
      setThemeState(nextTheme);
    },
    accent,
    setAccent: (nextAccent) => {
      try {
        localStorage.setItem(ACCENT_STORAGE_KEY, nextAccent);
      } catch {
        // Accent selection still applies for the current page when storage is unavailable.
      }
      setAccentState(nextAccent);
    },
  }), [accent, storageKey, theme]);

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
