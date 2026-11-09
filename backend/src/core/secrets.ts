export interface SecretFinding {
  type: string;
  preview: string;
}

const PATTERNS: [string, RegExp][] = [
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['aws-secret-access-key', /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/gi],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  ['anthropic-api-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-style-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['private-key-block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['h1-agent-token', /\bh1a_[A-Za-z0-9_-]{43}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
];

const GENERIC = /\b(secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[=:]\s*["']?([^\s"'`,;]{12,})/gi;

export const shannonEntropy = (s: string): number => {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
};

const redact = (s: string): string => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)}`);

export const scanSecrets = (text: string): SecretFinding[] => {
  const findings: SecretFinding[] = [];
  for (const [type, re] of PATTERNS) for (const m of text.matchAll(re)) findings.push({ type, preview: redact(m[0]) });
  for (const m of text.matchAll(GENERIC)) {
    const value = m[2];
    if (/^\$\{?[A-Z_]+\}?$/.test(value) || /^<.*>$/.test(value) || /^(x+|\*+|\.+)$/i.test(value)) continue;
    if (shannonEntropy(value) >= 3.5) findings.push({ type: `generic-${m[1].toLowerCase()}`, preview: redact(value) });
  }
  return findings;
};
