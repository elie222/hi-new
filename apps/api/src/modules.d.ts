// Stylesheets are inlined into server-rendered pages as text.
declare module "*.css" {
  const css: string;
  export default css;
}

// wrangler bundles `.wasm` imports as WebAssembly modules (workerd "CompiledWasm").
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// Untyped internals of harfbuzzjs, imported by path from src/lib/harfbuzz-worker.ts.
declare module "*/harfbuzzjs/hb.js" {
  type EmscriptenModule = Record<string, unknown>;
  type Imports = WebAssembly.Imports;
  const createHarfBuzz: (options?: {
    instantiateWasm?: (
      imports: Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => Record<string, never>;
  }) => Promise<EmscriptenModule>;
  export default createHarfBuzz;
}

declare module "*/harfbuzzjs/hbjs.js" {
  const hbjs: (module: Record<string, unknown>) => unknown;
  export default hbjs;
}
