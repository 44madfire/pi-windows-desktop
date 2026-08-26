import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  DiagnosticCheck,
  DiagnosticsReport,
  ExtensionUiResponse,
  PiEvent,
  PiRuntimeSnapshot,
  PiThinkingLevel,
  RuntimeInfo,
  WslDistributionInfo,
  WslProbeInfo,
} from '../shared/ipc';
import type { ConversationSnapshot } from '../shared/conversation';
import { ConversationPanel, type AgentStateControl } from './components/conversation';
import {
  ExtensionUiSurface,
  getExtensionUiNotice,
  isExtensionUiNoticeMethod,
  parseExtensionUiRequest,
  type ExtensionUiNotice,
  type ExtensionUiNoticeTone,
  type ExtensionUiRequest,
} from './components/extension-ui/ExtensionUiSurface';
import { WorkspaceProofCard } from './components/workspace/WorkspaceProofCard';

type View = 'overview' | 'conversation' | 'diagnostics';

function describeAgentStateError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
}

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
  const [modelsLoading, setModelsLoading] = useState(false);
  const [thinkingLevelsLoading, setThinkingLevelsLoading] = useState(false);
  const [thinkingLevelsError, setThinkingLevelsError] = useState<string | null>(null);
  const [thinkingLevelsRefreshVersion, setThinkingLevelsRefreshVersion] = useState(0);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [agentControlPending, setAgentControlPending] = useState<AgentStateControl | null>(null);
  const [agentControlError, setAgentControlError] = useState<string | null>(null);

  const [conversation, setConversation] = useState<ConversationSnapshot>({
    timeline: [],
    executionState: 'idle',
    queuedPromptCount: 0,
    error: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUiRequest | null>(null);
  const [extensionNotices, setExtensionNotices] = useState<ExtensionUiNotice[]>([]);
  const [extensionRespondingId, setExtensionRespondingId] = useState<string | null>(null);
  const extensionNoticeSequenceRef = useRef(0);
  const extensionNoticeTimersRef = useRef<number[]>([]);
  const modelsRequestRef = useRef(0);
  const thinkingLevelsRequestRef = useRef(0);
  const modelCatalogKeyRef = useRef<string | null>(null);
  const modelCatalogInitializedRef = useRef(false);
  const thinkingLevelsCatalogKeyRef = useRef<string | null>(null);
  const thinkingLevelsCatalogVersionRef = useRef(-1);
  const thinkingLevelsCatalogKnownRef = useRef(false);
  const thinkingLevelsCatalogLengthRef = useRef<number | null>(null);

  const showExtensionNotice = useCallback((message: string, tone: ExtensionUiNoticeTone): void => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    const id = `extension-notice-${extensionNoticeSequenceRef.current}`;
    extensionNoticeSequenceRef.current += 1;
    setExtensionNotices((current) => [
      ...current.slice(-3),
      { id, message: trimmedMessage, tone },
    ]);

    const timer = window.setTimeout(() => {
      setExtensionNotices((current) => current.filter((notice) => notice.id !== id));
      extensionNoticeTimersRef.current = extensionNoticeTimersRef.current.filter((value) => value !== timer);
    }, 7000);
    extensionNoticeTimersRef.current.push(timer);
  }, []);

  useEffect(() => () => {
    extensionNoticeTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

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

  const activeModelProvider = piStatus?.model?.provider;
  const activeModelId = piStatus?.model?.id;
  const activeModelKey =
    activeModelProvider !== undefined && activeModelId !== undefined
      ? `${activeModelProvider}\u0000${activeModelId}`
      : null;

  const loadAvailableModels = useCallback(async (): Promise<void> => {
    const requestId = modelsRequestRef.current + 1;
    modelsRequestRef.current = requestId;
    setModelsLoading(true);
    setModelsError(null);

    try {
      const models = await window.piDesktop.getAvailableModels();
      if (modelsRequestRef.current !== requestId) return;
      setPiStatus((current) => (
        current?.state === 'ready'
          ? { ...current, availableModels: models }
          : current
      ));
    } catch (cause) {
      if (modelsRequestRef.current === requestId) {
        setModelsError(describeAgentStateError(cause, 'Pi could not load available models.'));
      }
    } finally {
      if (modelsRequestRef.current === requestId) setModelsLoading(false);
    }
  }, []);

  const loadAvailableThinkingLevels = useCallback(async (): Promise<void> => {
    const requestId = thinkingLevelsRequestRef.current + 1;
    thinkingLevelsRequestRef.current = requestId;
    setThinkingLevelsLoading(true);
    setThinkingLevelsError(null);

    try {
      const availableThinkingLevels = await window.piDesktop.getAvailableThinkingLevels();
      if (thinkingLevelsRequestRef.current !== requestId) return;
      thinkingLevelsCatalogKnownRef.current = true;
      setPiStatus((current) => (
        current?.state === 'ready' &&
        current.model?.provider === activeModelProvider &&
        current.model?.id === activeModelId
          ? { ...current, availableThinkingLevels }
          : current
      ));
    } catch (cause) {
      if (thinkingLevelsRequestRef.current === requestId) {
        setThinkingLevelsError(describeAgentStateError(cause, 'Pi could not load supported thinking levels.'));
      }
    } finally {
      if (thinkingLevelsRequestRef.current === requestId) setThinkingLevelsLoading(false);
    }
  }, [activeModelId, activeModelProvider]);

  const resetThinkingLevelsCatalog = useCallback((): void => {
    thinkingLevelsCatalogKnownRef.current = false;
    thinkingLevelsRequestRef.current += 1;
    setThinkingLevelsLoading(false);
    setThinkingLevelsError(null);
    setPiStatus((current) => (
      current && current.availableThinkingLevels.length > 0
        ? { ...current, availableThinkingLevels: [] }
        : current
    ));
  }, []);

  useEffect(() => {
    if (piStatus?.state !== 'ready') {
      modelsRequestRef.current += 1;
      modelCatalogKeyRef.current = null;
      modelCatalogInitializedRef.current = false;
      thinkingLevelsCatalogKeyRef.current = null;
      thinkingLevelsCatalogVersionRef.current = -1;
      thinkingLevelsCatalogLengthRef.current = null;
      thinkingLevelsCatalogKnownRef.current = false;
      resetThinkingLevelsCatalog();
      setModelsLoading(false);
      setModelsError(null);
      setAgentControlPending(null);
      setAgentControlError(null);
      return;
    }

    if (
      !modelCatalogInitializedRef.current ||
      modelCatalogKeyRef.current !== activeModelKey
    ) {
      modelCatalogInitializedRef.current = true;
      modelCatalogKeyRef.current = activeModelKey;
      void loadAvailableModels();
    }

    const modelChanged = thinkingLevelsCatalogKeyRef.current !== activeModelKey;
    const mutationChanged =
      thinkingLevelsCatalogVersionRef.current !== thinkingLevelsRefreshVersion;
    const availableThinkingLevelsCount = piStatus.availableThinkingLevels.length;
    const catalogCleared =
      thinkingLevelsCatalogLengthRef.current !== null &&
      thinkingLevelsCatalogLengthRef.current > 0 &&
      availableThinkingLevelsCount === 0;
    if (catalogCleared) thinkingLevelsCatalogKnownRef.current = false;
    thinkingLevelsCatalogLengthRef.current = availableThinkingLevelsCount;
    const catalogMissing =
      !thinkingLevelsCatalogKnownRef.current &&
      availableThinkingLevelsCount === 0 &&
      !thinkingLevelsLoading &&
      thinkingLevelsError === null;
    if (!modelChanged && !mutationChanged && !catalogMissing) return;

    thinkingLevelsCatalogKeyRef.current = activeModelKey;
    thinkingLevelsCatalogVersionRef.current = thinkingLevelsRefreshVersion;
    resetThinkingLevelsCatalog();
    void loadAvailableThinkingLevels();
  }, [
    activeModelKey,
    loadAvailableModels,
    loadAvailableThinkingLevels,
    piStatus?.availableThinkingLevels.length,
    piStatus?.state,
    resetThinkingLevelsCatalog,
    thinkingLevelsError,
    thinkingLevelsLoading,
    thinkingLevelsRefreshVersion,
  ]);

  const handlePiEvent = useCallback((event: PiEvent): void => {
    if (event.type === 'runtime') {
      if (event.snapshot.state === 'ready' && event.snapshot.availableThinkingLevels.length > 0) {
        thinkingLevelsRequestRef.current += 1;
        thinkingLevelsCatalogKnownRef.current = true;
        setThinkingLevelsLoading(false);
        setThinkingLevelsError(null);
      }
      setPiStatus(event.snapshot);
      return;
    }
    if (event.type === 'conversation') {
      setConversation(event.snapshot);
      return;
    }
    if (event.type !== 'protocol') return;

    const request = parseExtensionUiRequest(event.message);
    if (!request) return;

    const notice = getExtensionUiNotice(request);
    if (isExtensionUiNoticeMethod(request)) {
      if (notice) showExtensionNotice(notice.message, notice.tone);
      return;
    }

    setExtensionRequest(request);
  }, [showExtensionNotice]);

  useEffect(() => window.piDesktop.onPiEvent(handlePiEvent), [handlePiEvent]);

  const respondToExtensionUi = useCallback(async (response: ExtensionUiResponse): Promise<void> => {
    setExtensionRespondingId(response.id);
    try {
      await window.piDesktop.sendExtensionUiResponse(response);
      setExtensionRequest((current) => (current?.id === response.id ? null : current));
    } catch {
      showExtensionNotice('Pi could not accept that extension response. Try again.', 'error');
    } finally {
      setExtensionRespondingId(null);
    }
  }, [showExtensionNotice]);

  const inspectDistro = useCallback(async () => {
    if (!selectedDistro) return;
    setProbe(await window.piDesktop.probeWslDistribution(selectedDistro));
  }, [selectedDistro]);

  const startPi = useCallback(async (workspaceOverride?: { distro: string; linuxPath: string }) => {
    const workspace = workspaceOverride ?? (selectedDistro ? { distro: selectedDistro, linuxPath } : null);
    if (!workspace) return;
    setPiStatus(await window.piDesktop.startPi(workspace));
    setConversation(await window.piDesktop.getConversation());
  }, [linuxPath, selectedDistro]);

  const retryPi = useCallback(async () => {
    const workspace = piStatus?.workspace;
    if (!workspace) return;

    try {
      await startPi(workspace);
    } catch {
      await refresh();
    }
  }, [piStatus?.workspace, refresh, startPi]);

  const stopPi = useCallback(async () => {
    setPiStatus(await window.piDesktop.stopPi());
    setConversation(await window.piDesktop.getConversation());
  }, []);

  const changeModel = useCallback(async (provider: string, modelId: string): Promise<void> => {
    setAgentControlPending('model');
    setAgentControlError(null);

    try {
      const model = await window.piDesktop.setModel(provider, modelId);
      setThinkingLevelsRefreshVersion((current) => current + 1);
      resetThinkingLevelsCatalog();
      setPiStatus((current) => (
        current?.state === 'ready'
          ? { ...current, model, availableThinkingLevels: [] }
          : current
      ));
    } catch (cause) {
      setAgentControlError(describeAgentStateError(cause, 'Pi could not change the model.'));
    } finally {
      setAgentControlPending((current) => current === 'model' ? null : current);
    }
  }, [resetThinkingLevelsCatalog]);

  const changeThinkingLevel = useCallback(async (level: PiThinkingLevel): Promise<void> => {
    setAgentControlPending('thinking');
    setAgentControlError(null);

    try {
      const thinkingLevel = await window.piDesktop.setThinkingLevel(level);
      setPiStatus((current) => (
        current?.state === 'ready'
          ? { ...current, thinkingLevel }
          : current
      ));
    } catch (cause) {
      setAgentControlError(describeAgentStateError(cause, 'Pi could not change the thinking level.'));
    } finally {
      setAgentControlPending((current) => current === 'thinking' ? null : current);
    }
  }, []);

  const sendPrompt = useCallback(async (prompt: string) => {
    setConversation(await window.piDesktop.sendPrompt(prompt));
  }, []);

  const abortPrompt = useCallback(async () => {
    setConversation(await window.piDesktop.abortPrompt());
  }, []);

  const runtimeError =
    piStatus && (piStatus.state === 'disconnected' || piStatus.state === 'failed')
      ? piStatus.lastError ?? `Pi runtime is ${piStatus.state}.`
      : null;

  const reportStatus = diagnostics?.overall === 'ready' ? 'Ready' : 'M0 shell online';
  const workspace = selectedDistro ? { distro: selectedDistro, linuxPath } : null;

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
        {piStatus?.lastWarning && (
          <div className="warning-banner" role="status">
            <span>Runtime warning: {piStatus.lastWarning}</span>
          </div>
        )}

        {!error && runtimeError && (
          <div className="error-banner" role="alert">
            <span>Pi runtime unavailable: {runtimeError}</span>
            {piStatus?.workspace && (
              <button onClick={() => void retryPi()} type="button">
                Reconnect Pi
              </button>
            )}
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
            agentState={{
              model: piStatus?.model ?? null,
              thinkingLevel: piStatus?.thinkingLevel ?? null,
              availableModels: piStatus?.availableModels ?? [],
              availableThinkingLevels: piStatus?.availableThinkingLevels ?? [],
              runtimeReady: piStatus?.state === 'ready',
              isLoadingModels: modelsLoading,
              isLoadingThinkingLevels: thinkingLevelsLoading,
              pendingControl: agentControlPending,
              modelCatalogError: modelsError,
              thinkingLevelsError,
              controlError: agentControlError,
              onRetryModels: modelsError ? loadAvailableModels : undefined,
              onRetryThinkingLevels: thinkingLevelsError ? loadAvailableThinkingLevels : undefined,
              onSetModel: changeModel,
              onSetThinkingLevel: changeThinkingLevel,
            }}
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
              <WorkspaceProofCard workspace={workspace} />
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
      <ExtensionUiSurface
        request={extensionRequest}
        notices={extensionNotices}
        isResponding={extensionRespondingId !== null}
        onRespond={respondToExtensionUi}
        onDismissNotice={(id) => setExtensionNotices((current) => current.filter((notice) => notice.id !== id))}
      />

      <footer className="app-footer">
        <span>Pi Desktop M0</span>
        <span className="footer-divider" aria-hidden="true" />
        <span>Safe boundary · Windows renderer ↔ host</span>
      </footer>
    </div>
  );
}

export default App;
