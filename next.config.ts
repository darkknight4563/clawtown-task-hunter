import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so a stray lockfile elsewhere on the machine
  // doesn't get picked up for output file tracing.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
