/* CollabOne board: demo data and a scripted event stream for offline demo mode. */
(function () {
  'use strict';
  const C1 = (window.C1 = window.C1 || {});

  const MIN = 60 * 1000;

  function ticket(t) {
    return Object.assign(
      {
        repo: 'platform',
        type: 'slice',
        lanes: [],
        deps: [],
        pathsOwned: [],
        acceptance: [],
        priority: 3,
        wave: 1,
        attempts: 0,
        createdBy: 'lukasz',
        createdByAgent: false,
        log: [],
        version: 1,
      },
      t
    );
  }

  C1.demoData = function demoData() {
    const now = Date.now();
    const ago = (m) => now - m * MIN;
    const inMin = (m) => now + m * MIN;

    const projects = [
      {
        id: 'offline-capture',
        name: 'Offline note capture',
        description: 'Field technicians capture notes with photos on iOS while offline; everything syncs to the inspection report when the phone is back online.',
        tags: ['mobile', 'offline', 'field ops'],
        links: [
          { label: 'Slack #hack-offline', url: 'https://example.slack.com/archives/C0HACKOFF' },
          { label: 'Figma flows', url: 'https://www.figma.com/file/offline-capture' },
        ],
        demo: { url: 'https://hack-int.example.com/reports/demo', stage: 'hack-int', notes: 'Demo account details are in the team password manager. Seed with npm run seed:demo.' },
        repos: [
          {
            name: 'platform',
            url: 'git@github.com:acme/platform.git',
            baseBranch: 'main',
            integrationBranch: 'hack/offline-capture',
            hotPaths: ['package.json', 'package-lock.json', 'nx.json', '**/project.json', 'tsconfig.base.json', '.github/**', '**/serverless*.yml'],
            contractPaths: ['libs/shared/**'],
            setup: ['npm ci'],
            verify: [
              { name: 'typecheck', cmd: 'npm run type:check' },
              { name: 'lint', cmd: 'npx nx affected -t lint' },
              { name: 'unit', cmd: 'npx nx affected -t unit' },
            ],
            instructionsPath: 'CLAUDE.md',
            laneMap: [
              { glob: 'services/**', lane: 'api' },
              { glob: 'apps/web/**', lane: 'web' },
              { glob: 'infra/**', lane: 'infra' },
            ],
            prLabels: ['hackathon', 'agent'],
            notes: 'Never run builds (npm run build, nx build, affected:build): use type:check and unit tests',
          },
          {
            name: 'mobile',
            url: 'git@github.com:acme/mobile.git',
            baseBranch: 'develop',
            integrationBranch: 'hack/offline-capture',
            hotPaths: ['package.json', 'package-lock.json', 'app.json', 'app.config.*', 'eas.json', 'ios/**', 'android/**', '.github/**'],
            contractPaths: ['src/api/**'],
            setup: ['npm ci'],
            verify: [
              { name: 'typecheck', cmd: 'npx tsc --noEmit' },
              { name: 'lint', cmd: 'npx expo lint' },
              { name: 'unit', cmd: 'npm test -- --watchAll=false' },
            ],
            instructionsPath: 'CLAUDE.md',
            laneMap: [{ glob: 'src/**', lane: 'mobile' }],
            prLabels: ['hackathon'],
            notes: 'Native folders are generated: change app config instead of ios/ or android/. Use the shared c1-run-ios-sim skill to run the app.',
          },
        ],
        lanes: ['mobile', 'api', 'web', 'infra'],
        status: 'active',
        phase: 'build',
        goalVersion: 2,
        createdBy: 'lukasz',
        createdAt: ago(300),
      },
      {
        id: 'repair-cart',
        name: 'Inspection to repair cart',
        description: 'Any inspection PDF becomes a priced, bookable repair cart the buyer can check out in one step.',
        tags: ['ai', 'checkout'],
        links: [{ label: 'Slack #hack-repair-cart', url: 'https://example.slack.com/archives/C0HACKCART' }],
        demo: { stage: 'hack-int' },
        repos: [
          {
            name: 'platform',
            url: 'git@github.com:acme/platform.git',
            baseBranch: 'main',
            integrationBranch: 'hack/repair-cart',
            hotPaths: ['package.json', 'package-lock.json', 'nx.json', '**/project.json', 'tsconfig.base.json', '.github/**', '**/serverless*.yml'],
            contractPaths: ['libs/shared/**'],
            setup: ['npm ci'],
            verify: [
              { name: 'typecheck', cmd: 'npm run type:check' },
              { name: 'lint', cmd: 'npx nx affected -t lint' },
              { name: 'unit', cmd: 'npx nx affected -t unit' },
            ],
            instructionsPath: 'CLAUDE.md',
            laneMap: [
              { glob: 'services/**', lane: 'api' },
              { glob: 'apps/web/**', lane: 'web' },
              { glob: 'infra/**', lane: 'infra' },
            ],
            prLabels: ['hackathon', 'agent'],
            notes: 'Never run builds (npm run build, nx build, affected:build): use type:check and unit tests',
          },
        ],
        lanes: ['api', 'web', 'ai'],
        status: 'active',
        phase: 'build',
        goalVersion: 1,
        createdBy: 'marek',
        createdAt: ago(290),
      },
    ];

    const goals = {
      'offline-capture': {
        projectId: 'offline-capture',
        version: 2,
        statement: 'A field tech captures a note with photos on iOS while offline, and it syncs to the web report once the phone is back online.',
        definitionOfDone: [
          'Capture a note with a photo in airplane mode',
          'Queued notes sync automatically on reconnect',
          'Synced note shows up in the web report without a reload',
          'Editing the same note on two devices shows a merge prompt',
        ],
        demoScript:
          'Turn on airplane mode, capture two notes with photos, turn airplane mode off, watch both appear in the web report, then edit one on the web and on the phone to show the merge prompt.',
        nonGoals: ['Android', 'Video capture'],
        contact: 'lukasz',
        createdBy: 'lukasz',
        createdAt: ago(240),
      },
      'repair-cart': {
        projectId: 'repair-cart',
        version: 1,
        statement: 'Upload any inspection PDF and get a priced repair cart the homeowner can book.',
        definitionOfDone: [
          'Upload a PDF and see the notes it contains',
          'Each note maps to a repair item with a price range',
          'The homeowner books selected repairs from the cart',
          'Export a negotiation pack as a PDF',
        ],
        demoScript: 'Upload the sample inspection, review the extracted notes, pick three repairs, book them and download the negotiation pack.',
        nonGoals: ['Scanned PDFs (OCR)', 'Payments'],
        contact: 'marek',
        createdBy: 'marek',
        createdAt: ago(280),
      },
    };

    const tickets = [
      ticket({ id: 'T1', projectId: 'offline-capture', title: 'Note draft schema + sync API contract', type: 'contract', lanes: ['api'], status: 'done', priority: 1, wave: 0, pathsOwned: ['libs/shared/api-interfaces/src/note-sync/**'], acceptance: [{ cmd: 'npm run type:check', criterion: 'Contract types compile' }], branch: 'hack/offline-capture/T1-sync-contract', prUrl: 'https://github.com/acme/platform/pull/1412', dodRefs: [], log: [{ ts: ago(200), who: 'lukasz', kind: 'agent', text: 'Merged by ania (review).' }], updatedAt: ago(200) }),
      ticket({ id: 'T2', projectId: 'offline-capture', repo: 'mobile', title: 'Local note queue on device', lanes: ['mobile'], status: 'done', priority: 1, deps: ['T1'], pathsOwned: ['src/features/note-queue/**'], acceptance: [{ cmd: 'npm test -- note-queue', criterion: 'Queue persists across app restarts' }], branch: 'hack/offline-capture/T2-local-queue', prUrl: 'https://github.com/acme/mobile/pull/88', dodRefs: [0], updatedAt: ago(150) }),
      ticket({ id: 'T3', projectId: 'offline-capture', repo: 'mobile', title: 'Capture screen works in airplane mode', lanes: ['mobile'], status: 'review', priority: 1, deps: ['T2'], pathsOwned: ['src/features/capture/**'], acceptance: [{ cmd: 'npm test -- capture', criterion: 'Capture saves to the local queue with no network' }, { criterion: 'Photo thumbnails render from local storage' }], branch: 'hack/offline-capture/T3-offline-capture', prUrl: 'https://github.com/acme/mobile/pull/91', booking: { seatId: 'ania', sessionId: 's-ania-2', leaseExpiresAt: inMin(12) }, review: { seatId: 'lukasz', workerId: 'w1', leaseExpiresAt: inMin(14) }, dodRefs: [0], log: [{ ts: ago(18), who: 'ania', kind: 'agent', text: 'PR opened; acceptance commands green.' }, { ts: ago(6), who: 'lukasz', kind: 'agent', text: 'Review booked by worker w1.' }], updatedAt: ago(6) }),
      ticket({ id: 'T4', projectId: 'offline-capture', title: 'POST /notes/batch idempotent upsert', lanes: ['api'], status: 'in_progress', priority: 1, deps: ['T1'], pathsOwned: ['services/note/src/sync/**'], acceptance: [{ cmd: 'npx nx run note:unit --testPathPattern=batch-upsert', criterion: 'Replaying the same batch creates no duplicates' }], branch: 'hack/offline-capture/T4-batch-upsert', booking: { seatId: 'ania', sessionId: 's-ania-1', leaseExpiresAt: inMin(11) }, dodRefs: [1], log: [{ ts: ago(25), who: 'ania', kind: 'agent', text: 'Booked. Working in worktree hack-T4.' }], updatedAt: ago(3) }),
      ticket({ id: 'T5', projectId: 'offline-capture', repo: 'mobile', title: 'Background sync on reconnect', lanes: ['mobile'], status: 'booked', priority: 2, deps: ['T2'], pathsOwned: ['src/features/sync/**'], acceptance: [{ cmd: 'npm test -- sync', criterion: 'Queue drains within one reconnect cycle' }], branch: 'hack/offline-capture/T5-background-sync', booking: { seatId: 'lukasz', workerId: 'w2', leaseExpiresAt: inMin(15) }, dodRefs: [1], updatedAt: ago(1) }),
      ticket({ id: 'T6', projectId: 'offline-capture', title: 'Conflict detection by version', lanes: ['api'], status: 'ready', priority: 2, deps: ['T1'], pathsOwned: ['services/note/src/conflict/**'], acceptance: [{ cmd: 'npx nx run note:unit --testPathPattern=conflict', criterion: 'Stale version returns 409 with both versions' }], dodRefs: [3], updatedAt: ago(40) }),
      ticket({ id: 'T7', projectId: 'offline-capture', repo: 'mobile', title: 'Merge prompt for conflicting edits', lanes: ['mobile'], status: 'planned', priority: 3, wave: 2, deps: ['T6'], pathsOwned: ['src/features/merge/**'], acceptance: [{ criterion: 'User picks a version per field' }], dodRefs: [3], updatedAt: ago(90) }),
      ticket({ id: 'T8', projectId: 'offline-capture', title: 'E2E: offline capture to web report', type: 'test', lanes: ['web'], status: 'planned', priority: 3, wave: 2, deps: ['T3', 'T4', 'T5', 'T11'], pathsOwned: ['e2e-tests/src/offline-capture/**'], acceptance: [{ cmd: 'npx nx run e2e-tests:e2e --grep offline', criterion: 'Demo journey passes twice in a row' }], updatedAt: ago(90) }),
      ticket({ id: 'T9', projectId: 'offline-capture', title: 'Photo upload with pre-signed URLs', lanes: ['infra'], status: 'blocked', priority: 2, deps: ['T1'], pathsOwned: ['services/media/src/upload/**'], acceptance: [{ criterion: 'Photos upload after reconnect, resumable' }], branch: 'hack/offline-capture/T9-photo-upload', booking: { seatId: 'tomek', sessionId: 's-tomek-1', leaseExpiresAt: inMin(9) }, attempts: 1, log: [{ ts: ago(12), who: 'tomek', kind: 'agent', text: 'Raised E5 (B6): needs sandbox bucket access.' }], updatedAt: ago(12) }),
      ticket({ id: 'T10', projectId: 'offline-capture', title: 'Register sync handler in serverless config', type: 'glue', lanes: ['infra'], status: 'done', priority: 1, wave: 0, deps: ['T1'], pathsOwned: ['services/note/serverless.yml'], acceptance: [{ cmd: 'npm run type:check', criterion: 'Handler registered' }], prUrl: 'https://github.com/acme/platform/pull/1415', updatedAt: ago(170) }),
      ticket({ id: 'T11', projectId: 'offline-capture', title: 'Web report refreshes live', lanes: ['web'], status: 'ready', priority: 2, deps: ['T4'], pathsOwned: ['apps/web/src/report/live/**'], acceptance: [{ criterion: 'New notes appear without reload' }], dodRefs: [2], updatedAt: ago(50) }),
      ticket({ id: 'T12', projectId: 'offline-capture', repo: 'mobile', title: 'Spike: photo compression on device', type: 'spike', lanes: ['mobile'], status: 'in_progress', priority: 4, pathsOwned: ['spikes/compression/**'], acceptance: [{ criterion: 'Recommendation with sizes for 3 settings' }], booking: { seatId: 'lukasz', workerId: 'w1', leaseExpiresAt: inMin(13) }, updatedAt: ago(4) }),

      ticket({ id: 'T13', projectId: 'repair-cart', title: 'Note to repair-item mapping contract', type: 'contract', lanes: ['api'], status: 'done', priority: 1, wave: 0, pathsOwned: ['libs/shared/api-interfaces/src/repair-cart/**'], acceptance: [{ cmd: 'npm run type:check', criterion: 'Types compile' }], prUrl: 'https://github.com/acme/platform/pull/1409', updatedAt: ago(220), createdBy: 'marek' }),
      ticket({ id: 'T14', projectId: 'repair-cart', title: 'PDF upload and text extraction', lanes: ['api'], status: 'done', priority: 1, deps: ['T13'], pathsOwned: ['services/inspection-import/src/upload/**'], acceptance: [{ cmd: 'npx nx run inspection-import:unit', criterion: 'Sample PDFs extract text' }], prUrl: 'https://github.com/acme/platform/pull/1413', dodRefs: [0], updatedAt: ago(130), createdBy: 'marek' }),
      ticket({ id: 'T15', projectId: 'repair-cart', title: 'Note extraction prompt + evals', lanes: ['ai'], status: 'review', priority: 1, deps: ['T14'], pathsOwned: ['services/inspection-import/src/extract/**'], acceptance: [{ cmd: 'npx nx run inspection-import:evals', criterion: 'Recall at least the eval baseline' }], branch: 'hack/repair-cart/T15-extraction', prUrl: 'https://github.com/acme/platform/pull/1418', booking: { seatId: 'kasia', sessionId: 's-kasia-1', leaseExpiresAt: inMin(10) }, dodRefs: [0], updatedAt: ago(9), createdBy: 'marek' }),
      ticket({ id: 'T16', projectId: 'repair-cart', title: 'Price range lookup from GC catalog', lanes: ['api'], status: 'in_progress', priority: 1, deps: ['T13'], pathsOwned: ['services/estimate/src/price-range/**'], acceptance: [{ cmd: 'npx nx run estimate:unit --testPathPattern=price-range', criterion: 'Every mapped item has min and max' }], branch: 'hack/repair-cart/T16-price-range', booking: { seatId: 'marek', sessionId: 's-marek-1', leaseExpiresAt: inMin(8) }, dodRefs: [1], updatedAt: ago(2), createdBy: 'marek' }),
      ticket({ id: 'T17', projectId: 'repair-cart', title: 'Repair cart page', lanes: ['web'], status: 'in_progress', priority: 2, deps: ['T13'], pathsOwned: ['apps/web/src/repair-cart/**'], acceptance: [{ criterion: 'Cart lists items with ranges and totals' }], branch: 'hack/repair-cart/T17-cart-page', booking: { seatId: 'kasia', sessionId: 's-kasia-2', leaseExpiresAt: inMin(14) }, dodRefs: [1], updatedAt: ago(5), createdBy: 'marek' }),
      ticket({ id: 'T18', projectId: 'repair-cart', title: 'Book selected repairs', lanes: ['web', 'api'], status: 'ready', priority: 2, deps: ['T13'], pathsOwned: ['apps/web/src/repair-cart/booking/**', 'services/job/src/booking-from-cart/**'], acceptance: [{ criterion: 'Booking creates jobs for selected items' }], dodRefs: [2], updatedAt: ago(60), createdBy: 'marek' }),
      ticket({ id: 'T19', projectId: 'repair-cart', title: 'Negotiation pack PDF export', lanes: ['api'], status: 'planned', priority: 3, wave: 2, deps: ['T16'], pathsOwned: ['services/report/src/negotiation-pack/**'], acceptance: [{ criterion: 'PDF lists fix / credit / skip per item' }], dodRefs: [3], updatedAt: ago(100), createdBy: 'marek' }),
      ticket({ id: 'T20', projectId: 'repair-cart', title: 'E2E: sample inspection to booked cart', type: 'test', lanes: ['web'], status: 'planned', priority: 3, wave: 2, deps: ['T15', 'T17', 'T18'], pathsOwned: ['e2e-tests/src/repair-cart/**'], acceptance: [{ cmd: 'npx nx run e2e-tests:e2e --grep repair-cart', criterion: 'Journey passes from a clean state' }], updatedAt: ago(100), createdBy: 'marek' }),
      ticket({ id: 'T21', projectId: 'repair-cart', title: 'OCR fallback for scanned PDFs', lanes: ['ai'], status: 'blocked', priority: 3, deps: ['T14'], pathsOwned: ['services/inspection-import/src/ocr/**'], acceptance: [{ criterion: 'Scanned sample extracts notes' }], booking: { seatId: 'tomek', sessionId: 's-tomek-2', leaseExpiresAt: inMin(7) }, log: [{ ts: ago(8), who: 'tomek', kind: 'agent', text: 'Raised E4 (B5): OCR is outside the demo scope.' }], updatedAt: ago(8), createdBy: 'marek', createdByAgent: true }),
      ticket({ id: 'T22', projectId: 'repair-cart', title: 'Seed demo inspections', type: 'chore', lanes: ['api'], status: 'done', priority: 2, pathsOwned: ['scripts/seed/inspections/**'], acceptance: [{ criterion: 'Three sample inspections load' }], updatedAt: ago(110), createdBy: 'marek' }),
    ];

    const seats = [
      { id: 'lukasz', name: 'Łukasz', machine: 'lukasz-mbp', lanes: ['mobile', 'api', 'infra'], projects: ['offline-capture'], pinned: true, plan: 'ultra', workMode: 'factory', autopilot: true, lastSeen: ago(0.2), usage: { sevenDayPct: 41, at: ago(1) }, sessions: [{ sessionId: 'w1', state: 'working', ticketId: 'T12', lastTool: 'Bash', at: ago(0.3) }, { sessionId: 'w2', state: 'working', ticketId: 'T5', lastTool: 'Edit', at: ago(0.5) }, { sessionId: 'w3', state: 'idle', at: ago(2) }] },
      { id: 'ania', name: 'Ania', machine: 'ania-mbp', lanes: ['mobile', 'api'], projects: ['offline-capture'], pinned: true, plan: 'ultra', workMode: 'multi_session', autopilot: true, lastSeen: ago(0.4), usage: { sevenDayPct: 28, at: ago(2) }, sessions: [{ sessionId: 's-ania-1', state: 'working', ticketId: 'T4', lastTool: 'Bash', at: ago(0.4) }, { sessionId: 's-ania-2', state: 'idle', ticketId: 'T3', at: ago(3) }] },
      { id: 'tomek', name: 'Tomek', machine: 'tomek-mbp', lanes: ['infra', 'ai'], projects: ['offline-capture', 'repair-cart'], pinned: false, plan: 'ultra', workMode: 'multi_session', autopilot: true, lastSeen: ago(1), usage: { sevenDayPct: 63, at: ago(4) }, sessions: [{ sessionId: 's-tomek-1', state: 'needs_input', ticketId: 'T9', lastTool: 'Bash', at: ago(4) }, { sessionId: 's-tomek-2', state: 'idle', ticketId: 'T21', at: ago(6) }] },
      { id: 'marek', name: 'Marek', machine: 'marek-mbp', lanes: ['api', 'ai'], projects: ['repair-cart'], pinned: true, plan: 'ultra', workMode: 'solo', autopilot: true, lastSeen: ago(0.1), usage: { sevenDayPct: 35, at: ago(1) }, sessions: [{ sessionId: 's-marek-1', state: 'working', ticketId: 'T16', lastTool: 'Edit', at: ago(0.1) }] },
      { id: 'kasia', name: 'Kasia', machine: 'kasia-mbp', lanes: ['web', 'ai'], projects: ['repair-cart'], pinned: true, plan: 'ultra', workMode: 'subagents', autopilot: true, lastSeen: ago(0.3), usage: { sevenDayPct: 22, at: ago(3) }, sessions: [{ sessionId: 's-kasia-1', state: 'idle', ticketId: 'T15', at: ago(9) }, { sessionId: 's-kasia-2', state: 'working', ticketId: 'T17', lastTool: 'Write', at: ago(0.3) }] },
    ];

    const escalations = [
      { id: 'E3', kind: 'help', projectId: 'offline-capture', ticketId: 'T3', ruleCode: 'B3', ruleVersion: 4, summary: 'iOS Simulator build fails: xcodebuild cannot find the selected Xcode', detail: 'xcode-select points to Command Line Tools. Tried resetting DerivedData twice.', status: 'open', raisedBy: 'ania', raisedByKind: 'agent', deadline: inMin(6), createdAt: ago(4) },
      { id: 'E4', kind: 'blocker', projectId: 'repair-cart', ticketId: 'T21', ruleCode: 'B5', ruleVersion: 4, summary: 'Cut the OCR fallback for scanned PDFs from the demo scope', detail: 'Sample inspections are all text PDFs. OCR adds a new dependency and is listed as a non-goal.', proposed: ['Cut T21 and keep the goal', 'Keep T21 as stretch'], status: 'resolved_pending_contest', raisedBy: 'tomek', raisedByKind: 'agent', resolution: { text: 'Cut T21; keep the goal as is.', by: 'marek', at: ago(3), contestUntil: inMin(7) }, createdAt: ago(8) },
      { id: 'E5', kind: 'blocker', projectId: 'offline-capture', ticketId: 'T9', ruleCode: 'B6', ruleVersion: 4, summary: 'Photo upload needs access to the sandbox media bucket', detail: 'The hack stage has no bucket policy for the media service role. Needs someone with sandbox admin access.', status: 'open', raisedBy: 'tomek', raisedByKind: 'agent', createdAt: ago(12) },
    ];

    const decisions = [
      { id: 'D2', projectId: 'offline-capture', question: 'Note ids for the batch upsert: client-generated UUID or server sequence?', options: ['Client UUID', 'Server sequence'], context: 'Raised under B1 by ania for T4; affects T5 and T6.', electorate: 'affected_seats', eligible: ['ania', 'lukasz', 'tomek'], rule: 'majority', quorum: 2, deadline: inMin(6), defaultOption: 'Client UUID', votes: [{ seat: 'ania', option: 'Client UUID', by: 'agent', why: 'Offline devices cannot reach the server to get an id.', ts: ago(3) }, { seat: 'lukasz', option: 'Client UUID', by: 'agent', why: 'Idempotency comes for free with a client key.', ts: ago(2) }], status: 'open' },
      { id: 'D3', projectId: 'repair-cart', question: 'Show a price range or a single estimate in the cart?', options: ['Range', 'Single estimate'], context: 'Raised under B9: T16 and T17 disagree on the cart line format.', electorate: 'affected_seats', eligible: ['marek', 'kasia', 'tomek'], rule: 'majority', quorum: 2, deadline: inMin(9), defaultOption: 'Range', votes: [{ seat: 'marek', option: 'Range', by: 'human', why: 'The catalog only has ranges.', ts: ago(1) }, { seat: 'kasia', option: 'Single estimate', by: 'agent', why: 'Easier to read on mobile.', ts: ago(2) }], status: 'open' },
    ];

    const proposals = [
      { id: 'P6', action: 'goal.set', payload: { projectId: 'repair-cart' }, summary: 'Add "cart can be shared by link" to the repair-cart definition of done', proposedBy: 'kasia', status: 'pending', createdAt: ago(5), expiresAt: inMin(24 * 60) },
      { id: 'P7', action: 'plan.load', payload: { projectId: 'offline-capture' }, summary: 'Add 3 tickets for photo upload retry and progress UI (T23 to T25)', proposedBy: 'lukasz', status: 'pending', createdAt: ago(2), expiresAt: inMin(24 * 60) },
    ];

    const knowledge = [
      { id: 'K7', kind: 'skill', name: 'c1-run-ios-sim', version: 2, author: 'ania', tags: ['ios', 'simulator', 'e2e'], scope: 'global', body: 'Build the app, boot the iOS Simulator and run the Maestro flows.', status: 'active', createdAt: ago(7) },
      { id: 'K6', kind: 'tip', name: 'xcode-select first', version: 1, author: 'lukasz', tags: ['ios'], scope: 'global', body: 'xcrun simctl boot fails until Xcode is selected: sudo xcode-select -s /Applications/Xcode.app', status: 'active', createdAt: ago(16) },
      { id: 'K5', kind: 'playbook', name: 'Unit tests in a worktree', version: 1, author: 'marek', tags: ['monorepo', 'tests'], scope: 'global', body: 'Symlink node_modules, then run nx unit through test-lock.sh.', status: 'active', createdAt: ago(48) },
      { id: 'K4', kind: 'tip', name: 'Never build locally', version: 1, author: 'kasia', tags: ['monorepo'], scope: 'global', body: 'Use npm run type:check, never nx build: bundling takes over 1 GB per service.', status: 'active', createdAt: ago(95) },
    ];

    const rules = {
      version: 4,
      rows: [
        { code: 'B1', name: 'Contract change', trigger: 'Changing a shared interface, schema, event or an API another ticket uses', severity: 'P1', resolver: 'agent_quorum', resolverNote: 'affected seats', quorumRule: 'majority', timeoutMin: 10, defaultOnTimeout: 'Keep the current contract and add an adapter', stopScope: 'dependents', notify: 'affected', version: 1 },
        { code: 'B2', name: 'Outside owned paths', trigger: 'Editing a file outside pathsOwned (package.json, lockfile, shared config, another ticket)', severity: 'P2', resolver: 'owner', timeoutMin: 5, defaultOnTimeout: 'Open a glue ticket and continue with a stub', stopScope: 'ticket', notify: 'affected', version: 1 },
        { code: 'B3', name: 'Env / tooling broken', trigger: 'Simulator, build, deploy, CI or a local service will not work', severity: 'P2', resolver: 'any_agent', resolverNote: 'then any human', timeoutMin: 10, defaultOnTimeout: 'Escalate to any human', stopScope: 'ticket', maxAttempts: 2, notify: 'all', version: 3 },
        { code: 'B4', name: 'Ambiguous requirement', trigger: 'Acceptance is unclear and the choice changes user-visible behaviour on the demo path', severity: 'P2', resolver: 'any_human', contestMin: 5, timeoutMin: 10, defaultOnTimeout: 'Simplest option that satisfies the demo script', stopScope: 'ticket', notify: 'humans', version: 2 },
        { code: 'B5', name: 'Scope / goal change', trigger: 'A ticket cannot be done as specified, or the goal needs to change', severity: 'P1', resolver: 'any_human', resolverNote: 'contest → human quorum', contestMin: 10, timeoutMin: 15, defaultOnTimeout: 'Cut the ticket, keep the goal', stopScope: 'dependents', notify: 'humans', version: 2 },
        { code: 'B6', name: 'Secrets / access / money', trigger: 'Credentials, paid services, production data or third-party accounts', severity: 'P0', resolver: 'any_human', resolverNote: 'who has the access', defaultOnTimeout: 'Wait; ticket parked', stopScope: 'ticket', maxAttempts: 0, notify: 'humans', version: 1 },
        { code: 'B7', name: 'Destructive / irreversible', trigger: 'Deleting data, force push, rewriting shared history, deploying to a shared environment', severity: 'P0', resolver: 'any_human', contestMin: 5, defaultOnTimeout: 'Do not do it', stopScope: 'all', maxAttempts: 0, notify: 'humans', version: 1 },
        { code: 'B8', name: 'Stuck', trigger: 'maxAttempts failed verification cycles, or no progress since the last checkpoint', severity: 'P2', resolver: 'self', resolverNote: 'then any agent', defaultOnTimeout: 'Release with notes; the next taker continues', stopScope: 'ticket', maxAttempts: 3, notify: 'affected', version: 1 },
        { code: 'B9', name: 'Disagreement / conflict', trigger: 'Two agents’ work conflicts (merge conflicts, contradictory designs)', severity: 'P1', resolver: 'agent_quorum', resolverNote: 'involved seats + one neutral', quorumRule: 'majority', timeoutMin: 10, defaultOnTimeout: 'The ticket earlier in the dependency order wins', stopScope: 'dependents', notify: 'affected', version: 1 },
        { code: 'U1', name: 'Urgent: branch red', trigger: 'Integration branch fails type-check, tests or smoke', severity: 'P0', resolver: 'any_agent', resolverNote: 'first to book the fix', defaultOnTimeout: 'Revert the offending PR', stopScope: 'all', notify: 'all', version: 1 },
      ],
    };

    let seq = 1180;
    const ev = (minsAgo, stream, type, from, fromKind, summary, extra) =>
      Object.assign({ seq: ++seq, ts: ago(minsAgo), stream, type, from, fromKind, summary }, extra || {});
    const events = [
      ev(20, 'tasks', 'ticket.booked', 'ania', 'agent', 'ania booked T3 Capture screen works in airplane mode', { projectId: 'offline-capture', ticketId: 'T3' }),
      ev(18, 'tasks', 'ticket.pr', 'ania', 'agent', 'T3 PR #91 opened, review needed', { projectId: 'offline-capture', ticketId: 'T3' }),
      ev(16, 'knowledge', 'tip.shared', 'lukasz', 'agent', 'Tip shared: xcode-select first'),
      ev(12, 'escalations', 'blocker.raised', 'tomek', 'agent', 'E5 (B6) T9 needs access to the sandbox media bucket', { projectId: 'offline-capture', ticketId: 'T9' }),
      ev(9, 'tasks', 'ticket.pr', 'kasia', 'agent', 'T15 PR #1418 opened, review needed', { projectId: 'repair-cart', ticketId: 'T15' }),
      ev(8, 'escalations', 'blocker.raised', 'tomek', 'agent', 'E4 (B5) Cut the OCR fallback from the demo scope', { projectId: 'repair-cart', ticketId: 'T21' }),
      ev(7, 'knowledge', 'skill.updated', 'ania', 'agent', 'Skill c1-run-ios-sim v2 published, synced to every Mac'),
      ev(6, 'tasks', 'ticket.review_booked', 'lukasz', 'agent', 'lukasz/w1 booked the review of T3', { projectId: 'offline-capture', ticketId: 'T3' }),
      ev(5, 'decisions', 'proposal.created', 'kasia', 'agent', 'P6 proposed: add "cart shareable by link" to the definition of done', { projectId: 'repair-cart' }),
      ev(4, 'escalations', 'help.requested', 'ania', 'agent', 'E3 (B3) iOS Simulator build fails: needs a hand', { projectId: 'offline-capture', ticketId: 'T3' }),
      ev(3, 'escalations', 'escalation.resolved', 'marek', 'human', 'E4 resolved by Marek: cut T21. Contest window 10 min', { projectId: 'repair-cart', ticketId: 'T21' }),
      ev(2, 'decisions', 'proposal.created', 'lukasz', 'agent', 'P7 proposed: 3 tickets for photo upload retry', { projectId: 'offline-capture' }),
      ev(1, 'decisions', 'vote.cast', 'marek', 'human', 'Marek voted Range on D3', { projectId: 'repair-cart' }),
      ev(0.5, 'tasks', 'ticket.booked', 'lukasz', 'agent', 'lukasz/w2 booked T5 Background sync on reconnect', { projectId: 'offline-capture', ticketId: 'T5' }),
    ];

    const tokens = [
      { tokenId: 'tk-8f2a', kind: 'agent', label: 'lukasz-mbp', createdAt: ago(300), lastUsedAt: ago(0.2), expiresAt: inMin(60 * 30) },
      { tokenId: 'tk-91c0', kind: 'worker', workerId: 'w1', label: 'factory worker w1', createdAt: ago(240), lastUsedAt: ago(0.3), expiresAt: inMin(60 * 30) },
      { tokenId: 'tk-a7d3', kind: 'worker', workerId: 'w2', label: 'factory worker w2', createdAt: ago(240), lastUsedAt: ago(0.5), expiresAt: inMin(60 * 30) },
    ];

    return {
      me: seats[0],
      projects,
      goals,
      tickets,
      seats,
      escalations,
      decisions,
      proposals,
      knowledge,
      rules,
      events,
      tokens,
      settings: { leaseTtlSec: 900, maxBookingsPerSeat: null, defaultContestMin: 10 },
      lastSeq: seq,
    };
  };

  /*
   * Scripted demo stream. Each step mutates the demo state and returns an envelope.
   * The board calls these one at a time on a timer; after the last step it restarts.
   */
  C1.demoSteps = [
    function (s, now) {
      const t = find(s.tickets, 'T5');
      t.status = 'in_progress';
      t.updatedAt = now;
      t.log.push({ ts: now, who: 'lukasz', kind: 'agent', text: 'Started in worktree hack-T5.' });
      return env(s, now, 'tasks', 'ticket.status', 'lukasz', 'agent', 'T5 Background sync on reconnect is in progress', 'offline-capture', 'T5');
    },
    function (s, now) {
      const d = find(s.decisions, 'D2');
      d.votes.push({ seat: 'tomek', option: 'Client UUID', by: 'agent', why: 'Matches how T9 keys photo uploads.', ts: now });
      d.status = 'made';
      d.outcome = 'Client UUID';
      s.tickets.forEach((t) => {
        if (t.id === 'T4') t.log.push({ ts: now, who: 'system', kind: 'agent', text: 'D2 decided: Client UUID.' });
      });
      return env(s, now, 'decisions', 'decision.made', 'system', 'system', 'D2 decided: Client UUID (3 of 3 votes)', 'offline-capture');
    },
    function (s, now) {
      const t = find(s.tickets, 'T11');
      t.status = 'booked';
      t.booking = { seatId: 'ania', sessionId: 's-ania-2', leaseExpiresAt: now + 15 * MIN };
      t.updatedAt = now;
      return env(s, now, 'tasks', 'ticket.booked', 'ania', 'agent', 'ania booked T11 Web report refreshes live', 'offline-capture', 'T11');
    },
    function (s, now) {
      s.knowledge.unshift({ id: 'K8', kind: 'skill', name: 'c1-run-maestro-flow', version: 1, author: 'lukasz', tags: ['ios', 'e2e'], scope: 'global', body: 'Run one Maestro flow against the booted simulator with retries.', status: 'active', createdAt: now });
      return env(s, now, 'knowledge', 'skill.published', 'lukasz', 'agent', 'Skill c1-run-maestro-flow v1 published, synced to every Mac');
    },
    function (s, now) {
      const t = find(s.tickets, 'T3');
      t.status = 'done';
      t.review = undefined;
      t.updatedAt = now;
      t.log.push({ ts: now, who: 'lukasz', kind: 'agent', text: 'Reviewed and merged into hack/offline-capture.' });
      return env(s, now, 'tasks', 'ticket.done', 'lukasz', 'agent', 'T3 merged by lukasz/w1. T8 is one dependency closer', 'offline-capture', 'T3');
    },
    function (s, now) {
      const e = find(s.escalations, 'E3');
      e.status = 'resolved';
      e.resolution = { text: 'Use the c1-run-ios-sim skill; it selects Xcode first.', by: 'lukasz', at: now };
      return env(s, now, 'escalations', 'escalation.resolved', 'lukasz', 'agent', 'E3 answered by lukasz: use the c1-run-ios-sim skill', 'offline-capture', 'T3');
    },
    function (s, now) {
      const t = find(s.tickets, 'T18');
      t.status = 'booked';
      t.booking = { seatId: 'kasia', sessionId: 's-kasia-1', leaseExpiresAt: now + 15 * MIN };
      t.updatedAt = now;
      return env(s, now, 'tasks', 'ticket.booked', 'kasia', 'agent', 'kasia booked T18 Book selected repairs', 'repair-cart', 'T18');
    },
    function (s, now) {
      const t = find(s.tickets, 'T4');
      t.status = 'review';
      t.prUrl = 'https://github.com/acme/platform/pull/1421';
      t.updatedAt = now;
      t.log.push({ ts: now, who: 'ania', kind: 'agent', text: 'PR #1421 opened; acceptance commands green.' });
      return env(s, now, 'tasks', 'ticket.pr', 'ania', 'agent', 'T4 PR #1421 opened, review needed', 'offline-capture', 'T4');
    },
    function (s, now) {
      const d = find(s.decisions, 'D3');
      d.votes.push({ seat: 'tomek', option: 'Range', by: 'agent', why: 'Single estimates would be invented numbers.', ts: now });
      return env(s, now, 'decisions', 'vote.cast', 'tomek', 'agent', 'tomek voted Range on D3 (2 of 3)', 'repair-cart');
    },
    function (s, now) {
      const t = find(s.tickets, 'T16');
      t.status = 'review';
      t.prUrl = 'https://github.com/acme/platform/pull/1422';
      t.updatedAt = now;
      return env(s, now, 'tasks', 'ticket.pr', 'marek', 'agent', 'T16 PR #1422 opened, review needed', 'repair-cart', 'T16');
    },
  ];

  function find(list, id) {
    return list.find((x) => x.id === id);
  }

  function env(s, now, stream, type, from, fromKind, summary, projectId, ticketId) {
    s.lastSeq += 1;
    const e = { seq: s.lastSeq, ts: now, stream, type, from, fromKind, summary };
    if (projectId) e.projectId = projectId;
    if (ticketId) e.ticketId = ticketId;
    return e;
  }
})();
