import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// React 19 preloads every image it renders in the shell. These pages never
// did, and the mascots are small, so the head stays as it was.
const IMAGE_PRELOAD = /<link rel="preload" as="image" href="[^"]*"\/>/g;

// Server pages are plain HTML with inline scripts and never hydrate, so
// static markup is all they need.
export function renderPage(c: Context, page: ReactElement, status?: ContentfulStatusCode): Response {
  return c.html(renderToStaticMarkup(page).replace(IMAGE_PRELOAD, ""), status);
}
