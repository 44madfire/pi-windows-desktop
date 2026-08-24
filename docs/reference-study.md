# Reference study

The local `.reference-repos/` directory contains shallow, ignored checkouts of the implementation references named in the project plan. They are for architecture study only; their source is not vendored into this repository.

## Decisions carried into M0

- `justhil/pi-app`: Electron/React conventions, WSL output decoding, explicit `wsl.exe` argument handling, and the distinction between Linux-canonical paths and Windows integration paths.
- `DLYZZT/pi-desktop`: isolated host-process direction, typed renderer-to-host messaging, and restart supervision patterns.
- `StarkInternationalAI/pi-desktop`: Pi RPC/session adapter shape and extension-driven UI boundary.
- `AJSubrizi/Pi-App`: Pi remains authoritative for models, auth, sessions, and packages; plans and subagents remain capability/package concerns.
- `anomalyco/opencode`: WSL lifecycle and diagnostics are a future comparison source; only a partial sparse checkout may be available locally when network access is restricted.

## Source links

- https://github.com/justhil/pi-app
- https://github.com/DLYZZT/pi-desktop
- https://github.com/StarkInternationalAI/pi-desktop
- https://github.com/AJSubrizi/Pi-App
- https://github.com/anomalyco/opencode

