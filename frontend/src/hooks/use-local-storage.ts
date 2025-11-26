import { useState, useEffect } from "react";

export function useLocalStorageState<T>(
  key: string,
  defaultValue: T | (() => T),
) {
  const [value, setValue] = useState<T>(() => {
    // Resolve defaultValue (could be a function or value)
    const resolvedDefault =
      typeof defaultValue === "function"
        ? (defaultValue as () => T)()
        : defaultValue;

    if (typeof window === "undefined") return resolvedDefault;
    const stored = localStorage.getItem(key);
    if (!stored) return resolvedDefault;
    try {
      return JSON.parse(stored) as T;
    } catch {
      return resolvedDefault;
    }
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }, [key, value]);

  return [value, setValue] as const;
}
