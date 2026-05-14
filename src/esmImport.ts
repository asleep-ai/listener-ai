// Dynamic ESM import that survives tsc's CJS rewrite. With
// `module: "commonjs"` in tsconfig.json, a plain `import('pkg')` compiles to
// `Promise.resolve().then(() => require('pkg'))`, which fails on ESM-only
// packages with ERR_REQUIRE_ESM. `Function(...)` evaluates at runtime, so the
// literal `import()` survives untouched and stays an actual dynamic import.
//
// Use this for any ESM-only dependency (`@earendil-works/pi-ai`,
// `@earendil-works/pi-ai/oauth`).
export const importEsm = (() => {
  const fn = new Function('specifier', 'return import(specifier)') as <T>(
    specifier: string,
  ) => Promise<T>;
  return fn;
})();
