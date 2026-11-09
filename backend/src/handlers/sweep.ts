import { getHub } from './context';

export const handler = async (): Promise<Record<string, number>> => {
  const stats = await getHub().sweep();
  if (Object.values(stats).some((n) => n > 0)) console.log(JSON.stringify({ level: 'info', where: 'sweep', ...stats }));
  return stats;
};
