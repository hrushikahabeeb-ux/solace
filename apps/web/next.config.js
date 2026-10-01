/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  transpilePackages: ['@solace/crypto'],
  webpack(config) {
    // packages/crypto's source uses `.js`-suffixed relative imports (e.g.
    // `from './identity.js'`) even though only `.ts` files exist — that's the
    // correct, standard convention for a Node ESM + TypeScript package (required by
    // apps/server's tsx runtime). Webpack, unlike Node's own ESM loader, doesn't
    // resolve `.js` specifiers to `.ts` files by default, so without this it can't
    // find the crypto package's modules at all. This tells it to try `.ts`/`.tsx`
    // whenever a `.js` import doesn't resolve to an actual `.js` file.
    config.resolve.extensionAlias = {
      '.js': ['.js', '.ts', '.tsx'],
    };

    return config;
  },
};
