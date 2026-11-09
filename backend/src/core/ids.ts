export const pad = (n: number, width: number): string => String(n).padStart(width, '0');

export const numericPart = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

export const prefixedId = (prefix: 'T' | 'E' | 'D' | 'K' | 'P' | 'I' | 'R' | 'CR', n: number): string => `${prefix}${n}`;

export const slugify = (name: string): string => {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s.length >= 2 ? s : `p-${s || 'x'}`;
};

export const branchSlug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'work';

export const ticketBranch = (projectId: string, ticketId: string, title: string, prefix = 'hack/'): string =>
  `${prefix}${projectId}/${ticketId}-${branchSlug(title)}`;
