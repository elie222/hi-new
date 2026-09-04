// Workers-only stand-in for the `harfbuzzjs` package entry (satori's text shaper).
// wrangler.jsonc aliases `harfbuzzjs` here for the Worker bundle; bun tests use
// the real package, which reads hb.wasm from disk.
//
// The stock entry lets emscripten's glue fetch hb.wasm relative to
// `self.location.href`, which workerd has no notion of. Instead the wasm is a
// module import (precompiled by wrangler) handed to the glue via its
// `instantiateWasm` hook. The glue still evaluates
// `typeof __filename != "undefined" ? __filename : self.location.href`
// synchronously on entry, so `__filename` is shimmed for exactly that prologue.
// The real files are reached by path: the alias rewrites every `harfbuzzjs/*`
// subpath to this file, so they cannot be imported by their package name here.
// (harfbuzzjs is a direct dependency so apps/api/node_modules/harfbuzzjs exists.)
import createHarfBuzz from "../../node_modules/harfbuzzjs/hb.js";
import hbjs from "../../node_modules/harfbuzzjs/hbjs.js";

async function load(): Promise<unknown> {
  type Em = Record<string, unknown>;
  const hbWasm = (await import("../../node_modules/harfbuzzjs/hb.wasm")).default;
  // workerd's nodejs_compat also exposes `process.versions.node`, which sends the
  // glue down its Node branch (`scriptDirectory = __dirname + "/"`), so both
  // CommonJS globals are shimmed for the synchronous prologue only.
  const g = globalThis as { __filename?: string; __dirname?: string };
  const shim = !("__filename" in g) && !("__dirname" in g);
  if (shim) {
    g.__filename = "/hb.js";
    g.__dirname = "/";
  }
  let ready: Promise<Em>;
  try {
    ready = createHarfBuzz({
      instantiateWasm(imports, done) {
        // Typed as unknown: lib typings disagree on whether instantiate(Module)
        // resolves to an Instance or an { instance, module } pair.
        WebAssembly.instantiate(hbWasm, imports).then((result: unknown) => {
          const instance =
            result instanceof WebAssembly.Instance
              ? result
              : (result as { instance: WebAssembly.Instance }).instance;
          done(instance, hbWasm);
        });
        return {};
      },
    });
  } finally {
    if (shim) {
      delete g.__filename;
      delete g.__dirname;
    }
  }
  return ready.then((module) => hbjs(module));
}

export default load();
