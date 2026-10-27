/**
 * Shared E2E endpoint configuration.
 *
 * Both `playwright.config.ts` and the spec support helpers must agree on the
 * ports. Keeping the values in one module removes the chance of a spec calling
 * a different server than the one the suite started — which previously made
 * the direct API assertions silently hit a developer's own dev server (or
 * nothing at all).
 */

/** Port the Next.js app under test listens on. */
export const WEB_PORT = process.env.E2E_WEB_PORT ?? '3100';

/** Port the NestJS API under test listens on. */
export const API_PORT = process.env.E2E_API_PORT ?? '3101';

/** Base URL of the web app under test. */
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;

/** Base URL of the API under test, including the `/api/v1` prefix. */
export const API_BASE_URL =
  process.env.E2E_API_URL ?? `http://localhost:${API_PORT}/api/v1`;
