import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * When Turbopack mis-infers the workspace root (e.g. `src/app`), packages fail to resolve.
   * Root must be the directory that contains `package.json` and `node_modules`.
   */
  turbopack: {
    root: process.cwd(),
  },
  async redirects() {
    return [
      // The Bex health dashboard was folded into /admin; keep bookmarks and ?window=/?version= links working.
      { source: '/admin/bex/health', destination: '/admin', permanent: true },
    ];
  },
  serverExternalPackages: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "pdfjs-dist"],
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "betco",

  project: "bex",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  }
});
