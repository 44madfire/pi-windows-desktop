/**
 * The host port is deliberately transferred through the page event boundary.
 * Electron MessagePorts must not be returned through a contextBridge promise.
 */
export const HOST_PORT_MESSAGE = 'pi-desktop:host-port' as const;

export interface HostPortMessage {
  readonly type: typeof HOST_PORT_MESSAGE;
}

export interface HostPortLike {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

export function isHostPort(value: unknown): value is HostPortLike {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<HostPortLike>;
  return (
    typeof candidate.postMessage === 'function' &&
    typeof candidate.start === 'function' &&
    typeof candidate.close === 'function'
  );
}
