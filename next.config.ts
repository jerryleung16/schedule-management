import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_ACTIONS === "true";

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : undefined,
  trailingSlash: true,
  basePath: isGitHubPages ? "/schedule-management" : "",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
