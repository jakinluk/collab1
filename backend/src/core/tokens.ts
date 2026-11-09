import { createHash, randomBytes, randomInt } from 'node:crypto';

export const AGENT_TOKEN_PREFIX = 'c1a_';
export const AGENT_TOKEN_RE = /^c1a_[A-Za-z0-9_-]{43}$/;

export const generateAgentToken = (): string => `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

export const isAgentToken = (token: string): boolean => AGENT_TOKEN_RE.test(token);

export const hashSecret = (pepper: string, value: string): string => createHash('sha256').update(pepper).update(value).digest('hex');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const generateJoinCode = (): string => {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
};

export const generateTokenId = (): string => `tk_${randomBytes(6).toString('base64url')}`;

export const stripBearer = (header: string | undefined): string | undefined => {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return (m ? m[1] : header).trim() || undefined;
};
