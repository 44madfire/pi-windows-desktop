import type { PiEvent, PiRuntimeSnapshot, WslWorkspace } from '../../../shared/ipc.ts';
import { WslManager, type PiExecutableProbe } from '../../wsl/index.ts';
import { PiRpcClient, type PiRpcEvent, type PiRpcTransport } from './index.ts';
import { createWslPiTransport } from './wsl-process-transport.ts';
import { SessionManager } from '../session/session-manager.ts';

export interface PiRuntimeHandlers {
  onEvent?: (event: PiEvent) => void;
}

export interface PiRuntimeOptions {
  readonly wsl?: WslManager;
  readonly createTransport?: (options: {
    distro: string;
    linuxPath: string;
    piExecutable: string;
  }) => PiRpcTransport;
  readonly handlers?: PiRuntimeHandlers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entryIdFromEvent(event: PiRpcEvent): string | null {
  const record = event as Record<string, unknown>;
  const direct = record.entryId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const entry = record.entry;
  if (entry && typeof entry === 'object') {
    const nested = (entry as Record<string, unknown>).id;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return null;
}

function piProbeDetail(probe: PiExecutableProbe | null): string {
  if (!probe) return 'Pi was not checked because the distribution is unavailable.';
  if (probe.available) return `Pi ${probe.version ?? 'version unknown'} is available.`;
  return `Pi is unavailable (${probe.reason}).`;
}

export class PiRuntimeController {
  private readonly wsl: WslManager;
  private readonly createTransport: NonNullable<PiRuntimeOptions['createTransport']>;
  private readonly handlers: PiRuntimeHandlers;
  private client: PiRpcClient | null = null;
  private session: SessionManager | null = null;
  private snapshotValue: PiRuntimeSnapshot = {
    state: 'stopped',
    workspace: null,
    piVersion: null,
    lastError: null,
    lastEntryId: null,
  };

  constructor(options: PiRuntimeOptions = {}) {
    this.wsl = options.wsl ?? new WslManager();
    this.createTransport = options.createTransport ?? ((transportOptions) => createWslPiTransport(transportOptions));
    this.handlers = options.handlers ?? {};
  }

  get snapshot(): PiRuntimeSnapshot {
    return { ...this.snapshotValue, workspace: this.snapshotValue.workspace && { ...this.snapshotValue.workspace } };
  }

  async start(workspace: WslWorkspace): Promise<PiRuntimeSnapshot> {
    if (this.snapshotValue.state === 'ready' || this.snapshotValue.state === 'starting') {
      await this.stop();
    }

    const previousCursor = this.session?.lastEntryId ?? this.snapshotValue.lastEntryId;
    const previousSessionId = this.session?.sessionId ?? null;
    this.setSnapshot({ state: 'starting', workspace, lastError: null, lastEntryId: previousCursor, piVersion: null });

    try {
      const probe = await this.wsl.probeDistribution(workspace.distro);
      if (!probe.available) throw new Error(`WSL distribution is unavailable: ${workspace.distro}`);
      if (!probe.pi?.available) throw new Error(`Pi was not found in ${workspace.distro}`);

      const piExecutable = probe.pi.executable;
      const client = new PiRpcClient({
        transportFactory: () => this.createTransport({ distro: workspace.distro, linuxPath: workspace.linuxPath, piExecutable }),
      });
      this.client = client;
      const session = SessionManager.fromSnapshot(
        {
          state: previousCursor ? 'disconnected' : 'new',
          sessionId: previousSessionId,
          lastEntryId: previousCursor,
          lastError: null,
        },
        client,
      );
      this.session = session;
      session.onStateChange((sessionSnapshot) => {
        if (this.client === client && sessionSnapshot.lastEntryId) {
          this.setSnapshot({ lastEntryId: sessionSnapshot.lastEntryId });
        }
      });
      client.onEvent((event) => {
        const entryId = entryIdFromEvent(event);
        if (entryId) this.setSnapshot({ lastEntryId: entryId });
        this.handlers.onEvent?.({ type: 'protocol', message: event });
      });
      client.onStderr((text) => this.handlers.onEvent?.({ type: 'stderr', text }));
      client.onError((error) => {
        if (this.client !== client || this.snapshotValue.state === 'stopping') return;
        this.setSnapshot({ state: 'disconnected', lastError: error.message });
      });

      await client.connect();
      this.setSnapshot({ state: 'ready', workspace, piVersion: probe.pi.version, lastError: null });
      if (previousCursor) {
        void session.reconnect(client).catch((error: unknown) => {
          if (this.client === client) {
            this.setSnapshot({ lastError: `Session recovery failed: ${errorMessage(error)}` });
          }
        });
      }
      return this.snapshot;
    } catch (error) {
      this.client = null;
      this.setSnapshot({ state: 'failed', lastError: errorMessage(error) });
      throw error;
    }
  }

  async stop(): Promise<PiRuntimeSnapshot> {
    if (!this.client) {
      this.setSnapshot({ state: 'stopped', workspace: null });
      return this.snapshot;
    }

    const client = this.client;
    this.setSnapshot({ state: 'stopping' });
    this.client = null;
    await client.close();
    this.setSnapshot({ state: 'stopped', workspace: null, piVersion: null });
    return this.snapshot;
  }

  private setSnapshot(patch: Partial<PiRuntimeSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    this.handlers.onEvent?.({ type: 'runtime', snapshot: this.snapshot });
  }
}

export { piProbeDetail };
