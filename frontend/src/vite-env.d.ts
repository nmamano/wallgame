/// <reference types="vite/client" />

declare module "virtual:pawn-manifest" {
  /** Pawn art filenames per type, as read from public/pawns/ at build time. */
  const manifest: Record<"cat" | "mouse" | "home", string[]>;
  export default manifest;
}
