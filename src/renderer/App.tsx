import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type {
  DiagnosticCheck,
  DiagnosticsReport,
  PiRuntimeSnapshot,
  RuntimeInfo,
  WslDistributionInfo,
  WslProbeInfo,
} from '../shared/ipc';
import type { ConversationSnapshot } from '../shared/conversation';
import { ConversationPanel } from './components/conversation';

type View = 'overview' | 'conversation' | 'diagnostics';

function StatusMark({ status }: { status: DiagnosticCheck['status'] }): ReactElement {
  const symbol = status === 'pass' ? '✓' : status === 'fail' ? '!' : '•';

  return (
    <span className={`status-mark status-${status}`} aria-label={status}>
      {symbol}
    </span>
  );
}

function RuntimeSummary({ runtime }: { runtime: RuntimeInfo | null }): ReactElement {
  if (!runtime) {
    return <p className="muted-copy">Waiting for the desktop host…</p>;
  }

  return (
    <dl className="runtime-grid">
      <div>
        <dt>Platform</dt>
        <dd>{runtime.platform}</dd>
      </div>
      <div>
        <dt>Architecture</dt>
        <dd>{runtime.architecture}</dd>
      </div>
      <div>
        <dt>Electron</dt>
        <dd>{runtime.electronVersion}</dd>
      </div>
      <div>
        <dt>App</dt>
        <dd>v{runtime.appVersion}</dd>
      </div>
    </dl>
  );
}

function DiagnosticsList({ report }: { report: DiagnosticsReport | null }): ReactElement {
  if (!report) {
    return <p className="muted-copy">Diagnostics will appear after the host responds.</p>;
  }

  return (
    <div className="diagnostics-list">
      {report.checks.map((check) => (
        <div className="diagnostic-row" key={check.id}>
          <StatusMark status={check.status} />
          <div>
            <strong>{check.label}</strong>
            <p>{check.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function App(): ReactElement {
  const [view, setView] = useState<View>('overview');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [distros, setDistros] = useState<WslDistributionInfo[]>([]);
  const [selectedDistro, setSelectedDistro] = useState('');
  const [linuxPath, setLinuxPath] = useState('/home/user/src/project');
  const [probe, setProbe] = useState<WslProbeInfo | null>(null);
  const [piStatus, setPiStatus] = useState<PiRuntimeSnapshot | null>(null);
  const [conversation, setConversation] = useState<ConversationSnapshot>({
    timeline: [],
    executionState: 'idle',
    queuedPromptCount: 0,
    error: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [runtimeInfo, diagnosticReport, availableDistros, runtimeStatus, conversationSnapshot] = await Promise.all([
        window.piDesktop.getRuntimeInfo(),
        window.piDesktop.getDiagnostics(),
        window.piDesktop.listWslDistributions(),
        window.piDesktop.getPiStatus(),
        window.piDesktop.getConversation(),
      ]);
      setRuntime(runtimeInfo);
      setDiagnostics(diagnosticReport);
      setDistros(availableDistros);
      setSelectedDistro((current) => current || availableDistros[0]?.name || '');
      setPiStatus(runtimeStatus);
      setConversation(conversationSnapshot);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The desktop host did not respond.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => window.piDesktop.onPiEvent((event) => {
    if (event.type === 'runtime') setPiStatus(event.snapshot);
    if (event.type === 'conversation') setConversation(event.snapshot);
  }), []);

  const inspectDistro = useCallback(async () => {
    if (!selectedDistro) return;
    setProbe(await window.piDesktop.probeWslDistribution(selectedDistro));
  }, [selectedDistro]);

  const startPi = useCallback(async () => {
    if (!selectedDistro) return;
    setPiStatus(await window.piDesktop.startPi({ distro: selectedDistro, linuxPath }));
    setConversation(await window.piDesktop.getConversation());
  }, [linuxPath, selectedDistro]);

  const stopPi = useCallback(async () => {
    setPiStatus(await window.piDesktop.stopPi());
    setConversation(await window.piDesktop.getConversation());
  }, []);

  const sendPrompt = useCallback(async (prompt: string) => {
    setConversation(await window.piDesktop.sendPrompt(prompt));
  }, []);

  const abortPrompt = useCallback(async () => {
    setConversation(await window.piDesktop.abortPrompt());
  }, []);

  const reportStatus = diagnostics?.overall === 'ready' ? 'Ready' : 'M0 shell online';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div>
            <p className="brand-name">Pi Desktop</p>
            <p className="brand-context">Windows workbench</p>
          </div>
        </div>

        <nav className="view-tabs" aria-label="Primary navigation">
          <button
            className={view === 'overview' ? 'tab-button tab-active' : 'tab-button'}
            onClick={() => setView('overview')}
            type="button"
          >
            Overview
          </button>
          <button
            className={view === 'diagnostics' ? 'tab-button tab-active' : 'tab-button'}
            onClick={() => setView('diagnostics')}
            type="button"
          >
            Diagnostics
          </button>
          <button
            className={view === 'conversation' ? 'tab-button tab-active' : 'tab-button'}
            onClick={() => setView('conversation')}
            type="button"
          >
            Conversation
          </button>
        </nav>

        <div className="header-status">
          <span className="live-dot" aria-hidden="true" />
          <span>{reportStatus}</span>
        </div>
      </header>

      <main className="content-wrap">
        {error && (
          <div className="error-banner" role="alert">
            <span>Host connection unavailable.</span>
            <button onClick={() => void refresh()} type="button">
              Try again
            </button>
          </div>
        )}

        {view === 'conversation' ? (
          <ConversationPanel
            timeline={conversation.timeline}
            executionState={conversation.executionState}
            queuedPromptCount={conversation.queuedPromptCount}
            streamingText={conversation.streamingText}
            error={conversation.error}
            onSendPrompt={sendPrompt}
            onAbort={abortPrompt}
            isLoading={isLoading}
          />
        ) : view === 'overview' ? (
          <div className="overview-layout">
            <section className="hero-card panel">
              <div className="hero-orbit orbit-one" aria-hidden="true" />
              <div className="hero-orbit orbit-two" aria-hidden="true" />
              <div className="hero-content">
                <p className="eyebrow">Milestone 0 · shell foundation</p>
                <h1>Make room for<br />
                  <span>good work.</span>
                </h1>
                <p className="hero-copy">
                  A calm Windows home for Pi. Your workspace will stay close at hand while
                  the execution layer remains safely isolated in WSL.
                </p>
                <div className="workspace-form">
                  <label>
                    <span>WSL distribution</span>
                    <select value={selectedDistro} onChange={(event) => setSelectedDistro(event.target.value)}>
                      <option value="">Select a distro</option>
                      {distros.map((distro) => <option key={distro.name} value={distro.name}>{distro.name}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Linux workspace path</span>
                    <input value={linuxPath} onChange={(event) => setLinuxPath(event.target.value)} spellCheck={false} />
                  </label>
                  <div className="workspace-actions">
                    <button className="secondary-button" disabled={!selectedDistro} onClick={() => void inspectDistro()} type="button">Probe</button>
                    <button className="primary-button" disabled={!selectedDistro || piStatus?.state === 'starting'} onClick={() => void startPi()} type="button">
                      <span>{piStatus?.state === 'ready' ? 'Pi running' : 'Start Pi'}</span>
                      <span className="button-tag">WSL RPC</span>
                    </button>
                    {piStatus?.state === 'ready' && <button className="text-button" onClick={() => void stopPi()} type="button">Stop</button>}
                  </div>
                  <p className="helper-copy">
                    {probe ? `${probe.distribution}: ${probe.detail}` : 'Linux paths stay canonical inside Pi and Git.'}
                  </p>
                </div>
              </div>
              <div className="hero-footer">
                <span className="footer-signal" aria-hidden="true">↗</span>
                <span>Presentation layer ready for the next connection</span>
              </div>
            </section>

            <aside className="side-column">
              <section className="panel compact-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">At a glance</p>
                    <h2>Runtime</h2>
                  </div>
                  <span className="ready-badge">Online</span>
                </div>
                <RuntimeSummary runtime={runtime} />
              </section>

              <section className="panel compact-panel diagnostics-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">System check</p>
                    <h2>Diagnostics</h2>
                  </div>
                  <StatusMark
                    status={
                      !diagnostics
                        ? 'pending'
                        : diagnostics.overall === 'degraded'
                          ? 'fail'
                          : 'pass'
                    }
                  />
                </div>
                <DiagnosticsList report={diagnostics} />
                <button className="text-button" onClick={() => setView('diagnostics')} type="button">
                  View full report <span aria-hidden="true">→</span>
                </button>
              </section>
            </aside>
          </div>
        ) : (
          <section className="panel diagnostics-page">
            <div className="page-heading">
              <div>
                <p className="eyebrow">M0 observability</p>
                <h1>Desktop diagnostics</h1>
                <p className="page-copy">
                  Confirm the shell boundary before connecting a WSL workspace or Pi session.
                </p>
              </div>
              <button className="secondary-button" disabled={isLoading} onClick={() => void refresh()} type="button">
                {isLoading ? 'Checking…' : 'Refresh checks'}
              </button>
            </div>

            <div className="diagnostics-page-grid">
              <div>
                <h2 className="subheading">Checks</h2>
                <DiagnosticsList report={diagnostics} />
              </div>
              <div className="runtime-detail">
                <h2 className="subheading">Host details</h2>
                <RuntimeSummary runtime={runtime} />
                {diagnostics && (
                  <p className="checked-at">
                    Last checked {new Date(diagnostics.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </p>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <span>Pi Desktop M0</span>
        <span className="footer-divider" aria-hidden="true" />
        <span>Safe boundary · Windows renderer ↔ host</span>
      </footer>
    </div>
  );
}

export default App;
