import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import type { WslCommandResult } from '../../wsl/index.ts';
import { WorkspaceFileError, WorkspaceFileService } from './workspace-file.ts';
import { WorkspaceInputError, validateLinuxPath, type WorkspaceCommandRunner } from './workspace.ts';

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
    command: { executable: 'cat', args: ['--', '/workspace'] },
    request: { executable: 'wsl.exe', args: [] },
    stdout,
    stderr,
    exitCode,
    signal: null,
    failure: null,
    ok: exitCode === 0,
  };
}

test('reads a workspace file via cat with the exact joined path argv', async () => {
  const runner = new FakeWorkspaceRunner(result('export const x = 1;\n'));
  const service = new WorkspaceFileService(runner);

  const read = await service.readFile(
    { distro: UBUNTU, linuxPath: '/home/dev/project' },
    'src/app.ts',
  );

  assert.deepEqual(runner.calls, [
    {
      distribution: UBUNTU,
      executable: 'cat',
      args: ['--', '/home/dev/project/src/app.ts'],
    },
  ]);
  assert.equal(read.content, 'export const x = 1;\n');
  assert.equal(read.byteLength, Buffer.byteLength('export const x = 1;\n', 'utf8'));
  assert.deepEqual(read.workspace, { distro: UBUNTU, linuxPath: '/home/dev/project' });
  assert.equal(read.relativePath, 'src/app.ts');
  assert.equal(read.result.ok, true);
});

test('keeps a path with spaces as one argv entry without shell parsing', async () => {
  const runner = new FakeWorkspaceRunner(result('# heading\nbody\n'));
  const service = new WorkspaceFileService(runner);

  const read = await service.readFile(
    { distro: UBUNTU, linuxPath: '/home/dev/my project' },
    'notes.md',
  );

  assert.equal(read.content, '# heading\nbody\n');
  assert.deepEqual(runner.calls[0].args, ['--', '/home/dev/my project/notes.md']);
});

test('resolves a relative file path against the workspace root into one cat argv', async () => {
  const runner = new FakeWorkspaceRunner(result('# Pi project\n'));
  const service = new WorkspaceFileService(runner);

  const read = await service.readFile(
    { distro: UBUNTU, linuxPath: '/home/me/project' },
    'README.md',
  );
  const nested = await service.readFile(
    { distro: UBUNTU, linuxPath: '/home/me/project' },
    'src/lib/pi.ts',
  );

  assert.equal(read.content, '# Pi project\n');
  assert.equal(nested.content, '# Pi project\n');
  assert.equal(read.byteLength, Buffer.byteLength('# Pi project\n', 'utf8'));
  // The workspace identity stays the validated root; only the argv targets the joined file.
  assert.deepEqual(read.workspace, { distro: UBUNTU, linuxPath: '/home/me/project' });
  assert.deepEqual(runner.calls, [
    {
      distribution: UBUNTU,
      executable: 'cat',
      args: ['--', '/home/me/project/README.md'],
    },
    {
      distribution: UBUNTU,
      executable: 'cat',
      args: ['--', '/home/me/project/src/lib/pi.ts'],
    },
  ]);
});

test('reads from the workspace root without doubling the separator in the cat argv', async () => {
  const runner = new FakeWorkspaceRunner(result('# root readme\n'));
  const service = new WorkspaceFileService(runner);

  const read = await service.readFile({ distro: UBUNTU, linuxPath: '/' }, 'README.md');

  // Root `/` joined with a relative file is `/README.md`, never `//README.md`.
  assert.deepEqual(runner.calls, [
    {
      distribution: UBUNTU,
      executable: 'cat',
      args: ['--', '/README.md'],
    },
  ]);
  assert.equal(read.content, '# root readme\n');
  assert.equal(read.byteLength, Buffer.byteLength('# root readme\n', 'utf8'));
  assert.deepEqual(read.workspace, { distro: UBUNTU, linuxPath: '/' });
  assert.equal(read.relativePath, 'README.md');
  assert.equal(read.result.ok, true);
});

test('rejects traversal and absolute escape attempts in the relative path before invoking the runner', async () => {
  const runner = new FakeWorkspaceRunner(result(''));
  const service = new WorkspaceFileService(runner);
  const escapes = [
    '',
    '..',
    '../README.md',
    '../../etc/passwd',
    'src/../../secret.md',
    'src/..',
    './README.md',
    'src/./README.md',
    '/etc/passwd',
    '//etc/passwd',
    'C:\\Users\\dev\\file.ts',
    '..\\README.md',
    'README.md\u0000',
  ];

  for (const relativePath of escapes) {
    await assert.rejects(
      service.readFile({ distro: UBUNTU, linuxPath: '/home/me/project' }, relativePath),
      (error: unknown) => error instanceof WorkspaceInputError,
    );
  }
  assert.deepEqual(runner.calls, []);
});

test('rejects invalid and Windows-style workspace paths before invoking the runner', async () => {
  const runner = new FakeWorkspaceRunner(result(''));
  const service = new WorkspaceFileService(runner);
  const invalidPaths = [
    'C:\\Users\\dev\\file.ts',
    '\\\\server\\share\\file.ts',
    'relative/path.ts',
    'file.ts',
    '',
    '/path\\mixed.ts',
    '/path\u0000x',
    '/path\nx',
    '/path//x',
    '/path/./x',
    '/path/x/',
  ];

  for (const linuxPath of invalidPaths) {
    await assert.rejects(
      service.readFile({ distro: UBUNTU, linuxPath }, 'README.md'),
      (error: unknown) => error instanceof WorkspaceInputError,
    );
  }
  assert.deepEqual(runner.calls, []);
});

test('rejects invalid distribution names before invoking the runner', async () => {
  const runner = new FakeWorkspaceRunner(result(''));
  const service = new WorkspaceFileService(runner);

  for (const distro of ['bad distro', '-leading', '', 'Übuntu']) {
    await assert.rejects(
      service.readFile({ distro, linuxPath: '/home/dev/a.ts' }, 'README.md'),
      (error: unknown) => error instanceof WorkspaceInputError,
    );
  }
  assert.deepEqual(runner.calls, []);
});

test('rejects Windows drive-letter relative paths before invoking the runner', async () => {
  const runner = new FakeWorkspaceRunner(result(''));
  const service = new WorkspaceFileService(runner);

  for (const relativePath of ['C:/Users/dev/file.ts', 'c:notes.md']) {
    await assert.rejects(
      service.readFile({ distro: UBUNTU, linuxPath: '/home/me/project' }, relativePath),
      (error: unknown) => error instanceof WorkspaceInputError,
    );
  }
  assert.deepEqual(runner.calls, []);
});

test('maps a missing file to a typed not-found error that preserves stderr', async () => {
  const runner = new FakeWorkspaceRunner(
    result('', 'cat: /home/dev/missing.ts: No such file or directory', 1),
  );
  const service = new WorkspaceFileService(runner);

  await assert.rejects(
    service.readFile({ distro: UBUNTU, linuxPath: '/home/dev' }, 'missing.ts'),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFileError);
      if (!(error instanceof WorkspaceFileError)) return false;
      assert.equal(error.reason, 'not-found');
      assert.equal(error.result?.stderr, 'cat: /home/dev/missing.ts: No such file or directory');
      assert.equal(error.result?.exitCode, 1);
      assert.deepEqual(error.workspace, { distro: UBUNTU, linuxPath: '/home/dev' });
      return true;
    },
  );
});

test('classifies directory reads as is-directory', async () => {
  const runner = new FakeWorkspaceRunner(result('', 'cat: /home/dev/src: Is a directory', 1));
  const service = new WorkspaceFileService(runner);

  await assert.rejects(
    service.readFile({ distro: UBUNTU, linuxPath: '/home/dev' }, 'src'),
    (error: unknown) => error instanceof WorkspaceFileError && error.reason === 'is-directory',
  );
});

test('wraps unexpected command failures while preserving stderr', async () => {
  const runner = new FakeWorkspaceRunner(result('', 'cat: /home/dev/a.ts: Permission denied', 1));
  const service = new WorkspaceFileService(runner);

  await assert.rejects(
    service.readFile({ distro: UBUNTU, linuxPath: '/home/dev' }, 'a.ts'),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFileError);
      if (!(error instanceof WorkspaceFileError)) return false;
      assert.equal(error.reason, 'command-failed');
      assert.equal(error.result?.ok, false);
      assert.match(error.result?.stderr ?? '', /Permission denied/);
      return true;
    },
  );
});

test('wraps process-launch failures with the original cause', async () => {
  const runner = new FakeWorkspaceRunner(result(''));
  runner.queueResult(new Error('wsl.exe not found'));
  const service = new WorkspaceFileService(runner);

  await assert.rejects(
    service.readFile({ distro: UBUNTU, linuxPath: '/home/dev' }, 'a.ts'),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFileError);
      if (!(error instanceof WorkspaceFileError)) return false;
      assert.equal(error.reason, 'command-failed');
      assert.equal((error.cause as Error).message, 'wsl.exe not found');
      assert.equal(error.result, null);
      return true;
    },
  );
});

test('validateLinuxPath accepts only canonical absolute POSIX paths', () => {
  assert.equal(validateLinuxPath('/'), '/');
  assert.equal(validateLinuxPath('/home/dev/my file.ts'), '/home/dev/my file.ts');
  for (const linuxPath of [
    'home/dev/a.ts',
    'C:\\dev\\a.ts',
    '/dev\\a.ts',
    '/dev/a.ts\u0000',
    '/dev/a.ts\r',
    '/dev/a.ts\n',
    '/home/./dev',
    '/home/../dev',
    '/home//dev',
    '/home/dev/',
  ]) {
    assert.throws(() => validateLinuxPath(linuxPath), WorkspaceInputError);
  }
});
