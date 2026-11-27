export type BrowserSessionState = 'disconnected' | 'connecting' | 'connected' | 'expired' | 'error';

export interface BrowserViewerAccess {
  url: string;
  password: string;
}

export interface BrowserSessionStatus {
  accountId: string;
  state: BrowserSessionState;
  busy: boolean;
  message: string;
  viewer?: BrowserViewerAccess | null;
}

export class BrowserSessionError extends Error {
  constructor(readonly code: 'browser_busy' | 'invalid_identity' | 'browser_unavailable', message: string) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}
