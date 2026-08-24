import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type {
  WorkspaceFileReadResponse,
  WorkspaceGitStatusEntry,
  WorkspaceGitStatusResponse,
  WslWorkspace,
} from '../../../shared/ipc';
import './WorkspaceProofCard.css';

type WorkspaceProofState = {
  workspaceKey: string | null;
  file: WorkspaceFileReadResponse | null;
  git: WorkspaceGitStatusResponse | null;
  isLoading: boolean;
  requestError: boolean;
};

function workspaceKey(workspace: WslWorkspace | null): string | null {
  return workspace ? `${workspace.distro}\u0000${workspace.linuxPath}` : null;
}

// Wire failure messages can include command details; render only typed reason mappings.
function fileFailureLabel(reason: Extract<WorkspaceFileReadResponse, { ok: false }>['reason']): string {
  switch (reason) {
    case 'invalid-workspace':
      return 'Workspace path is invalid';
    case 'not-found':
      return 'File was not found';
    case 'is-directory':
      return 'Path is a directory';
    case 'command-failed':
      return 'File read failed';
  }
}

function fileFailureDetail(reason: Extract<WorkspaceFileReadResponse, { ok: false }>['reason']): string {
  switch (reason) {
    case 'invalid-workspace':
      return 'Choose a WSL distribution and an absolute Linux path.';
    case 'not-found':
      return 'The selected Linux path does not exist.';
    case 'is-directory':
      return 'Choose a file path instead of a directory.';
    case 'command-failed':
      return 'Pi could not read the selected Linux path.';
  }
}

function gitFailureLabel(reason: Extract<WorkspaceGitStatusResponse, { ok: false }>['reason']): string {
  switch (reason) {
    case 'invalid-workspace':
      return 'Workspace path is invalid';
    case 'not-a-repository':
      return 'Not a Git repository';
    case 'git-unavailable':
      return 'Git is unavailable';
    case 'command-failed':
      return 'Git status failed';
  }
}

function gitFailureDetail(reason: Extract<WorkspaceGitStatusResponse, { ok: false }>['reason']): string {
  switch (reason) {
    case 'invalid-workspace':
      return 'Choose a WSL distribution and an absolute Linux path.';
    case 'not-a-repository':
      return 'The selected Linux path is not a Git repository.';
    case 'git-unavailable':
      return 'Git is not available in this WSL distribution.';
    case 'command-failed':
      return 'Pi could not read Git status for the selected path.';
  }
}

function gitEntryLabel(entry: WorkspaceGitStatusEntry): string {
  if (entry.untracked) return 'Untracked';
  if (entry.staged && entry.unstaged) return 'Staged + modified';
  if (entry.staged) return 'Staged';
  if (entry.unstaged) return 'Modified';
  return entry.xy || 'Changed';
}

function FileProof({ result }: { result: WorkspaceFileReadResponse | null }): ReactElement {
  if (!result) {
    return <p className="workspace-proof-muted">Read the selected path to show its contents.</p>;
  }

  if (!result.ok) {
    return (
      <div className="workspace-proof-failure" role="status">
        <strong>{fileFailureLabel(result.reason)}</strong>
        <p>{fileFailureDetail(result.reason)}</p>
      </div>
    );
  }

  return (
    <div className="workspace-file-result">
      <div className="workspace-proof-result-heading">
        <span>File content</span>
        <span>{result.byteLength} bytes</span>
      </div>
      <pre className="workspace-proof-content">{result.content || 'File is empty.'}</pre>
    </div>
  );
}

function GitProof({ result }: { result: WorkspaceGitStatusResponse | null }): ReactElement {
  if (!result) {
    return <p className="workspace-proof-muted">Git branch and working tree status will appear here.</p>;
  }

  if (!result.ok) {
    return (
      <div className="workspace-proof-failure" role="status">
        <strong>{gitFailureLabel(result.reason)}</strong>
        <p>{gitFailureDetail(result.reason)}</p>
      </div>
    );
  }

  return (
    <div className="workspace-git-result">
      <div className="workspace-proof-result-heading">
        <span>Git status</span>
        <strong>{result.branch ?? 'Detached HEAD'}</strong>
      </div>
      {result.entries.length > 0 ? (
        <ul className="workspace-git-entries" aria-label="Git status entries">
          {result.entries.map((entry) => (
            <li key={`${entry.xy}:${entry.path}`}>
              <span className="workspace-git-code">{entry.xy || '  '}</span>
              <span className="workspace-git-path">
                {entry.path}
                {entry.renamedFrom && <span className="workspace-git-rename">from {entry.renamedFrom}</span>}
              </span>
              <span className="workspace-git-label">{gitEntryLabel(entry)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="workspace-proof-clean">Working tree clean.</p>
      )}
    </div>
  );
}

export function WorkspaceProofCard({ workspace }: { workspace: WslWorkspace | null }): ReactElement {
  const currentWorkspaceKey = workspaceKey(workspace);
  const [proof, setProof] = useState<WorkspaceProofState>(() => ({
    workspaceKey: currentWorkspaceKey,
    file: null,
    git: null,
    isLoading: false,
    requestError: false,
  }));

  useEffect(() => {
    setProof({
      workspaceKey: currentWorkspaceKey,
      file: null,
      git: null,
      isLoading: false,
      requestError: false,
    });
  }, [currentWorkspaceKey]);

  const runProof = useCallback(async () => {
    if (!workspace) return;

    const requestWorkspace: WslWorkspace = {
      distro: workspace.distro,
      linuxPath: workspace.linuxPath,
    };
    const requestKey = workspaceKey(requestWorkspace);
    setProof((current) => ({
      ...current,
      workspaceKey: requestKey,
      file: null,
      git: null,
      isLoading: true,
      requestError: false,
    }));

    try {
      const [file, git] = await Promise.all([
        window.piDesktop.readWorkspaceFile(requestWorkspace),
        window.piDesktop.gitStatus(requestWorkspace),
      ]);
      setProof((current) => current.workspaceKey === requestKey
        ? { ...current, file, git, isLoading: false }
        : current);
    } catch {
      setProof((current) => current.workspaceKey === requestKey
        ? { ...current, isLoading: false, requestError: true }
        : current);
    }
  }, [workspace]);

  const hasWorkspace = Boolean(workspace);
  const showingCurrentWorkspace = proof.workspaceKey === currentWorkspaceKey;
  const file = showingCurrentWorkspace ? proof.file : null;
  const git = showingCurrentWorkspace ? proof.git : null;
  const requestError = showingCurrentWorkspace && proof.requestError;

  return (
    <section className="panel compact-panel workspace-proof-card" aria-labelledby="workspace-proof-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Workspace proof</p>
          <h2 id="workspace-proof-title">File + Git</h2>
        </div>
        <span className={hasWorkspace ? 'ready-badge' : 'workspace-proof-badge'}>
          {hasWorkspace ? 'Ready' : 'Choose distro'}
        </span>
      </div>

      <div className="workspace-proof-target">
        <span>{workspace?.distro || 'No WSL distribution selected'}</span>
        <code>{workspace?.linuxPath || 'Select a Linux path above'}</code>
      </div>

      <button
        className="secondary-button workspace-proof-button"
        type="button"
        onClick={() => void runProof()}
        disabled={!hasWorkspace || proof.isLoading}
      >
        {proof.isLoading ? 'Checking workspace…' : 'Read file + Git status'}
      </button>

      {requestError && (
        <p className="workspace-proof-request-error" role="alert">
          The host could not complete the workspace proof request.
        </p>
      )}

      <div className="workspace-proof-results">
        <FileProof result={file} />
        <GitProof result={git} />
      </div>
    </section>
  );
}
