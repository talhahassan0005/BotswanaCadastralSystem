/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Proxy API calls to the Express backend during development.
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_PROXY ?? "http://localhost:4000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
