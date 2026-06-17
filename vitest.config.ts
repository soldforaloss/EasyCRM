import { defineConfig } from "vitest/config";

// Vitest runs the isolated, pure/server-side modules (crypto, phone, merge, brevo client,
// data-access helpers) in a Node environment. We deliberately do NOT load the React Router
// Vite plugin here — these tests exercise plain TS modules, not the app server.
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}"],
    clearMocks: true,
  },
});
