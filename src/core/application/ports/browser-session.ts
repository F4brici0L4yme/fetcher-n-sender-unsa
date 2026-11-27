import type { BrowserSessionStatus } from '../../domain/browser-session';

export const PERSONAL_SESSION = Symbol('PersonalSession');

export interface PersonalSession {
  current(): string;
  status(): Promise<BrowserSessionStatus>;
  connect(expectedIdentity: string): Promise<BrowserSessionStatus>;
  disconnect(): Promise<BrowserSessionStatus>;
}
