import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

const COOKIE = 'stekolshik_session';

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.ui.sessionSecret).update(payload).digest('base64url');
}

export function issueToken(): string {
  const expires = Date.now() + config.ui.sessionTtlMs;
  const payload = `${expires}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return false;
  }
  return Number(payload) > Date.now();
}

export function checkPassword(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const expected = Buffer.from(config.ui.password);
  const given = Buffer.from(input);
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.ui.sessionTtlMs / 1000)}${secure}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function isAuthenticated(req: Request): boolean {
  if (verifyToken(readCookie(req, COOKIE))) return true;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return verifyToken(header.slice(7));
  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

export function tokenFromUrl(url: string): string | undefined {
  const query = url.split('?')[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get('token') ?? undefined;
}

export { COOKIE as SESSION_COOKIE, readCookie };
