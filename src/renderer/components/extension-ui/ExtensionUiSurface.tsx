import { useEffect, useId, useState, type ReactElement } from 'react';
import type { ExtensionUiResponse } from '../../../shared/ipc';
import './ExtensionUiSurface.css';

export type ExtensionUiRequest = {
  readonly type: 'extension_ui_request';
  readonly id: string;
  readonly method: string;
  readonly [key: string]: unknown;
};

export type ExtensionUiNoticeTone = 'info' | 'warning' | 'error';

export interface ExtensionUiNotice {
  readonly id: string;
  readonly message: string;
  readonly tone: ExtensionUiNoticeTone;
}

export interface ExtensionUiNoticePayload {
  readonly message: string;
  readonly tone: ExtensionUiNoticeTone;
}

interface ExtensionUiSurfaceProps {
  request: ExtensionUiRequest | null;
  notices: readonly ExtensionUiNotice[];
  onRespond: (response: ExtensionUiResponse) => void | Promise<void>;
  onDismissNotice: (id: string) => void;
  isResponding?: boolean;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  const stringValue = readString(value)?.trim();
  return stringValue ? stringValue : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function parseExtensionUiRequest(message: unknown): ExtensionUiRequest | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;

  const candidate = message as { readonly [key: string]: unknown };
  if (candidate.type !== 'extension_ui_request') return null;
  if (typeof candidate.id !== 'string' || typeof candidate.method !== 'string') return null;

  return candidate as ExtensionUiRequest;
}

export function isInteractiveExtensionUiRequest(request: ExtensionUiRequest): boolean {
  return request.method === 'confirm'
    || request.method === 'select'
    || request.method === 'input'
    || request.method === 'editor';
}

export function getExtensionUiNotice(request: ExtensionUiRequest): ExtensionUiNoticePayload | null {
  if (request.method === 'notify') {
    const message = readNonEmptyString(request.message);
    const tone: ExtensionUiNoticeTone = request.notifyType === 'warning'
      ? 'warning'
      : request.notifyType === 'error'
        ? 'error'
        : 'info';
    return message ? { message, tone } : null;
  }

  if (request.method === 'setStatus' || request.method === 'status' || request.method === 'status_update') {
    const message = readNonEmptyString(request.statusText)
      ?? readNonEmptyString(request.status)
      ?? readNonEmptyString(request.message);
    return message ? { message, tone: 'info' } : null;
  }

  return null;
}

export function isExtensionUiNoticeMethod(request: ExtensionUiRequest): boolean {
  return request.method === 'notify'
    || request.method === 'setStatus'
    || request.method === 'status'
    || request.method === 'status_update';
}

function ExtensionNotice({
  notice,
  onDismiss,
}: {
  notice: ExtensionUiNotice;
  onDismiss: (id: string) => void;
}): ReactElement {
  return (
    <div className={`extension-notice extension-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span className="extension-notice-marker" aria-hidden="true" />
      <span className="extension-notice-message">{notice.message}</span>
      <button
        className="extension-notice-dismiss"
        type="button"
        onClick={() => onDismiss(notice.id)}
        aria-label="Dismiss notice"
      >
        ×
      </button>
    </div>
  );
}

function ExtensionRequestDialog({
  request,
  onRespond,
  isResponding,
}: {
  request: ExtensionUiRequest;
  onRespond: (response: ExtensionUiResponse) => void | Promise<void>;
  isResponding: boolean;
}): ReactElement {
  const [value, setValue] = useState(() => (
    request.method === 'editor' ? readString(request.prefill) ?? '' : ''
  ));
  const titleId = useId();
  const descriptionId = useId();
  const prefill = request.method === 'editor' ? readString(request.prefill) ?? '' : '';
  const title = readNonEmptyString(request.title) ?? 'Extension request';
  const message = readString(request.message) ?? 'An extension is requesting your attention.';
  const options = readStringArray(request.options);
  const placeholder = readString(request.placeholder) ?? undefined;
  const isSupported = isInteractiveExtensionUiRequest(request);

  useEffect(() => {
    setValue(prefill);
  }, [prefill, request.id, request.method]);

  const sendResponse = (response: ExtensionUiResponse): void => {
    void Promise.resolve(onRespond(response)).catch(() => {
      // The parent owns the notice shown when the host cannot accept a response.
    });
  };

  const cancel = (): void => {
    sendResponse({ type: 'extension_ui_response', id: request.id, cancelled: true });
  };

  const submit = (): void => {
    if (request.method === 'confirm') {
      sendResponse({ type: 'extension_ui_response', id: request.id, confirmed: true });
      return;
    }

    if (request.method === 'input' || request.method === 'editor') {
      sendResponse({ type: 'extension_ui_response', id: request.id, value });
    }
  };

  return (
    <div className="extension-request-backdrop">
      <section
        className="extension-request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <header className="extension-request-header">
          <div>
            <p className="extension-request-eyebrow">Pi extension request</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <span className="extension-request-method">{request.method}</span>
        </header>

        <div className="extension-request-body" id={descriptionId}>
          {request.method === 'confirm' && <p className="extension-request-message">{message}</p>}

          {request.method === 'select' && (
            <div className="extension-request-options">
              {options.length > 0 ? options.map((option) => (
                <button
                  key={option}
                  className="extension-option-button"
                  type="button"
                  disabled={isResponding}
                  onClick={() => sendResponse({ type: 'extension_ui_response', id: request.id, value: option })}
                >
                  <span>{option}</span>
                  <span aria-hidden="true">→</span>
                </button>
              )) : (
                <p className="extension-request-muted">This request did not include any choices. Cancel it to continue.</p>
              )}
            </div>
          )}

          {request.method === 'input' && (
            <input
              className="extension-request-input"
              autoFocus
              value={value}
              placeholder={placeholder}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
              disabled={isResponding}
              aria-label={title}
            />
          )}

          {request.method === 'editor' && (
            <textarea
              className="extension-request-editor"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={isResponding}
              aria-label={title}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          )}

          {!isSupported && (
            <div className="extension-request-unsupported">
              <strong>This extension control is not available in Pi Desktop.</strong>
              <p>Cancel the request so the extension can continue without this terminal-only interaction.</p>
            </div>
          )}
        </div>

        <footer className="extension-request-footer">
          <button className="extension-cancel-button" type="button" onClick={cancel} disabled={isResponding}>
            Cancel
          </button>
          {request.method === 'confirm' && (
            <button className="extension-submit-button" type="button" onClick={submit} disabled={isResponding}>
              Confirm
            </button>
          )}
          {(request.method === 'input' || request.method === 'editor') && (
            <button className="extension-submit-button" type="button" onClick={submit} disabled={isResponding}>
              {request.method === 'editor' ? 'Send text' : 'Submit'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

export function ExtensionUiSurface({
  request,
  notices,
  onRespond,
  onDismissNotice,
  isResponding = false,
}: ExtensionUiSurfaceProps): ReactElement | null {
  if (!request && notices.length === 0) return null;

  return (
    <div className="extension-ui-surface">
      {notices.length > 0 && (
        <div className="extension-notice-stack" aria-label="Extension notices" aria-live="polite">
          {notices.map((notice) => (
            <ExtensionNotice key={notice.id} notice={notice} onDismiss={onDismissNotice} />
          ))}
        </div>
      )}
      {request && (
        <ExtensionRequestDialog request={request} onRespond={onRespond} isResponding={isResponding} />
      )}
    </div>
  );
}
