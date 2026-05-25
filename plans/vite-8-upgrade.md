# Vite 8 Upgrade Plan

## Overview
Upgrade the frontend workspace from Vite 5 to Vite 8 to leverage the new Rolldown (Rust-based) bundler, which promises significant build time improvements on resource-constrained devices like the Raspberry Pi 4B.

## Current State
- `vite` is at `^5.4.0`
- `@vitejs/plugin-react` is at `^4.3.0`
- `vite.config.ts` does not use `rollupOptions.manualChunks`, `esbuild` specific options, or `define` objects that would trigger breaking changes in Vite 8.
- Node.js (via bun) supports the required native APIs.
- Rolldown has pre-compiled binaries for `aarch64-linux-gnu` (`@rolldown/binding-linux-arm64-gnu`).

## Execution Steps
1. **Dependency Update:**
   Update `packages/frontend/package.json`:
   - `"vite": "^8.0.0"`
   - `"@vitejs/plugin-react": "^6.0.0"`

2. **Install:**
   Run `bun install` to update the lockfile and download the new packages.

3. **Validation - Typecheck:**
   Run `bun run typecheck` to ensure no typing breaks in the frontend due to updated Vite plugins.

4. **Validation - Production Build:**
   Run `bun run build` (which maps to `bun run --filter @pwe/frontend build`). This will use the new Rolldown bundler. We need to verify that it completes successfully without errors on this architecture.

5. **Validation - Dev Server:**
   Run the development server briefly to verify the new unified bundler works for local development as well.

## Risks
- **Rolldown aarch64 compatibility:** Although the npm package has the binding for our architecture, running it in the specific Debian 13 Trixie environment might expose missing GLIBC dependencies or other native integration issues. The `bun run build` step will immediately validate this.

## Rollback
If the build fails or dev server is unstable, we will revert the `package.json` changes, run `bun install` to downgrade, and delete this branch.