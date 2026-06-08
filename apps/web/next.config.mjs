/** @type {import('next').NextConfig} */
const nextConfig = {
  // All `/api/*` calls are served by the Next.js route handlers in app/api/**.
  // COGO, traverse, CRS, CSV import and validation run in-process, so the app is
  // fully self-contained and deploys to Vercel with no separate backend.
  //
  // To instead proxy to the standalone Express backend (apps/api) during local
  // development, set API_PROXY and uncomment the rewrite below.
  //
  // async rewrites() {
  //   if (!process.env.API_PROXY) return [];
  //   return [{ source: "/api/:path*", destination: `${process.env.API_PROXY}/api/:path*` }];
  // },
};

export default nextConfig;
