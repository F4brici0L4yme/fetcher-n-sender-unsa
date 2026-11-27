import { ConflictException } from '@nestjs/common';

export type PanelAccount = string | { current(): string };
export function currentAccount(account: PanelAccount): string {
  return typeof account === 'string' ? account : account.current();
}
export function assertCurrentAccount(account: PanelAccount, submitted: unknown): void {
  if (typeof account !== 'string' && submitted !== account.current()) {
    throw new ConflictException('La cuenta cambió. Abre de nuevo el panel antes de continuar.');
  }
}
