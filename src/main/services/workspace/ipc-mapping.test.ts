import assert from 'node:assert/strict';
import test from 'node:test';

import type { WslCommandResult } from '../../wsl/index.ts';
import {
  gitStatusEnvelope,
  readWorkspaceFileEnvelope,
  type WorkspaceGitReader,
  type WorkspaceFileReader,
} from './ipc-mapping.ts';
import { WorkspaceFileError, type WorkspaceFileReadResult } from './workspace-file.ts';
import { WorkspaceGitError, type WorkspaceGitStatus } from './workspace-git.ts';
import { WorkspaceInputError, type LinuxWorkspace } from './workspace.ts';

const UBUNTU = 'Ubuntu';
const WORKSPACE: LinuxWorkspace = { distro: UBUNTU, linuxPath: '/home/dev/project' };

function wslResult(stdout = '', stderr = '', exitCode: number | null = 0): WslCommandResult {
  return {
    distribution: UBUNTU,
    command: { executable: 'cat', args: ['--', WORKSPACE.linuxPath] },
    request: { executable: 'wsl.exe', args: [] },
    stdout,
    stderr,
    exitCode,
    signal: null,
    failure: null,
    ok: exitCode === 0,
  };
}

function fileReadResult(overrides: Partial<WorkspaceFileReadResult> = {}): WorkspaceFileReadResult {
  return {
    workspace: WORKSPACE,
    relativePath: 'README.md',
    content: 'export const x = 1;\n',
    byteLength: 18,
    result: wslResult('export const x = 1;\n'),
    ...overrides,
  };
}

test('file read envelope carries content and byteLength but never the WslCommandResult', async () => {
  const reader: WorkspaceFileReader = { readFile: async () => fileReadResult() };

  const envelope = await readWorkspaceFileEnvelope(reader, WORKSPACE, 'README.md');

  assert.deepEqual(envelope, {
    ok: true,
    workspace: WORKSPACE,
    content: 'export const x = 1;\n',
    byteLength: 18,
  });
  // Wire safety: the internal process boundary must not serialize across IPC.
  assert.equal(Object.hasOwn(envelope, 'result'), false);
  const serialized = JSON.stringify(envelope);
  for (const leaked of ['stdout', 'stderr', 'exitCode', 'signal', 'failure', 'command', 'request', 'distribution']) {
    assert.equal(serialized.includes(leaked), false, `envelope leaked ${leaked}`);
  }
});

test('file read envelope forwards the relative path and keeps it off the wire', async () => {
  let seenRelativePath: string | null = null;
  const reader: WorkspaceFileReader = {
    readFile: async (_input, relativePath) => {
      seenRelativePath = relativePath;
      return fileReadResult({ relativePath });
    },
  };

  const envelope = await readWorkspaceFileEnvelope(reader, WORKSPACE, 'src/notes.md');

  assert.equal(seenRelativePath, 'src/notes.md');
  assert.deepEqual(envelope, {
    ok: true,
    workspace: WORKSPACE,
    content: 'export const x = 1;\n',
    byteLength: 18,
  });
  // The relative path addresses the read but is not echoed on the wire; the
  // workspace root stays the identity of the result.
  assert.equal(JSON.stringify(envelope).includes('notes.md'), false);
  assert.equal(JSON.stringify(envelope).includes('README.md'), false);
});

test('file read preserves the canonical Linux workspace path', async () => {
  const canonical: LinuxWorkspace = { distro: UBUNTU, linuxPath: '/home/dev/src/app.ts' };
  const reader: WorkspaceFileReader = {
    readFile: async () => fileReadResult({ workspace: canonical, content: '// hi\n', byteLength: 6 }),
  };

  const envelope = await readWorkspaceFileEnvelope(reader, canonical, 'README.md');

  assert.deepEqual(envelope, {
    ok: true,
    workspace: canonical,
    content: '// hi\n',
    byteLength: 6,
  });
});

test('file read maps not-found and is-directory failures to typed envelopes', async () => {
  const notFound: WorkspaceFileReader = {
    readFile: async () => {
      throw new WorkspaceFileError(WORKSPACE, 'not-found', 'Failed to read /home/dev/project', {
        result: wslResult('', 'cat: /home/dev/project: No such file or directory', 1),
      });
    },
  };
  assert.deepEqual(await readWorkspaceFileEnvelope(notFound, WORKSPACE, 'README.md'), {
    ok: false,
    reason: 'not-found',
    message: 'Failed to read /home/dev/project (not-found): cat: /home/dev/project: No such file or directory',
  });

  const isDirectory: WorkspaceFileReader = {
    readFile: async () => {
      throw new WorkspaceFileError(WORKSPACE, 'is-directory', 'Failed to read /home/dev/project', {
        result: wslResult('', 'cat: /home/dev/project: Is a directory', 1),
      });
    },
  };
  assert.deepEqual(await readWorkspaceFileEnvelope(isDirectory, WORKSPACE, 'README.md'), {
    ok: false,
    reason: 'is-directory',
    message: 'Failed to read /home/dev/project (is-directory): cat: /home/dev/project: Is a directory',
  });
});

test('file read maps invalid workspace input and command failure to typed envelopes', async () => {
  const invalidInput: WorkspaceFileReader = {
    readFile: async () => {
      throw new WorkspaceInputError('linuxPath must be an absolute POSIX path: C:\\dev\\x');
    },
  };
  assert.deepEqual(await readWorkspaceFileEnvelope(invalidInput, WORKSPACE, 'README.md'), {
    ok: false,
    reason: 'invalid-workspace',
    message: 'linuxPath must be an absolute POSIX path: C:\\dev\\x',
  });

  const commandFailed: WorkspaceFileReader = {
    readFile: async () => {
      throw new WorkspaceFileError(WORKSPACE, 'command-failed', 'Failed to read /home/dev/project', {
        result: wslResult('', 'cat: permission denied', 1),
      });
    },
  };
  assert.deepEqual(await readWorkspaceFileEnvelope(commandFailed, WORKSPACE, 'README.md'), {
    ok: false,
    reason: 'command-failed',
    message: 'Failed to read /home/dev/project (command-failed): cat: permission denied',
  });
});

test('unexpected file read errors propagate instead of masquerading as workspace results', async () => {
  const boom = new Error('runner exploded');
  const reader: WorkspaceFileReader = {
    readFile: async () => {
      throw boom;
    },
  };

  await assert.rejects(
    readWorkspaceFileEnvelope(reader, WORKSPACE, 'README.md'),
    (error: unknown) => error === boom,
  );
});

function gitStatusOk(overrides: Partial<Extract<WorkspaceGitStatus, { kind: 'ok' }>> = {}): WorkspaceGitStatus {
  return {
    kind: 'ok',
    workspace: WORKSPACE,
    branch: 'main',
    raw: '## main\n M src/a.ts\nR  src/old.ts -> src/new.ts\n?? untracked/',
    entries: [
      { path: 'src/a.ts', xy: ' M', indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, untracked: false },
      { path: 'src/new.ts', xy: 'R ', indexStatus: 'R', worktreeStatus: ' ', staged: true, unstaged: false, untracked: false, renamedFrom: 'src/old.ts' },
      { path: 'untracked/', xy: '??', indexStatus: '?', worktreeStatus: '?', staged: false, unstaged: false, untracked: true },
    ],
    result: wslResult('## main\n M src/a.ts', ''),
    ...overrides,
  };
}

test('git status envelope maps entries and drops raw porcelain and command result', async () => {
  const reader: WorkspaceGitReader = { gitStatus: async () => gitStatusOk() };

  const envelope = await gitStatusEnvelope(reader, WORKSPACE);

  assert.deepEqual(envelope, {
    ok: true,
    workspace: WORKSPACE,
    branch: 'main',
    entries: [
      { path: 'src/a.ts', xy: ' M', indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, untracked: false },
      { path: 'src/new.ts', xy: 'R ', indexStatus: 'R', worktreeStatus: ' ', staged: true, unstaged: false, untracked: false, renamedFrom: 'src/old.ts' },
      { path: 'untracked/', xy: '??', indexStatus: '?', worktreeStatus: '?', staged: false, unstaged: false, untracked: true },
    ],
  });
  assert.equal(Object.hasOwn(envelope, 'raw'), false);
  assert.equal(Object.hasOwn(envelope, 'result'), false);
  const serialized = JSON.stringify(envelope);
  for (const leaked of ['## main', 'stdout', 'stderr', 'exitCode', 'signal', 'failure', 'command', 'request', 'distribution']) {
    assert.equal(serialized.includes(leaked), false, `envelope leaked ${leaked}`);
  }
});

test('git status maps soft failures to typed envelopes', async () => {
  const notARepo: WorkspaceGitReader = {
    gitStatus: async () => ({
      kind: 'not-a-repository',
      workspace: WORKSPACE,
      result: wslResult('', 'fatal: not a git repository (or any of the parent directories): .git', 128),
    }),
  };
  assert.deepEqual(await gitStatusEnvelope(notARepo, WORKSPACE), {
    ok: false,
    reason: 'not-a-repository',
    message: '/home/dev/project is not a git repository',
  });

  const gitMissing: WorkspaceGitReader = {
    gitStatus: async () => ({
      kind: 'git-unavailable',
      workspace: WORKSPACE,
      result: wslResult('', '/bin/sh: git: command not found', 127),
    }),
  };
  assert.deepEqual(await gitStatusEnvelope(gitMissing, WORKSPACE), {
    ok: false,
    reason: 'git-unavailable',
    message: 'git is unavailable in Ubuntu',
  });
});

test('git status maps invalid input and command failures to typed envelopes', async () => {
  const invalidInput: WorkspaceGitReader = {
    gitStatus: async () => {
      throw new WorkspaceInputError('linuxPath must not contain control characters or backslashes');
    },
  };
  assert.deepEqual(await gitStatusEnvelope(invalidInput, WORKSPACE), {
    ok: false,
    reason: 'invalid-workspace',
    message: 'linuxPath must not contain control characters or backslashes',
  });

  const gitError: WorkspaceGitReader = {
    gitStatus: async () => {
      throw new WorkspaceGitError(WORKSPACE, 'git status failed for /home/dev/project', {
        result: wslResult('', 'fatal: ambiguous argument', 1),
      });
    },
  };
  assert.deepEqual(await gitStatusEnvelope(gitError, WORKSPACE), {
    ok: false,
    reason: 'command-failed',
    message: 'git status failed for /home/dev/project: fatal: ambiguous argument',
  });
});

test('unexpected git errors propagate instead of masquerading as workspace results', async () => {
  const boom = new Error('git exploded');
  const reader: WorkspaceGitReader = {
    gitStatus: async () => {
      throw boom;
    },
  };

  await assert.rejects(gitStatusEnvelope(reader, WORKSPACE), (error: unknown) => error === boom);
});
