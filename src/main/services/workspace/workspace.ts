import { isValidWslDistributionName } from '../../wsl/index.ts';
import type { WslCommandResult } from '../../wsl/index.ts';

/**
 * Canonical identity of a Linux workspace inside one WSL distribution.
 *
 * Both fields are validated before any command is launched. Windows-style
 * paths are rejected, never translated into WSL mount paths.
 */
export interface LinuxWorkspace {
  readonly distro: string;
  readonly linuxPath: string;
}

/**
 * The process boundary for workspace commands. WslService satisfies this
 * structurally; tests inject deterministic runners that never touch WSL, and
 * the later IPC wiring slice can supply its own runner without a full WSL
 * service dependency.
 */
export interface WorkspaceCommandRunner {
  runInDistribution(
    distribution: string,
    executable: string,
    args?: readonly string[],
  ): Promise<WslCommandResult>;
}

export class WorkspaceInputError extends Error {
  readonly code = 'WORKSPACE_INPUT_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceInputError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validate and normalize a `{ distro, linuxPath }` workspace input. Throws
 * WorkspaceInputError for anything that cannot be addressed as an absolute
 * POSIX path inside a named WSL distro.
 */
export function validateLinuxWorkspace(value: unknown): LinuxWorkspace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceInputError('workspace must be an object with distro and linuxPath');
  }

  const record = value as Record<string, unknown>;
  const distro = record.distro;
  if (typeof distro !== 'string' || !isValidWslDistributionName(distro)) {
    throw new WorkspaceInputError(`Invalid WSL distribution name: ${String(distro)}`);
  }

  const rawPath = record.linuxPath;
  if (typeof rawPath !== 'string') {
    throw new WorkspaceInputError('linuxPath must be a string');
  }
  return { distro, linuxPath: validateLinuxPath(rawPath) };
}

/**
 * Validate one Linux path, matching the canonical WSL workspace validator.
 * Rejects non-absolute paths, NUL and other control characters, backslashes
 * (so a Windows path is rejected instead of translated), dot segments, double
 * slashes, and trailing slashes (root `/` is the one exception).
 */
export function validateLinuxPath(linuxPath: string): string {
  if (linuxPath.length === 0) {
    throw new WorkspaceInputError('linuxPath must not be empty');
  }
  if (!linuxPath.startsWith('/')) {
    throw new WorkspaceInputError(
      `linuxPath must be an absolute POSIX path: ${String(linuxPath)}`,
    );
  }
  if (/[\u0000-\u001f\u007f\\]/.test(linuxPath)) {
    throw new WorkspaceInputError(
      'linuxPath must not contain control characters or backslashes; Windows paths are not translated',
    );
  }
  if (linuxPath !== '/' && (linuxPath.includes('//') || linuxPath.endsWith('/'))) {
    throw new WorkspaceInputError(
      `linuxPath must be canonical (no double or trailing slashes): ${String(linuxPath)}`,
    );
  }
  if (linuxPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new WorkspaceInputError(
      `linuxPath must not contain dot segments: ${String(linuxPath)}`,
    );
  }
  return linuxPath;
}
