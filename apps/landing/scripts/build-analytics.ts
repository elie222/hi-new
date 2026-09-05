const result = await Bun.build({
  entrypoints: ["../../packages/ui/src/analytics-browser.ts"],
  outdir: "public",
  naming: "site.js",
  target: "browser",
  minify: true,
  define: {
    __POSTHOG_KEY__: JSON.stringify(process.env.PUBLIC_POSTHOG_KEY ?? ""),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
