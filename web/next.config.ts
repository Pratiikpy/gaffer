import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: allow the loopback origins used for local QA. Next 16 blocks cross-origin
  // dev-resource requests by default, which stops the client bundle hydrating over 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // The repo has nested lockfiles; pin the workspace root so Turbopack stops warning and picks the app dir.
  turbopack: { root: __dirname },
};

export default nextConfig;
