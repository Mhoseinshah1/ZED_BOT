import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// =============================================================================
// Build configuration.
//
// `base` is "/miniapp/", not "/". Every emitted asset URL is therefore written
// relative to that prefix, so the bundle works when Nginx serves it from a
// sub-path. A root-relative "/assets/..." would 404 the moment the app is not
// at the domain root, and it would also let a request escape the one location
// block that carries the Mini App's framing exception.
//
// Filenames are content-hashed. That is what makes the immutable caching in
// front of them safe: a changed file gets a new name, so a cached copy can
// never be the wrong copy, and a deploy never needs a cache purge.
//
// NOTHING user-specific is baked in. The bundle is one artifact served to every
// visitor; anything personal arrives at runtime over an authenticated request.
// Only `VITE_`-prefixed variables are visible to the client code, and the only
// one this app reads is a public bot username used to build a t.me link.
// =============================================================================

export default defineConfig({
  base: "/miniapp/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Modern Telegram WebViews on both platforms are current Chromium/WebKit;
    // there is no legacy browser to serve here.
    target: "es2022",
    sourcemap: false,
    assetsDir: "assets",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 5173,
    // Local development proxies the API so the browser sees ONE origin, exactly
    // as production does. Without this the session cookie would be cross-site
    // in dev and the SameSite=Lax behaviour would differ from production - the
    // worst kind of environment difference to debug.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
