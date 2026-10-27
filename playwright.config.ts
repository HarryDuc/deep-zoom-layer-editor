import { defineConfig, devices } from '@playwright/test';
import { API_BASE_URL, API_PORT, BASE_URL, WEB_PORT } from './tests/e2e/config';

/**
 * End-to-end configuration for the core MVP flow:
 * upload -> DZI processing -> draw objects -> save -> reload.
 *
 * The suite drives the real Next.js app against the real NestJS API, a real
 * MongoDB and real Sharp output, because the point of these tests is to verify
 * the upload / processing / tile-serving pipeline as a whole.
 *
 * Dedicated ports are used (3100/3101) so the suite never fights with a
 * developer's `npm run dev` on the defaults (3000/3001). Both servers are
 * started by the `webServer` block below unless E2E_NO_WEB_SERVER is set.
 *
 * The endpoints live in `tests/e2e/config.ts` so the specs and this config
 * can never disagree about which server is under test.
 */
export { API_BASE_URL };

export default defineConfig({
  testDir: './tests/e2e',
  // DZI generation for a multi-megapixel image takes seconds and the upload
  // flow waits for it, so budgets are deliberately generous.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // One worker: every test shares the same MongoDB database and storage root.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'vi-VN,vi' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_NO_WEB_SERVER
    ? undefined
    : [
        {
          command: 'npm run start:dev --workspace=@deep-zoom/api',
          cwd: '.',
          url: `${API_BASE_URL}/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 240_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            PORT: API_PORT,
            FRONTEND_ORIGIN: BASE_URL,
            NODE_ENV: 'development',
            // A separate database and storage root keep E2E data out of the
            // developer's own `npm run dev` state.
            MONGODB_URI:
              process.env.E2E_MONGODB_URI ??
              'mongodb://127.0.0.1:27017/deep_zoom_layer_editor_e2e',
            APP_STORAGE_DIR: 'data-e2e',
          },
        },
        {
          command: 'npm run dev --workspace=@deep-zoom/web',
          cwd: '.',
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 240_000,
          stdout: 'pipe',
          stderr: 'pipe',
            env: {
              NEXT_PUBLIC_API_BASE_URL: API_BASE_URL,
              // Keep the E2E build out of the developer's `.next` so a test run
              // never overwrites the dev bundle with test-port API URLs.
              NEXT_DIST_DIR: '.next-e2e',
              // Next.js reads PORT itself, so the default `next dev` port is
              // overridden here without hard-coding a second script.
              PORT: WEB_PORT,
            },
        },
      ],
});
