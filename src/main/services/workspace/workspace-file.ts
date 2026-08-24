import { Buffer } from 'node:buffer';

import type { WslCommandResult } from '../../wsl/index.ts';
import { WslService } from '../../wsl/index.ts';
import type { LinuxWorkspace, WorkspaceCommandRunner } from './workspace.ts';
import { validateLinuxWorkspace } from './workspace.ts';

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
  readonly content: string;
  readonly byteLength: number;
  readonly result: WslCommandResult;
}

/**
 * Proof service for reading one UTF-8 workspace file inside a WSL distro.
 *
 * The file is addressed as an absolute Linux path and read with `cat -- <path>`
 * so every argument stays a distinct argv entry; no shell is involved and no
 * Windows path is ever translated.
 */
export class WorkspaceFileService {
  private readonly runner: WorkspaceCommandRunner;

  constructor(runner: WorkspaceCommandRunner = new WslService()) {
    this.runner = runner;
  }

  async readFile(input: unknown): Promise<WorkspaceFileReadResult> {
    const workspace = validateLinuxWorkspace(input);
    let result: WslCommandResult;
    try {
      result = await this.runner.runInDistribution(workspace.distro, 'cat', [
        '--',
        workspace.linuxPath,
      ]);
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
        `Failed to read ${workspace.linuxPath}`,
        { result },
      );
    }

    return {
      workspace,
      content: result.stdout,
      byteLength: Buffer.byteLength(result.stdout, 'utf8'),
      result,
    };
  }
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
