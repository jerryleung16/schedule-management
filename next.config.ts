import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_ACTIONS === "true";
const localHeaders: Pick<NextConfig, "headers"> = isGitHubPages ? {} : {
  headers: async () => [{
    source: "/(.*)",
    headers: [{ key: "Cross-Origin-Opener-Policy", value: "unsafe-none" }],
  }],
};

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : undefined,
  trailingSlash: true,
  basePath: isGitHubPages ? "/schedule-management" : "",
  ...localHeaders,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
