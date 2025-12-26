import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type MutableRefObject,
} from "react";

const SFX_STORAGE_KEY = "wall-game-sfx-enabled";
const MUSIC_STORAGE_KEY = "wall-game-music-enabled";

interface SoundProviderProps {
  children: React.ReactNode;
  defaultEnabled?: boolean;
}

interface SoundProviderState {
  sfxEnabled: boolean;
  setSfxEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  /**
   * Ref to current sfxEnabled value, useful for avoiding stale closures
   * in async callbacks (e.g., WebSocket handlers, setTimeout).
   */
  sfxEnabledRef: MutableRefObject<boolean>;
  musicEnabled: boolean;
  setMusicEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  /**
   * Ref to current musicEnabled value, useful for avoiding stale closures
   * in async callbacks (e.g., WebSocket handlers, setTimeout).
   */
  musicEnabledRef: MutableRefObject<boolean>;
}

const SoundProviderContext = createContext<SoundProviderState | undefined>(
  undefined,
);

export function SoundProvider({
  children,
  defaultEnabled = true,
}: SoundProviderProps) {
  // Initialize SFX from localStorage synchronously during render to avoid flash
  const [sfxEnabled, setSfxEnabledState] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      // Migration: check old key first, then new key
      const oldStored = localStorage.getItem("wall-game-sound-enabled");
      if (oldStored !== null) {
        // Migrate to new key and remove old one
        localStorage.setItem(SFX_STORAGE_KEY, oldStored);
        localStorage.removeItem("wall-game-sound-enabled");
        return oldStored === "true";
      }
      const stored = localStorage.getItem(SFX_STORAGE_KEY);
      if (stored === "true") return true;
      if (stored === "false") return false;
    }
    return defaultEnabled;
  });

  // Initialize Music from localStorage synchronously during render to avoid flash
  const [musicEnabled, setMusicEnabledState] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(MUSIC_STORAGE_KEY);
      if (stored === "true") return true;
      if (stored === "false") return false;
    }
    return defaultEnabled;
  });

  // Refs for async callback access (avoids stale closure issues)
  const sfxEnabledRef = useRef(sfxEnabled);
  const musicEnabledRef = useRef(musicEnabled);

  // Sync refs with state (useLayoutEffect ensures it's updated before other effects)
  useLayoutEffect(() => {
    sfxEnabledRef.current = sfxEnabled;
  }, [sfxEnabled]);

  useLayoutEffect(() => {
    musicEnabledRef.current = musicEnabled;
  }, [musicEnabled]);

  // Persist to localStorage on every change
  useEffect(() => {
    localStorage.setItem(SFX_STORAGE_KEY, String(sfxEnabled));
  }, [sfxEnabled]);

  useEffect(() => {
    localStorage.setItem(MUSIC_STORAGE_KEY, String(musicEnabled));
  }, [musicEnabled]);

  // Wrappers that accept both direct values and updater functions
  const setSfxEnabled = (enabled: boolean | ((prev: boolean) => boolean)) => {
    setSfxEnabledState(enabled);
  };

  const setMusicEnabled = (enabled: boolean | ((prev: boolean) => boolean)) => {
    setMusicEnabledState(enabled);
  };

  return (
    <SoundProviderContext.Provider
      value={{
        sfxEnabled,
        setSfxEnabled,
        sfxEnabledRef,
        musicEnabled,
        setMusicEnabled,
        musicEnabledRef,
      }}
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
