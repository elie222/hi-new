import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const workspace = resolve(import.meta.dir, "..");
const resultsDir = resolve(process.env.PLAYWRIGHT_TEST_RESULTS_DIR ?? join(workspace, "test-results"));
const outputDir = resolve(process.env.E2E_GALLERY_DIR ?? join(workspace, ".e2e-gallery"));
const imagesDir = join(outputDir, "images");

type Screenshot = {
  checkpoint: string;
  file: string;
  height: number;
  project: string;
  source: string;
  title: string;
  width: number;
};

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("not a complete PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function checkpointTitle(checkpoint: string): string {
  return checkpoint
    .replace(/^\d+[a-z]?-/, "")
    .replaceAll("-", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

if (!existsSync(resultsDir)) {
  throw new Error(`Playwright results not found at ${resultsDir}. Run \"bun run e2e\" first.`);
}

const candidates = walk(resultsDir)
  .filter(
    (path) =>
      path.toLowerCase().endsWith(".png") &&
      !relative(resultsDir, path).split(sep).includes("attachments"),
  )
  .map((path) => ({ path, modifiedAt: statSync(path).mtimeMs }));
if (candidates.length === 0) {
  throw new Error(`No Playwright screenshots found below ${resultsDir}.`);
}

// A successful retry supersedes the same checkpoint from an earlier attempt.
const latest = new Map<string, string>();
for (const { path } of candidates.sort((a, b) => a.modifiedAt - b.modifiedAt)) {
  const source = relative(resultsDir, path);
  const testDirectory = source.split(sep)[0] ?? "unknown";
  const project = testDirectory.match(/-(desktop|mobile)(?:-retry\d+)?$/)?.[1] ?? "diagnostic";
  latest.set(`${basename(path).toLowerCase()}:${project}`, path);
}

rmSync(outputDir, { force: true, recursive: true });
mkdirSync(imagesDir, { recursive: true });

const screenshots: Screenshot[] = [];
for (const sourcePath of latest.values()) {
  const buffer = readFileSync(sourcePath);
  const { width, height } = pngDimensions(buffer);
  const checkpoint = basename(sourcePath, ".png");
  const source = relative(resultsDir, sourcePath).split(sep).join("/");
  const testDirectory = relative(resultsDir, dirname(sourcePath)).split(sep)[0] ?? "unknown";
  const project = testDirectory.match(/-(desktop|mobile)(?:-retry\d+)?$/)?.[1] ?? "diagnostic";
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const file = `${checkpoint}-${project}-${hash}.png`;
  copyFileSync(sourcePath, join(imagesDir, file));
  screenshots.push({
    checkpoint,
    file,
    height,
    project,
    source,
    title: checkpointTitle(checkpoint),
    width,
  });
}

screenshots.sort((a, b) => a.checkpoint.localeCompare(b.checkpoint, undefined, { numeric: true }) || a.project.localeCompare(b.project));
const grouped = new Map<string, Screenshot[]>();
for (const screenshot of screenshots) {
  const variants = grouped.get(screenshot.checkpoint) ?? [];
  variants.push(screenshot);
  grouped.set(screenshot.checkpoint, variants);
}
const generatedAt = new Date().toISOString();
const result = process.env.PLAYWRIGHT_RESULT ?? "local";
const reportUrl = process.env.PLAYWRIGHT_REPORT_URL ?? "../playwright-report/index.html";
const runUrl = process.env.PLAYWRIGHT_RUN_URL ?? "";
const runLabel = process.env.PLAYWRIGHT_RUN_NUMBER ? `Run ${process.env.PLAYWRIGHT_RUN_NUMBER}` : "Local run";
const sha = process.env.PLAYWRIGHT_SHA?.slice(0, 8) ?? "working tree";

const cards = [...grouped.entries()]
  .map(([checkpoint, variants]) => {
    const figures = variants
      .map(
        (shot) => `<figure data-project="${escapeHtml(shot.project)}">
  <a href="images/${escapeHtml(shot.file)}" target="_blank" rel="noopener">
    <img src="images/${escapeHtml(shot.file)}" alt="${escapeHtml(shot.title)} — ${escapeHtml(shot.project)}" loading="lazy" width="${shot.width}" height="${shot.height}" />
  </a>
  <figcaption><span>${escapeHtml(shot.project)}</span><span>${shot.width} × ${shot.height}</span></figcaption>
</figure>`,
      )
      .join("\n");
    return `<article class="checkpoint" id="${escapeHtml(checkpoint)}" data-checkpoint="${escapeHtml(checkpoint)}">
  <div class="checkpoint-head"><span class="sequence">${escapeHtml(checkpoint.match(/^\d+[a-z]?/)?.[0] ?? "!")}</span><h2>${escapeHtml(checkpointTitle(checkpoint))}</h2></div>
  <div class="variants">${figures}</div>
</article>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>hi.new Playwright screenshots</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:#1d2533; background:#f3f6fb; }
    * { box-sizing:border-box; }
    body { margin:0; }
    header { position:sticky; top:0; z-index:5; padding:20px clamp(18px,4vw,48px); border-bottom:1px solid #dce3ef; background:rgba(255,255,255,.94); backdrop-filter:blur(18px); }
    .top { max-width:1500px; margin:auto; display:flex; align-items:center; justify-content:space-between; gap:18px; flex-wrap:wrap; }
    h1 { margin:0; font-size:clamp(22px,3vw,34px); letter-spacing:-.035em; }
    .brand { color:#2563eb; }
    .meta { display:flex; align-items:center; gap:9px; color:#647087; font-size:13px; flex-wrap:wrap; }
    .status { padding:5px 9px; border-radius:999px; font-weight:700; background:${result === "success" || result === "local" ? "#dcfce7;color:#16713c" : "#fee2e2;color:#a82323"}; }
    nav { display:flex; gap:8px; margin-top:14px; max-width:1500px; margin-inline:auto; }
    button, .link { border:1px solid #d5deeb; border-radius:9px; background:#fff; color:#38445a; padding:7px 11px; font:600 13px inherit; text-decoration:none; cursor:pointer; }
    button.active { color:#fff; border-color:#2563eb; background:#2563eb; }
    main { max-width:1500px; margin:0 auto; padding:30px clamp(14px,3vw,40px) 80px; }
    .checkpoint { margin-bottom:36px; scroll-margin-top:130px; }
    .checkpoint-head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
    .sequence { min-width:34px; color:#2563eb; font:700 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    h2 { margin:0; font-size:17px; letter-spacing:-.01em; }
    .variants { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr)); align-items:start; gap:16px; }
    figure { min-width:0; margin:0; padding:10px; border:1px solid #dce3ef; border-radius:15px; background:#fff; box-shadow:0 8px 30px rgba(34,55,92,.07); }
    figure a { display:flex; justify-content:center; min-height:180px; max-height:720px; overflow:auto; border-radius:10px; background:linear-gradient(135deg,#edf2f8,#f8fafc); }
    img { display:block; width:100%; height:auto; align-self:flex-start; }
    figcaption { display:flex; justify-content:space-between; gap:12px; padding:9px 3px 1px; color:#707c90; font:600 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; }
    .empty { display:none !important; }
    @media (max-width:600px) { header { position:static; } .variants { grid-template-columns:1fr; } figure { padding:7px; } }
  </style>
</head>
<body>
  <header>
    <div class="top">
      <div><h1><span class="brand">hi.new</span> flow screenshots</h1><div class="meta"><span>${escapeHtml(runLabel)}</span><span>·</span><span>${escapeHtml(sha)}</span><span>·</span><span>${screenshots.length} screenshots</span><span>·</span><span>${escapeHtml(generatedAt)}</span></div></div>
      <div class="meta"><span class="status">${escapeHtml(result)}</span>${runUrl ? `<a class="link" href="${escapeHtml(runUrl)}">CI run</a>` : ""}<a class="link" href="${escapeHtml(reportUrl)}">Playwright report</a></div>
    </div>
    <nav aria-label="Screenshot filters"><button class="active" data-filter="all">All</button><button data-filter="desktop">Desktop</button><button data-filter="mobile">Mobile</button></nav>
  </header>
  <main>${cards}</main>
  <script>
    document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll("figure[data-project]").forEach((figure) => figure.classList.toggle("empty", filter !== "all" && figure.dataset.project !== filter));
      document.querySelectorAll(".checkpoint").forEach((card) => card.classList.toggle("empty", !card.querySelector("figure:not(.empty)")));
    }));
  </script>
</body>
</html>`;

const manifest = {
  generatedAt,
  result,
  run: {
    branch: process.env.PLAYWRIGHT_BRANCH ?? null,
    id: process.env.PLAYWRIGHT_RUN_ID ?? null,
    number: process.env.PLAYWRIGHT_RUN_NUMBER ?? null,
    sha: process.env.PLAYWRIGHT_SHA ?? null,
    url: runUrl || null,
  },
  screenshots,
};

writeFileSync(join(outputDir, "index.html"), html);
writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${outputDir}/index.html with ${screenshots.length} screenshots.`);
