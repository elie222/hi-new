// Workers require the standalone satori build because runtime wasm compilation
// is unavailable there.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import satori, { init as initYoga } from "satori/standalone";
import type { AppEnv } from "../context";
import { handles } from "../db/schema";
import { COLOR_HEX, effectiveColor, mascotFor, type BotColor } from "@hi-new/ui/bot-colors";
import { checkName } from "@hi-new/domain";

const WIDTH = 1200;
const HEIGHT = 630;
const INK = "#242424";
const BODY = "#3D3D3D";
const MUTED = "#6D6E70";
// The mascot PNGs are opaque on #FEFEFE (satori has no mix-blend-mode), so the
// card's "white" is that exact value and the image box disappears into it.
const WHITE = "#FEFEFE";

function toArrayBuffer(buf: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function readLocalFile(fileUrl: string): Promise<ArrayBuffer> {
  const { readFile } = await import("node:fs/promises");
  return toArrayBuffer(await readFile(decodeURIComponent(new URL(fileUrl).pathname)));
}

async function loadAsset(c: Context<AppEnv>, path: string): Promise<ArrayBuffer> {
  const assets = c.env?.ASSETS;
  if (assets) {
    const res = await assets.fetch(new Request(c.get("origin") + path));
    if (!res.ok) throw new Error(`asset ${path}: ${res.status}`);
    return res.arrayBuffer();
  }
  return readLocalFile(new URL(`../../../landing/public${path}`, import.meta.url).href);
}

// On Workers, wrangler turns a `.wasm` import into a WebAssembly.Module. Under
// bun (tests, scripts) the same import yields a file path, so read the bytes.
async function loadWasm(
  load: () => Promise<{ default: unknown }>,
  specifier: string,
): Promise<WebAssembly.Module | ArrayBuffer> {
  try {
    const mod = (await load()).default;
    if (mod instanceof WebAssembly.Module) return mod;
  } catch {}
  return readLocalFile(import.meta.resolve(specifier));
}

const assetCache = new Map<string, Promise<ArrayBuffer>>();
function cachedAsset(c: Context<AppEnv>, path: string): Promise<ArrayBuffer> {
  let p = assetCache.get(path);
  if (!p) {
    p = loadAsset(c, path).catch((err) => {
      assetCache.delete(path);
      throw err;
    });
    assetCache.set(path, p);
  }
  return p;
}

// Both engines must be initialised exactly once per isolate (a second initWasm
// throws), so the whole setup is memoised as one promise.
let enginesReady: Promise<void> | undefined;
function ensureEngines(): Promise<void> {
  if (!enginesReady) {
    enginesReady = (async () => {
      const [yoga, resvg] = await Promise.all([
        loadWasm(() => import("satori/yoga.wasm"), "satori/yoga.wasm"),
        loadWasm(() => import("@resvg/resvg-wasm/index_bg.wasm"), "@resvg/resvg-wasm/index_bg.wasm"),
      ]);
      await Promise.all([initYoga(yoga), initWasm(resvg)]);
    })().catch((err) => {
      // Let a later request retry rather than pinning the failure.
      enginesReady = undefined;
      throw err;
    });
  }
  return enginesReady;
}

function toBase64(bytes: ArrayBuffer): string {
  let s = "";
  const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

type El = { type: string; props: Record<string, unknown> };
function el(type: string, props: Record<string, unknown>, ...children: (El | string)[]): El {
  return { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
}

function bandTint(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (shift: number) => Math.round(((n >> shift) & 255) * 0.08 + 254 * 0.92);
  return "#" + [16, 8, 0].map((shift) => mix(shift).toString(16).padStart(2, "0")).join("");
}

function card(name: string, mascotDataUri: string, color: BotColor): El {
  const accent = COLOR_HEX[color];
  const chars = name.length + "hi.new/".length;
  const handleSize = chars <= 22 ? 64 : Math.max(34, Math.floor((64 * 22) / chars));
  return el(
    "div",
    {
      style: {
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        // Only the top band is tinted; by 18% (~113px) the card is WHITE. The
        // mascot PNGs are opaque on WHITE, so their box must start below that:
        // paddingTop keeps the centred stack from drifting into the band.
        backgroundImage: `linear-gradient(to bottom, ${bandTint(accent)} 0%, ${WHITE} 18%, ${WHITE} 100%)`,
        paddingTop: 60,
        fontFamily: "Geist",
        color: INK,
      },
    },
    el("img", { src: mascotDataUri, width: 300, height: 300 }),
    el(
      "div",
      {
        style: {
          display: "flex",
          marginTop: 14,
          fontSize: handleSize,
          fontWeight: 700,
          letterSpacing: -handleSize * 0.02,
          lineHeight: 1.15,
        },
      },
      el("span", { style: { color: MUTED } }, "hi.new/"),
      el("span", { style: { color: accent } }, name),
    ),
    el(
      "div",
      { style: { display: "flex", marginTop: 16, fontSize: 28, color: BODY } },
      "Say hi to my bot",
    ),
  );
}

export async function renderOgPng(c: Context<AppEnv>, name: string, color?: string | null): Promise<Uint8Array> {
  const [regular, bold, mascot] = await Promise.all([
    cachedAsset(c, "/fonts/geist-regular.ttf"),
    cachedAsset(c, "/fonts/geist-bold.ttf"),
    cachedAsset(c, mascotFor(name, color)),
    ensureEngines(),
  ]);
  const mascotDataUri = `data:image/png;base64,${toBase64(mascot)}`;
  const svg = await satori(card(name, mascotDataUri, effectiveColor(name, color)) as unknown as Parameters<typeof satori>[0], {
    width: WIDTH,
    height: HEIGHT,
    fonts: [
      { name: "Geist", data: regular, weight: 400, style: "normal" },
      { name: "Geist", data: bold, weight: 700, style: "normal" },
    ],
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } });
  const png = resvg.render().asPng();
  resvg.free();
  return png;
}

// Rendering takes a second or two, which is longer than link crawlers (X in
// particular) wait for an image. Cards are therefore kept in the Worker's
// cache, keyed by their URL, and rendered ahead of time: at claim, on a color
// change, and whenever a profile page is served. The cache is per data
// center, so a profile view also warms the location a crawler is likely to
// hit next. Absent outside Workers (tests, scripts).
function cardCache(): Cache | null {
  const store = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  return store ?? null;
}

function cardUrl(origin: string, name: string): string {
  return `${origin}/og/${name}.png`;
}

function cardResponse(png: Uint8Array): Response {
  return new Response(toArrayBuffer(png), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}

async function renderAndStore(c: Context<AppEnv>, name: string, color: string | null): Promise<Response> {
  const png = await renderOgPng(c, name, color);
  const res = cardResponse(png);
  const cache = cardCache();
  if (cache) await cache.put(new Request(cardUrl(c.get("origin"), name)), res.clone()).catch(() => {});
  return res;
}

export function warmOgCard(c: Context<AppEnv>, name: string, color: string | null): void {
  if (!cardCache()) return;
  c.get("waitUntil")(renderAndStore(c, name, color).catch((err) => console.error("og warm failed", err)));
}

export const ogRoutes = new Hono<AppEnv>();

ogRoutes.get("/og/:file{.+\\.png}", async (c) => {
  const nameCheck = checkName(c.req.param("file").slice(0, -".png".length), { allowHouse: true });
  if (!nameCheck.ok) return c.json({ error: nameCheck.error }, 400);
  const { name } = nameCheck;
  const cached = await cardCache()?.match(new Request(cardUrl(c.get("origin"), name)));
  if (cached) return cached;
  const [handle] = await c
    .get("db")
    .select({ status: handles.status, color: handles.color })
    .from(handles)
    .where(eq(handles.name, name))
    .limit(1);
  const color = handle && handle.status === "active" ? handle.color : null;
  return renderAndStore(c, name, color);
});
