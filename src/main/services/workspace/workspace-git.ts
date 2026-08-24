import type { WslCommandResult } from '../../wsl/index.ts';
import { WslService } from '../../wsl/index.ts';
import type { LinuxWorkspace, WorkspaceCommandRunner } from './workspace.ts';
import { validateLinuxWorkspace } from './workspace.ts';

export interface GitStatusEntry {
  readonly path: string;
  readonly xy: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly renamedFrom?: string;
}

export type WorkspaceGitStatus =
  | {
      readonly kind: 'ok';
      readonly workspace: LinuxWorkspace;
      readonly branch: string | null;
      readonly entries: readonly GitStatusEntry[];
      readonly raw: string;
      readonly result: WslCommandResult;
    }
  | {
      readonly kind: 'not-a-repository';
      readonly workspace: LinuxWorkspace;
      readonly result: WslCommandResult;
    }
  | {
      readonly kind: 'git-unavailable';
      readonly workspace: LinuxWorkspace;
      readonly result: WslCommandResult;
    };

export class WorkspaceGitError extends Error {
  readonly code = 'WORKSPACE_GIT_ERROR' as const;
  readonly workspace: LinuxWorkspace;
  readonly result: WslCommandResult | null;
  readonly cause: unknown;

  constructor(
    workspace: LinuxWorkspace,
    detail: string,
    options: { readonly result?: WslCommandResult | null; readonly cause?: unknown } = {},
  ) {
    const suffix = options.result
      ? firstLine(options.result.stderr)
      : options.cause instanceof Error
        ? options.cause.message
        : '';
    super(suffix.length > 0 ? `${detail}: ${suffix}` : detail);
    this.name = 'WorkspaceGitError';
    this.workspace = workspace;
    this.result = options.result ?? null;
    this.cause = options.cause ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Proof service for reading porcelain Git status of a workspace directory
 * inside a WSL distro.
 *
 * Runs `git -C <linuxPath> status --porcelain=v1 --branch` with a fixed argv,
 * so paths are never interpolated into a shell. Non-repositories and missing
 * git binaries soft-fail with the raw command result; every other failure is
 * thrown as a typed error that preserves stderr.
 */
export class WorkspaceGitService {
  private readonly runner: WorkspaceCommandRunner;

  constructor(runner: WorkspaceCommandRunner = new WslService()) {
    this.runner = runner;
  }

  async gitStatus(input: unknown): Promise<WorkspaceGitStatus> {
    const workspace = validateLinuxWorkspace(input);
    let result: WslCommandResult;
    try {
      result = await this.runner.runInDistribution(workspace.distro, 'git', [
        '-C',
        workspace.linuxPath,
        'status',
        '--porcelain=v1',
        '--branch',
      ]);
    } catch (cause) {
      throw new WorkspaceGitError(workspace, `Unable to start git in ${workspace.distro}`, {
        cause,
      });
    }

    if (!result.ok) {
      return classifyGitFailure(workspace, result);
    }

    return {
      kind: 'ok',
      workspace,
      branch: parseGitStatusBranch(result.stdout),
      entries: parseGitStatusEntries(result.stdout),
      raw: result.stdout,
      result,
    };
  }
}

function classifyGitFailure(
  workspace: LinuxWorkspace,
  result: WslCommandResult,
): WorkspaceGitStatus {
  const detail = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode === 128 && /not a git repository/i.test(detail)) {
    return { kind: 'not-a-repository', workspace, result };
  }
  if (result.exitCode === 127 || /(?:command )?not found/i.test(detail)) {
    return { kind: 'git-unavailable', workspace, result };
  }
  throw new WorkspaceGitError(workspace, `git status failed for ${workspace.linuxPath}`, {
    result,
  });
}

/**
 * Parse the branch from the `## <branch>` header line emitted by
 * `git status --branch`. Detached HEAD and unborn branches map to the branch
 * name or null, matching porcelain v1 output.
 */
export function parseGitStatusBranch(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('## ')) continue;
    const rest = line.slice(3);
    if (rest === 'HEAD (no branch)') return null;
    if (rest.startsWith('No commits yet on ')) {
      return rest.slice('No commits yet on '.length) || null;
    }
    if (rest.startsWith('Initial commit on ')) {
      return rest.slice('Initial commit on '.length) || null;
    }
    const branch = rest.split(/\.\.\.| /, 1)[0];
    return branch.length > 0 ? branch : null;
  }
  return null;
}

/**
 * Parse porcelain v1 status lines (two status characters, space, path).
 * Rename/copy lines carry `orig -> new` in the path column. Only rename (`R`)
 * and copy (`C`) statuses use that delimiter, so a ` -> ` inside any other
 * path is literal text. `path` is the active/new path and `renamedFrom` the
 * original path.
 */
export function parseGitStatusEntries(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('## ')) continue;

    const xy = line.slice(0, 2);
    const pathPart = line.slice(3);
    const isRenameOrCopy =
      xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    const arrowIndex = isRenameOrCopy ? pathPart.indexOf(' -> ') : -1;
    const path = arrowIndex === -1 ? pathPart : pathPart.slice(arrowIndex + 4);
    const renamedFrom = arrowIndex === -1 ? undefined : pathPart.slice(0, arrowIndex);

    const indexStatus = xy[0];
    const worktreeStatus = xy[1];
    const untracked = xy === '??';
    entries.push({
      path,
      xy,
      indexStatus,
      worktreeStatus,
      staged: !untracked && indexStatus !== ' ',
      unstaged: !untracked && worktreeStatus !== ' ',
      untracked,
      ...(renamedFrom === undefined ? {} : { renamedFrom }),
    });
  }
  return entries;
}

function firstLine(value: string): string {
  const line = value.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 0 ? line : '';
}
