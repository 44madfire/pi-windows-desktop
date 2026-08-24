# Reference study

The local `.reference-repos/` directory contains shallow, ignored checkouts of
the implementation references named in the project plan. They are for
architecture study only; their source is not vendored into this repository.

## Pinned checkouts

- `.reference-repos/justhil__pi-app/` — `justhil/pi-app` at
  `c5ad2f4dccb4225e786c05d5f67b375ab40c4f8f` (`main`); Electron/React
  conventions, WSL output decoding, explicit `wsl.exe` argument handling, and
  Linux-canonical versus Windows integration paths.
- `.reference-repos/DLYZZT__pi-desktop/` — `DLYZZT/pi-desktop` at
  `08502be45f4f8c22da5ad563c9b6f0e37315cc97` (`main`, `v0.1.14`);
  isolated host-process direction, typed renderer-to-host messaging, and
  restart supervision patterns.
- `.reference-repos/StarkInternationalAI__pi-desktop/` —
  `StarkInternationalAI/pi-desktop` at
  `7ffbc1606475a22bfbcec4252ab0577b821305ff` (`main`); Pi RPC/session
  adapter shape and extension-driven UI boundary.
- `.reference-repos/AJSubrizi__Pi-App/` — `AJSubrizi/Pi-App` at
  `a3dc3cfbdec6db82fb9cc21fbd2605ff83499f1d` (`main`); Pi remains
  authoritative for models, auth, sessions, and packages, while plans and
  subagents remain capability/package concerns.
- `.reference-repos/anomalyco__opencode/` — `anomalyco/opencode` at
  `f4019cab3eb832108f337caaf55d51a9ab7dd860` (`dev`); WSL lifecycle and
  diagnostics comparison source. Relevant paths are
  `packages/desktop/src/main/wsl/` and `packages/desktop/src/main/`.

All five checkouts are public upstream repositories cloned read-only with
`--depth 1`. OpenCode uses `dev` as its default branch; the legacy
`sst/opencode` name should not be used for new clones.

## Decisions carried into M0

- `justhil/pi-app`: Electron/React conventions, WSL output decoding, explicit
  `wsl.exe` argument handling, and the distinction between Linux-canonical
  paths and Windows integration paths.
- `DLYZZT/pi-desktop`: isolated host-process direction, typed
  renderer-to-host messaging, and restart supervision patterns.
- `StarkInternationalAI/pi-desktop`: Pi RPC/session adapter shape and
  extension-driven UI boundary.
- `AJSubrizi/Pi-App`: Pi remains authoritative for models, auth, sessions, and
  packages; plans and subagents remain capability/package concerns.
- `anomalyco/opencode`: WSL lifecycle and diagnostics are a future comparison
  source; its WSL implementation lives under
  `packages/desktop/src/main/wsl/`.

## Source links

- https://github.com/justhil/pi-app
- https://github.com/DLYZZT/pi-desktop
- https://github.com/StarkInternationalAI/pi-desktop
- https://github.com/AJSubrizi/Pi-App
- https://github.com/anomalyco/opencode
