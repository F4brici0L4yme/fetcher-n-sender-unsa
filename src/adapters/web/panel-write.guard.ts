import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class PanelWriteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method !== 'POST') return true;
    const target = URL.parse('http://' + request.get('host'));
    if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) return false;
    const origin = request.get('origin');
    const fetchSite = request.get('sec-fetch-site');
    return (!origin || origin === target.origin) && (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none');
  }
}
