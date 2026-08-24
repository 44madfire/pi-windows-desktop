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

/**
 * Resolve the target origin for the host-port transfer. The transferred
 * MessagePort must never be broadcast to arbitrary origins (`*`). Electron
 * file:// pages serialize their origin as "file://", while opaque origins
 * (e.g. sandboxed data: documents) report the literal "null". Anything that
 * is not a concrete application origin falls back to the packaged file
 * origin instead of leaking the port.
 */
export function safeHostPortTargetOrigin(origin: string): string {
  return origin && origin !== 'null' ? origin : 'file://';
}
