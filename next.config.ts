import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * When Turbopack mis-infers the workspace root (e.g. `src/app`), packages fail to resolve.
   * Root must be the directory that contains `package.json` and `node_modules`.
   */
  turbopack: {
    root: process.cwd(),
  },
  serverExternalPackages: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
};

export default nextConfig;
