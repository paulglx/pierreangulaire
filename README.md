# pierreangulaire

Medical 3D imaging library for the browser — WebGPU volume rendering, brick-based
streaming, segmentation, viewports and tools. See [`SPECS.md`](./SPECS.md) for the
full specification.

> Scaffold stage: the public API is intentionally empty beyond a `VERSION` export.

## Prerequisites

- Node `>=24` (see `.nvmrc`)
- pnpm `10`

## Setup

```sh
pnpm install
```

## Scripts

| Script              | What it does                                           |
| ------------------- | ------------------------------------------------------ |
| `pnpm build`        | Bundle the library to `dist/` (ESM + types) via tsdown |
| `pnpm dev`          | Rebuild the library on change (tsdown watch)           |
| `pnpm typecheck`    | Type-check with `tsc --noEmit`                         |
| `pnpm lint`         | Lint with oxlint                                       |
| `pnpm format`       | Format with oxfmt                                      |
| `pnpm format:check` | Check formatting without writing                       |
| `pnpm test`         | Run the test suite (Vitest)                            |
| `pnpm test:watch`   | Run Vitest in watch mode                               |
| `pnpm playground`   | Start the Vite playground app                          |
