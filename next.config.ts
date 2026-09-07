import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.GITHUB_ACTIONS ? "export" : undefined,
  trailingSlash: true,
  basePath: process.env.GITHUB_ACTIONS ? "/schedule-management" : "",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
