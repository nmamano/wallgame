/**
 * Builds the URL of a file the app ships in `frontend/public/`.
 *
 * Vite rewrites the asset paths it can see - ES imports, and `index.html` - to
 * sit under the build's base. It cannot see a path the app assembles at runtime,
 * and a leading-slash string like "/logo.png" is an absolute URL: correct only
 * while the app is served from the root of its origin. That is true on
 * wallgame.io and false the moment the build is mounted in a subdirectory, where
 * every one of them 404s.
 *
 * `joinAssetPath` is split out so it can be tested without Vite; see
 * `tests/asset-url.test.ts`, which also fails the build if a new root-absolute
 * asset path appears in `frontend/src`.
 */

export const joinAssetPath = (base: string, path: string): string => {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${path.replace(/^\/+/, "")}`;
};

export const assetUrl = (path: string): string =>
  joinAssetPath(import.meta.env.BASE_URL, path);
