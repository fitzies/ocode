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

type ThemeProviderContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderContextValue | undefined>(undefined);

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
  storageKey = "anvil-theme",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === "dark" || stored === "light" || stored === "system"
        ? stored
        : defaultTheme;
    } catch {
      return defaultTheme;
    }
  });

  useLayoutEffect(() => applyTheme(theme), [theme]);

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
  }), [storageKey, theme]);

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
