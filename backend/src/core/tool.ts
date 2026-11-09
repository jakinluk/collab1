import type { RepoLike } from './repos';

/** The fix queue for HackathonOne itself is an ordinary project with this id. */
export const TOOL_PROJECT_ID = 'hackathonone';
export const TOOL_REPO_NAME = 'hakatonOne';

export type ToolArea = 'plugin' | 'board' | 'backend' | 'docs';

export const TOOL_AREAS: Record<ToolArea, { paths: string[]; lanes: string[]; check?: string }> = {
  plugin: {
    paths: ['plugin/lib/**', 'plugin/skills/**', 'plugin/hooks/**', 'plugin/monitors/**', 'plugin/templates/**', 'plugin/scripts/**', 'plugin/test/**'],
    lanes: ['plugin'],
    check: 'node --test plugin/test/*.test.mjs && bash e2e/cli-e2e.sh',
  },
  board: { paths: ['board/**'], lanes: ['board'], check: 'cd e2e && npm ci && node board-e2e.mjs' },
  backend: {
    paths: ['backend/src/app/**', 'backend/src/core/**', 'backend/src/handlers/**', 'backend/src/adapters/**', 'backend/test/**', 'backend/scripts/**'],
    lanes: ['backend'],
    check: 'cd backend && npm run typecheck && npm test',
  },
  docs: { paths: ['README.md', 'docs/SPEC.md', 'docs/DEPLOY.md', 'docs/SECURITY.md', 'e2e/README.md', 'plugin/README.md', 'backend/README.md'], lanes: ['docs'] },
};

export const toolRepo = (url: string): RepoLike => ({
  name: TOOL_REPO_NAME,
  url,
  baseBranch: 'main',
  integrationBranch: 'main',
  hotPaths: ['.claude-plugin/**', 'plugin/.claude-plugin/**', '**/package-lock.json', 'backend/lib/**', 'backend/bin/**'],
  contractPaths: ['backend/src/shared/**', 'docs/CONTRACT.md'],
  setup: ['cd backend && npm ci', 'cd e2e && npm ci'],
  verify: [
    { name: 'backend', cmd: 'cd backend && npm run typecheck && npm test' },
    { name: 'plugin', cmd: 'node --test plugin/test/*.test.mjs' },
    { name: 'cli e2e', cmd: 'bash e2e/cli-e2e.sh' },
  ],
  instructionsPath: 'README.md',
  laneMap: (Object.keys(TOOL_AREAS) as ToolArea[]).flatMap((a) => TOOL_AREAS[a].paths.map((glob) => ({ glob, lane: TOOL_AREAS[a].lanes[0] }))),
  prLabels: ['hackathonone-fix'],
  notes:
    'Fixes to HackathonOne itself, merged into main. Backend and board fixes reach everyone with the next deploy. Plugin fixes reach Macs only after a release: bump plugin/.claude-plugin/plugin.json and publish it (board Settings → Releases, or h1 release propose).',
});
