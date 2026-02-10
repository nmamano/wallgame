import { useState, useEffect } from "react";

/**
 * Tracks the real visible viewport dimensions on mobile.
 *
 * Uses `window.visualViewport` (supported in all modern browsers) which
 * accounts for mobile Safari's collapsing URL bar and virtual keyboard.
 * Falls back to `window.innerWidth/innerHeight` on older browsers.
 *
 * Returns stable pixel values suitable for computing board cell sizes.
 */
export function useMobileViewport() {
  const [size, setSize] = useState(() => ({
    viewportWidth: window.visualViewport?.width ?? window.innerWidth,
    viewportHeight: window.visualViewport?.height ?? window.innerHeight,
  }));

  useEffect(() => {
    const vv = window.visualViewport;

    if (vv) {
      const update = () => {
        setSize({
          viewportWidth: vv.width,
          viewportHeight: vv.height,
        });
      };
      vv.addEventListener("resize", update);
      return () => vv.removeEventListener("resize", update);
    }

    // Fallback for browsers without visualViewport
    const update = () => {
      setSize({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return size;
}
