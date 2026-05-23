import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles only the files needed at runtime, keeping the
  // production Docker image small (~150 MB instead of dragging node_modules).
  output: "standalone",
  // better-sqlite3 is a native module; mark it external so Next/Webpack
  // doesn't try to bundle it.
  serverExternalPackages: ["better-sqlite3", "@prisma/client", "@prisma/adapter-better-sqlite3"],
};

export default nextConfig;
