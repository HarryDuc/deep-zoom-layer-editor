const DEFAULT_API_BASE_URL = 'http://localhost:3001/api/v1';

/**
 * Base URL of the NestJS API. Only a public base URL is exposed to the browser;
 * the web app never talks to MongoDB and holds no secrets.
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? DEFAULT_API_BASE_URL;

/**
 * Builds an absolute API URL from a path returned by the API (such as an
 * overlay `url` or the DZI descriptor path).
 */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalized}`;
}
