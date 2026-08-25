import { Buffer } from 'node:buffer';

import type { WslCommandResult } from '../../wsl/index.ts';
import { WslService } from '../../wsl/index.ts';
import type { LinuxWorkspace, WorkspaceCommandRunner } from './workspace.ts';
import { validateLinuxWorkspace, WorkspaceInputError } from './workspace.ts';

export type WorkspaceFileFailureReason = 'not-found' | 'is-directory' | 'command-failed';

export class WorkspaceFileError extends Error {
  readonly code = 'WORKSPACE_FILE_ERROR' as const;
  readonly workspace: LinuxWorkspace;
  readonly reason: WorkspaceFileFailureReason;
  readonly result: WslCommandResult | null;
  readonly cause: unknown;

  constructor(
    workspace: LinuxWorkspace,
    reason: WorkspaceFileFailureReason,
    detail: string,
    options: { readonly result?: WslCommandResult | null; readonly cause?: unknown } = {},
  ) {
    const suffix = options.result
      ? firstLine(options.result.stderr)
      : options.cause instanceof Error
        ? options.cause.message
        : '';
    super(suffix.length > 0 ? `${detail} (${reason}): ${suffix}` : `${detail} (${reason})`);
    this.name = 'WorkspaceFileError';
    this.workspace = workspace;
    this.reason = reason;
    this.result = options.result ?? null;
    this.cause = options.cause ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface WorkspaceFileReadResult {
  readonly workspace: LinuxWorkspace;
  readonly relativePath: string;
  readonly content: string;
  readonly byteLength: number;
  readonly result: WslCommandResult;
}

/**
 * Proof service for reading one UTF-8 workspace file inside a WSL distro.
 *
 * The file is addressed as a validated workspace root plus a relative POSIX
 * path, joined with a single `/` and read with `cat -- <root>/<relative>` so
 * every argument stays a distinct argv entry; no shell is involved and no
 * Windows path is ever translated. The relative path is validated before the
 * runner is invoked, so traversal or escape attempts never reach WSL.
 */
export class WorkspaceFileService {
  private readonly runner: WorkspaceCommandRunner;

  constructor(runner: WorkspaceCommandRunner = new WslService()) {
    this.runner = runner;
  }

  async readFile(input: unknown, relativePath: string): Promise<WorkspaceFileReadResult> {
    const workspace = validateLinuxWorkspace(input);
    const filePath = validateRelativePath(relativePath);
    // Root is the one validated path ending in a slash; join with a single
    // separator so a root workspace reads /<file> instead of //<file>.
    const target =
      workspace.linuxPath === '/' ? `/${filePath}` : `${workspace.linuxPath}/${filePath}`;
    let result: WslCommandResult;
    try {
      result = await this.runner.runInDistribution(workspace.distro, 'cat', ['--', target]);
    } catch (cause) {
      throw new WorkspaceFileError(
        workspace,
        'command-failed',
        `Unable to start cat in ${workspace.distro}`,
        { cause },
      );
    }

    if (!result.ok) {
      throw new WorkspaceFileError(
        workspace,
        classifyFileFailure(result),
        `Failed to read ${target}`,
        { result },
      );
    }

    return {
      workspace,
      relativePath: filePath,
      content: result.stdout,
      byteLength: Buffer.byteLength(result.stdout, 'utf8'),
      result,
    };
  }
}

/**
 * Validate one relative POSIX file path inside the workspace root. Rejects
 * empty paths, absolute paths, Windows paths (backslashes or a drive-letter
 * prefix), control characters, dot segments, double slashes, and trailing
 * slashes. Every rejected form is one that could escape the root, alias a
 * parent directory, or smuggle a Windows translation into the argv; because
 * the caller joins with a single `/` and these segments are banned, a path
 * that passes here resolves inside the root by construction.
 */
function validateRelativePath(relativePath: string): string {
  if (relativePath.length === 0) {
    throw new WorkspaceInputError('relativePath must not be empty');
  }
  if (relativePath.startsWith('/')) {
    throw new WorkspaceInputError(
      `relativePath must be relative to the workspace root: ${String(relativePath)}`,
    );
  }
  if (/^[A-Za-z]:/.test(relativePath) || /[\u0000-\u001f\u007f\\]/.test(relativePath)) {
    throw new WorkspaceInputError(
      'relativePath must not contain control characters or backslashes; Windows paths are not accepted',
    );
  }
  if (relativePath.includes('//') || relativePath.endsWith('/')) {
    throw new WorkspaceInputError(
      `relativePath must be canonical (no double or trailing slashes): ${String(relativePath)}`,
    );
  }
  if (relativePath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new WorkspaceInputError(
      `relativePath must not contain dot segments: ${String(relativePath)}`,
    );
  }
  return relativePath;
}

function classifyFileFailure(result: WslCommandResult): WorkspaceFileFailureReason {
  const detail = `${result.stderr}\n${result.stdout}`;
  if (/no such file or directory/i.test(detail) || /cannot open/i.test(detail)) {
    return 'not-found';
  }
  if (/is a directory/i.test(detail)) {
    return 'is-directory';
  }
  return 'command-failed';
}

function firstLine(value: string): string {
  const line = value.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 0 ? line : '';
}
