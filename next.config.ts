import type { NextConfig } from "next";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  // Skip static generation for error pages — the root layout uses client-side
  // providers (ThemeProvider, AppShell with usePathname) that fail during prerender.
  // This app always runs dynamically (needs SQLite, Claude CLI at runtime).
  staticPageGenerationTimeout: 1,
};

export default nextConfig;
