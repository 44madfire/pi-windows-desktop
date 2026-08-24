import assert from 'node:assert/strict';
import test from 'node:test';

import type { WslCommandResult } from '../../wsl/index.ts';
import {
  WorkspaceGitError,
  WorkspaceGitService,
  parseGitStatusBranch,
  parseGitStatusEntries,
} from './workspace-git.ts';
import { WorkspaceInputError, type WorkspaceCommandRunner } from './workspace.ts';

const UBUNTU = 'Ubuntu';

interface RunnerCall {
  readonly distribution: string;
  readonly executable: string;
  readonly args: readonly string[];
}

class FakeWorkspaceRunner implements WorkspaceCommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly queued: Array<WslCommandResult | Error> = [];
  private readonly fallback: WslCommandResult;

  constructor(fallback: WslCommandResult) {
    this.fallback = fallback;
  }

  queueResult(result: WslCommandResult | Error): void {
    this.queued.push(result);
  }

  async runInDistribution(
    distribution: string,
    executable: string,
    args: readonly string[] = [],
  ): Promise<WslCommandResult> {
    this.calls.push({ distribution, executable, args: [...args] });
    const next = this.queued.shift() ?? this.fallback;
    if (next instanceof Error) throw next;
    return next;
  }
}

function result(stdout = '', stderr = '', exitCode: number | null = 0): WslCommandResult {
  return {
    distribution: UBUNTU,
    command: { executable: 'git', args: [] },
    request: { executable: 'wsl.exe', args: [] },
    stdout,
    stderr,
    exitCode,
    signal: null,
    failure: null,
    ok: exitCode === 0,
  };
}

const PORCELAIN = [
  '## main...origin/main [ahead 1]',
  ' M src/foo.ts',
  'A  src/new.ts',
  'D  src/gone.ts',
  'R  src/old.ts -> src/renamed.ts',
  '?? untracked/',
  ' m sub',
].join('\n');

test('invokes git -C <linuxPath> status --porcelain=v1 --branch in the selected distro', async () => {
  const runner = new FakeWorkspaceRunner(result(PORCELAIN));
  const service = new WorkspaceGitService(runner);

  const status = await service.gitStatus({ distro: UBUNTU, linuxPath: '/home/dev/project' });

  assert.deepEqual(runner.calls, [
    {
      distribution: UBUNTU,
      executable: 'git',
      args: ['-C', '/home/dev/project', 'status', '--porcelain=v1', '--branch'],
    },
  ]);
  assert.equal(status.kind, 'ok');
  if (status.kind !== 'ok') return;
  assert.equal(status.branch, 'main');
  assert.equal(status.raw, PORCELAIN);
  assert.deepEqual(
    status.entries.map((entry) => entry.xy),
    [' M', 'A ', 'D ', 'R ', '??', ' m'],
  );
});

test('parses porcelain entries into staged, unstaged, untracked, and rename records', () => {
  const entries = parseGitStatusEntries(PORCELAIN);
  assert.equal(entries.length, 6);

  const [modified, added, deleted, renamed, untracked, submodule] = entries;
  assert.deepEqual(modified, {
    path: 'src/foo.ts',
    xy: ' M',
    indexStatus: ' ',
    worktreeStatus: 'M',
    staged: false,
    unstaged: true,
    untracked: false,
  });
  assert.equal(added.path, 'src/new.ts');
  assert.equal(added.staged, true);
  assert.equal(added.unstaged, false);
  assert.equal(deleted.path, 'src/gone.ts');
  assert.equal(deleted.staged, true);
  assert.deepEqual(renamed, {
    path: 'src/renamed.ts',
    xy: 'R ',
    indexStatus: 'R',
    worktreeStatus: ' ',
    staged: true,
    unstaged: false,
    untracked: false,
    renamedFrom: 'src/old.ts',
  });
  assert.equal(untracked.untracked, true);
  assert.equal(untracked.staged, false);
  assert.equal(untracked.unstaged, false);
  assert.equal(submodule.unstaged, true);
  assert.equal(submodule.staged, false);
});

test('parses worktree and copy statuses with the new path active and the original as renamedFrom', () => {
  const entries = parseGitStatusEntries(
    [' R docs/old.md -> docs/new.md', 'C  src/a.ts -> src/b.ts'].join('\n'),
  );
  assert.equal(entries.length, 2);

  const [worktreeRename, copy] = entries;
  assert.equal(worktreeRename.xy, ' R');
  assert.equal(worktreeRename.indexStatus, ' ');
  assert.equal(worktreeRename.worktreeStatus, 'R');
  assert.equal(worktreeRename.staged, false);
  assert.equal(worktreeRename.unstaged, true);
  assert.equal(worktreeRename.path, 'docs/new.md');
  assert.equal(worktreeRename.renamedFrom, 'docs/old.md');

  assert.equal(copy.xy, 'C ');
  assert.equal(copy.staged, true);
  assert.equal(copy.path, 'src/b.ts');
  assert.equal(copy.renamedFrom, 'src/a.ts');
});

test('keeps arrow text in paths when the status is not a rename or copy', () => {
  const entries = parseGitStatusEntries(
    [' M notes -> ideas.txt', 'A  a -> b.ts', 'R  src/old.ts -> src/new.ts'].join('\n'),
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0].xy, ' M');
  assert.equal(entries[0].path, 'notes -> ideas.txt');
  assert.equal(entries[0].renamedFrom, undefined);
  assert.equal(entries[1].path, 'a -> b.ts');
  assert.equal(entries[1].renamedFrom, undefined);
  assert.equal(entries[2].path, 'src/new.ts');
  assert.equal(entries[2].renamedFrom, 'src/old.ts');
});

test('extracts branch names including ahead/behind, detached, and unborn states', () => {
  assert.equal(parseGitStatusBranch('## main...origin/main [ahead 1, behind 2]\n'), 'main');
  assert.equal(parseGitStatusBranch('## fix/thing [ahead 3]\n'), 'fix/thing');
  assert.equal(parseGitStatusBranch('## main\n'), 'main');
  assert.equal(parseGitStatusBranch('## HEAD (no branch)\n'), null);
  assert.equal(parseGitStatusBranch('## No commits yet on main\n'), 'main');
  assert.equal(parseGitStatusBranch(''), null);
});

test('reports a non-repository directory as a soft result, preserving stderr', async () => {
  const runner = new FakeWorkspaceRunner(
    result('', 'fatal: not a git repository (or any of the parent directories): .git', 128),
  );
  const service = new WorkspaceGitService(runner);

  const status = await service.gitStatus({ distro: UBUNTU, linuxPath: '/home/dev/plain' });
  assert.equal(status.kind, 'not-a-repository');
  assert.match(status.result.stderr, /not a git repository/);
  assert.deepEqual(status.workspace, { distro: UBUNTU, linuxPath: '/home/dev/plain' });
});

test('reports a missing git binary as a soft result', async () => {
  const runner = new FakeWorkspaceRunner(result('', '/bin/sh: 1: git: not found', 127));
  const service = new WorkspaceGitService(runner);

  const status = await service.gitStatus({ distro: UBUNTU, linuxPath: '/home/dev/project' });
  assert.equal(status.kind, 'git-unavailable');
});

test('throws a typed error for unexpected git failures, preserving stderr', async () => {
  const runner = new FakeWorkspaceRunner(
    result('', "fatal: detected dubious ownership in repository at '/home/dev/project'", 128),
  );
  const service = new WorkspaceGitService(runner);

  await assert.rejects(
    service.gitStatus({ distro: UBUNTU, linuxPath: '/home/dev/project' }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceGitError);
      if (!(error instanceof WorkspaceGitError)) return false;
      assert.equal(error.result?.exitCode, 128);
      assert.match(error.result?.stderr ?? '', /dubious ownership/);
      return true;
    },
  );
});

test('wraps process-launch failures with the original cause', async () => {
  const runner = new FakeWorkspaceRunner(result(''));
  runner.queueResult(new Error('wsl.exe not found'));
  const service = new WorkspaceGitService(runner);

  await assert.rejects(
    service.gitStatus({ distro: UBUNTU, linuxPath: '/home/dev/project' }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceGitError);
      if (!(error instanceof WorkspaceGitError)) return false;
      assert.equal((error.cause as Error).message, 'wsl.exe not found');
      assert.equal(error.result, null);
      return true;
    },
  );
});

test('rejects invalid workspace input before invoking git', async () => {
  const runner = new FakeWorkspaceRunner(result(''));
  const service = new WorkspaceGitService(runner);

  for (const linuxPath of [
    'C:\\Users\\dev\\project',
    '/home/dev/project/',
    '/home//project',
    '/home/./project',
    '/home/dev/project/..',
  ]) {
    await assert.rejects(
      service.gitStatus({ distro: UBUNTU, linuxPath }),
      (error: unknown) => error instanceof WorkspaceInputError,
    );
  }
  assert.deepEqual(runner.calls, []);
});
