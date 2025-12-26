import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type MutableRefObject,
} from "react";

const STORAGE_KEY = "wall-game-sound-enabled";

interface SoundProviderProps {
  children: React.ReactNode;
  defaultEnabled?: boolean;
}

interface SoundProviderState {
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  /**
   * Ref to current soundEnabled value, useful for avoiding stale closures
   * in async callbacks (e.g., WebSocket handlers, setTimeout).
   */
  soundEnabledRef: MutableRefObject<boolean>;
}

const SoundProviderContext = createContext<SoundProviderState | undefined>(
  undefined,
);

export function SoundProvider({
  children,
  defaultEnabled = true,
}: SoundProviderProps) {
  // Initialize from localStorage synchronously during render to avoid flash
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "true") return true;
      if (stored === "false") return false;
    }
    return defaultEnabled;
  });

  // Ref for async callback access (avoids stale closure issues)
  const soundEnabledRef = useRef(soundEnabled);

  // Sync ref with state (useLayoutEffect ensures it's updated before other effects)
  useLayoutEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  // Persist to localStorage on every change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(soundEnabled));
  }, [soundEnabled]);

  // Wrapper that accepts both direct values and updater functions
  const setSoundEnabled = (enabled: boolean | ((prev: boolean) => boolean)) => {
    setSoundEnabledState(enabled);
  };

  return (
    <SoundProviderContext.Provider
      value={{ soundEnabled, setSoundEnabled, soundEnabledRef }}
    >
      {children}
    </SoundProviderContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSound() {
  const context = useContext(SoundProviderContext);
  if (context === undefined) {
    throw new Error("useSound must be used within a SoundProvider");
  }
  return context;
}
