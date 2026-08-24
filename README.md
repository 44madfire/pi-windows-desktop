# Pi Windows Desktop

A native Windows desktop workbench for the Pi coding agent, with Pi and project execution kept inside WSL.

## Architecture direction

- Windows desktop owns presentation, orchestration, and workbench UX.
- WSL owns Pi, Git, filesystem operations, project commands, MCP servers, and terminals.
- Linux paths are canonical internally; Windows/UNC paths are created only at Windows integration boundaries.
- Pi runtime RPC is kept separate from workspace operations such as Git and file access.

## Current milestone

M0 now includes the Windows/WSL/Pi substrate, WSL distro/workspace selection, Pi JSONL startup/status events, and a session cursor recovery seam.

See the implementation plan provided with this project for the complete milestone sequence.

Reference architecture notes are tracked in [docs/reference-study.md](docs/reference-study.md). Local study checkouts, when present, live under the ignored `.reference-repos/` directory.
