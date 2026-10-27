/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // OpenSeadragon reads `window` at import time, so it must never be bundled
  // into a server component graph.
  transpilePackages: ['@deep-zoom/shared-types'],
  // `NEXT_PUBLIC_*` values are inlined into client chunks at build time. If the
  // E2E suite and `npm run dev` shared the same `.next` directory, the E2E run
  // (which points the client at the test API port) would overwrite the dev
  // build, so the dev browser would suddenly call the test API port. Giving the
  // E2E run its own dist directory keeps the two builds isolated.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  eslint: {
    dirs: ['src'],
  },
};

module.exports = nextConfig;
