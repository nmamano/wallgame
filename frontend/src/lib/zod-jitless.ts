/**
 * No eval: the page policy (server/content-security-policy.ts) has no
 * 'unsafe-eval'. Zod probes `new Function` on its first object parse and
 * falls back when the probe throws, but the browser still reports the probe
 * as a policy violation. A module parses a schema while it loads, so this
 * must run before every other import of main.tsx: it is the first one.
 */
import { config } from "zod";

config({ jitless: true });
