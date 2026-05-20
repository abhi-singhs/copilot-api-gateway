import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/server.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  shims: true,
  banner: ({ format }) => (format === "esm" ? { js: "#!/usr/bin/env node" } : {}),
});
