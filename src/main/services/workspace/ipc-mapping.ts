import type {
  WorkspaceFileReadResponse,
  WorkspaceGitStatusEntry,
  WorkspaceGitStatusResponse,
} from '../../../shared/ipc.ts';
import { WorkspaceFileError, type WorkspaceFileReadResult } from './workspace-file.ts';
import { WorkspaceGitError, type GitStatusEntry, type WorkspaceGitStatus } from './workspace-git.ts';
import { WorkspaceInputError } from './workspace.ts';

/**
 * Narrow structural views of the workspace services. Production instances
 * satisfy these; tests inject deterministic fakes without constructing a WSL
 * runner.
 */
export interface WorkspaceFileReader {
  readFile(input: unknown): Promise<WorkspaceFileReadResult>;
}

export interface WorkspaceGitReader {
  gitStatus(input: unknown): Promise<WorkspaceGitStatus>;
}

/**
 * Run a workspace file read and normalize it to the wire envelope. The
 * service's internal WslCommandResult is dropped; expected failures become
 * typed `{ok:false,...}` values while unexpected errors keep propagating so
 * they surface as rejected invokes instead of fake workspace results.
 */
export async function readWorkspaceFileEnvelope(
  fileService: WorkspaceFileReader,
  input: unknown,
): Promise<WorkspaceFileReadResponse> {
  try {
    const result = await fileService.readFile(input);
    return {
      ok: true,
      workspace: result.workspace,
      content: result.content,
      byteLength: result.byteLength,
    };
  } catch (error) {
    return mapWorkspaceFileReadFailure(error);
  }
}

function mapWorkspaceFileReadFailure(error: unknown): WorkspaceFileReadResponse {
  if (error instanceof WorkspaceInputError) {
    return { ok: false, reason: 'invalid-workspace', message: error.message };
  }
  if (error instanceof WorkspaceFileError) {
    return { ok: false, reason: error.reason, message: error.message };
  }
  throw error;
}

/**
 * Run a workspace git status and normalize it to the wire envelope. Soft
 * failures (`not-a-repository`, `git-unavailable`) are expected results and
 * become typed `{ok:false,...}` values; the porcelain raw text and the
 * internal WslCommandResult never cross the wire.
 */
export async function gitStatusEnvelope(
  gitService: WorkspaceGitReader,
  input: unknown,
): Promise<WorkspaceGitStatusResponse> {
  try {
    const result = await gitService.gitStatus(input);
    return mapWorkspaceGitStatus(result);
  } catch (error) {
    return mapWorkspaceGitStatusFailure(error);
  }
}

function mapWorkspaceGitStatus(result: WorkspaceGitStatus): WorkspaceGitStatusResponse {
  if (result.kind === 'ok') {
    return {
      ok: true,
      workspace: result.workspace,
      branch: result.branch,
      entries: result.entries.map(mapGitStatusEntry),
    };
  }
  if (result.kind === 'not-a-repository' || result.kind === 'git-unavailable') {
    return {
      ok: false,
      reason: result.kind,
      message:
        result.kind === 'not-a-repository'
          ? `${result.workspace.linuxPath} is not a git repository`
          : `git is unavailable in ${result.workspace.distro}`,
    };
  }
  // Exhaustiveness guard: a new service result kind forces a compile error.
  const unexpected: never = result;
  throw new WorkspaceGitError(
    { distro: '', linuxPath: '' },
    `git status returned an unrecognized result kind: ${String(unexpected)}`,
  );
}

function mapGitStatusEntry(entry: GitStatusEntry): WorkspaceGitStatusEntry {
  const mapped: WorkspaceGitStatusEntry = {
    path: entry.path,
    xy: entry.xy,
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    staged: entry.staged,
    unstaged: entry.unstaged,
    untracked: entry.untracked,
  };
  if (entry.renamedFrom !== undefined) {
    mapped.renamedFrom = entry.renamedFrom;
  }
  return mapped;
}

function mapWorkspaceGitStatusFailure(error: unknown): WorkspaceGitStatusResponse {
  if (error instanceof WorkspaceInputError) {
    return { ok: false, reason: 'invalid-workspace', message: error.message };
  }
  if (error instanceof WorkspaceGitError) {
    return { ok: false, reason: 'command-failed', message: error.message };
  }
  throw error;
}
