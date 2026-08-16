/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Stripe webhook route needs the raw body for signature verification.
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
