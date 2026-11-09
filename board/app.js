/* HackathonOne board: state, rendering and actions. Demo mode runs fully offline; live mode talks to the hub (CONTRACT §4, §7). */
(function () {
  'use strict';
  const H1 = window.H1;

  /* ---------------------------------------------------------------- helpers */

  function h(tag, props) {
    const el = document.createElement(tag);
    const kids = Array.prototype.slice.call(arguments, 2);
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      });
    }
    append(el, kids);
    return el;
  }

  function append(el, kids) {
    kids.forEach((k) => {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) append(el, k);
      else if (k instanceof Node) el.appendChild(k);
      else el.appendChild(document.createTextNode(String(k)));
    });
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    sun: ['circle:12,12,4', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
    moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
    projector: ['M3 5h18v11H3z', 'M8 21h8', 'M12 16v5'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
    clock: ['circle:12,12,9', 'M12 7v5l3 2'],
    branch: ['circle:6,5,2', 'circle:6,19,2', 'circle:18,6,2', 'M6 7v10', 'M18 8c0 5-6 4-11 9'],
    link: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    copy: ['M9 9h11v11H9z', 'M5 15V5a1 1 0 0 1 1-1h9'],
    alert: ['M12 3l9.5 17h-19z', 'M12 10v4', 'M12 17.2v.3'],
    vote: ['M4 8h16v12H4z', 'M9 14l2 2 4-4', 'M8 4h8v4H8z'],
    users: ['circle:9,8,3', 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6', 'M16 5.2a3 3 0 0 1 0 5.6', 'M21 20c0-2.6-1.6-4.8-4-5.6'],
    book: ['M4 5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2z', 'M4 20V5'],
    bolt: ['M13 2L4 14h7l-1 8 9-12h-7z'],
    key: ['circle:8,15,4', 'M11 12l9-9', 'M16.5 6.5l3 3'],
    sliders: ['M4 6h9', 'M17 6h3', 'circle:15,6,2', 'M4 12h3', 'M11 12h9', 'circle:9,12,2', 'M4 18h11', 'M19 18h1', 'circle:17,18,2'],
    logout: ['M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4', 'M10 17l-5-5 5-5', 'M5 12h11'],
    columns: ['M3 4h5v16H3z', 'M10 4h5v11h-5z', 'M17 4h4v7h-4z'],
    rules: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.5', 'M3.5 12h.5', 'M3.5 18h.5'],
    layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
    bulb: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z'],
    doc: ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 13h6', 'M9 17h6'],
    pause: ['M8 5v14', 'M16 5v14'],
    play: ['M7 5l12 7-12 7z'],
    hand: ['M8 13V5.5a1.5 1.5 0 0 1 3 0V11', 'M11 10.5V4.5a1.5 1.5 0 0 1 3 0V11', 'M14 11V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 4 15.5L3.2 12a1.5 1.5 0 0 1 2.7-1.2L8 13'],
    plus: ['M12 5v14', 'M5 12h14'],
    pr: ['circle:6,6,2', 'circle:6,18,2', 'circle:18,18,2', 'M6 8v8', 'M18 16V9a3 3 0 0 0-3-3h-4', 'M13 3l-2 3 2 3'],
  };

  function icon(name, label) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    if (label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', label);
    } else svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach((d) => {
      let node;
      if (d.indexOf('circle:') === 0) {
        const p = d.slice(7).split(',');
        node = document.createElementNS(SVGNS, 'circle');
        node.setAttribute('cx', p[0]);
        node.setAttribute('cy', p[1]);
        node.setAttribute('r', p[2]);
      } else {
        node = document.createElementNS(SVGNS, 'path');
        node.setAttribute('d', d);
      }
      svg.appendChild(node);
    });
    return svg;
  }

  function brandMark() {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', '1.5');
    r.setAttribute('y', '1.5');
    r.setAttribute('width', '29');
    r.setAttribute('height', '29');
    r.setAttribute('rx', '8');
    r.setAttribute('fill', 'none');
    r.setAttribute('stroke', 'currentColor');
    r.setAttribute('stroke-width', '2');
    svg.style.color = 'var(--accent)';
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M9 9v14 M9 16h8 M17 9v14 M21.5 12l3-3v14');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2.4');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(r);
    svg.appendChild(p);
    return svg;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function seatName(id) {
    const s = S.data.seats.find((x) => x.id === id);
    return s ? s.name : id;
  }

  function relTime(ts) {
    if (!ts) return '';
    const d = Math.round((Date.now() - ts) / 1000);
    if (d < 45) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    return Math.round(d / 86400) + ' d ago';
  }

  function clockTime(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function countdownText(deadline) {
    const ms = deadline - Date.now();
    if (ms <= 0) return '00:00';
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function countdown(deadline, prefix) {
    return h('span', { class: 'countdown', 'data-deadline': deadline, 'data-prefix': prefix || '' }, icon('clock'), h('span', { class: 'cd-text', text: (prefix || '') + countdownText(deadline) }));
  }

  function store() {
    try {
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  function pref(key, fallback) {
    const st = store();
    if (!st) return fallback;
    try {
      const v = st.getItem('h1.pref.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function setPref(key, value) {
    const st = store();
    if (!st) return;
    try {
      st.setItem('h1.pref.' + key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable */
    }
  }

  function toast(message, kind) {
    const host = document.getElementById('toasts');
    const t = h('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), text: message });
    host.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('Copied'),
        () => toast('Copying was blocked. Select the text and copy it.', 'error')
      );
    } else toast('Copying is not available here. Select the text and copy it.', 'error');
  }

  const STATUS_LABEL = {
    planned: 'Planned',
    ready: 'Ready',
    booked: 'Booked',
    in_progress: 'In progress',
    review: 'Review',
    done: 'Done',
    blocked: 'Blocked',
    dropped: 'Dropped',
  };
  const WORK_MODE = { solo: 'Solo', subagents: 'Sub-agents', multi_session: 'Multi-session', factory: 'Factory' };
  const RESOLVER_LABEL = {
    self: 'Self',
    any_agent: 'Any agent',
    owner: 'Owner',
    agent_quorum: 'Agent quorum',
    any_human: 'Any human',
    human_quorum: 'Human quorum',
    human_named: 'Named human',
  };
  const ACTION_LABEL = {
    'project.create': 'New project',
    'release.publish': 'Release',
    'project.update': 'Project change',
    'project.status': 'Project status',
    'project.phase': 'Phase change',
    'goal.set': 'Goal change',
    'plan.load': 'Plan / tickets',
    'rules.set': 'Rule change',
    'rules.override': 'Project rule override',
    'escalation.resolve': 'Resolve escalation',
    'escalation.contest': 'Contest',
    'settings.set': 'Settings',
    'token.worker': 'Worker token',
  };
  const PHASE_LABEL = { plan: 'Plan', build: 'Build', freeze: 'Freeze', demo: 'Demo' };

  /* ---------------------------------------------------------------- state */

  const S = {
    mode: 'demo',
    config: null,
    data: null,
    selectedProjectId: null,
    tab: 'board',
    conn: 'demo',
    drawerTicketId: null,
    editingRule: null,
    joinCode: null,
    logFilter: 'all',
    demoPaused: false,
    demoStep: 0,
    flash: {},
    newSeqs: {},
    pendingRender: false,
  };

  function emptyData() {
    return {
      me: null,
      projects: [],
      goals: {},
      tickets: [],
      seats: [],
      escalations: [],
      decisions: [],
      proposals: [],
      knowledge: [],
      rules: { version: 0, rows: [] },
      events: [],
      tokens: [],
      settings: {},
      lastSeq: 0,
    };
  }

  function project() {
    return S.data.projects.find((p) => p.id === S.selectedProjectId) || S.data.projects[0] || null;
  }

  function projectTickets(pid) {
    return S.data.tickets.filter((t) => t.projectId === pid);
  }

  /* ---------------------------------------------------------------- theme & modes */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function initPrefs() {
    let theme = pref('theme', null);
    if (!theme) theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    applyTheme(theme);
    if (pref('projector', false)) document.documentElement.classList.add('projector');
  }

  /* ---------------------------------------------------------------- rendering */

  const root = document.getElementById('app');
  const overlay = document.getElementById('overlay');

  function isEditing() {
    const a = document.activeElement;
    return !!(a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest('[data-keep-focus]'));
  }

  function render() {
    if (isEditing()) {
      S.pendingRender = true;
      return;
    }
    S.pendingRender = false;
    const scrollY = window.scrollY;
    const railScroll = root.querySelector('.rail') ? root.querySelector('.rail').scrollTop : 0;
    const colsScroll = root.querySelector('.columns') ? root.querySelector('.columns').scrollLeft : 0;
    const focusedKey = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-focus-key');
    root.replaceChildren(...[topBar(), releaseBanner(), h('main', { id: 'main', class: 'page', tabindex: '-1' }, mainContent())].filter(Boolean));
    const rail = root.querySelector('.rail');
    if (rail) rail.scrollTop = railScroll;
    const cols = root.querySelector('.columns');
    if (cols) cols.scrollLeft = colsScroll;
    window.scrollTo(0, scrollY);
    if (focusedKey) {
      const el = root.querySelector('[data-focus-key="' + focusedKey + '"]');
      if (el) el.focus({ preventScroll: true });
    }
  }

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (S.pendingRender && !isEditing()) render();
    }, 0);
  });

  function topBar() {
    const p = project();
    const tabs = [
      ['board', 'Board', 'columns'],
      ['rules', 'Rules', 'rules'],
      ['tokens', 'Tokens & Macs', 'key'],
      ['settings', 'Settings', 'sliders'],
    ];
    const connLabel = { live: 'Live', connecting: 'Connecting', offline: 'Reconnecting', demo: 'Simulated' }[S.conn] || S.conn;
    return h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, brandMark(), h('span', { text: 'HackathonOne' })),
      S.data.projects.length
        ? h(
            'label',
            { class: 'field-inline' },
            h('span', { class: 'sr', text: 'Project' }),
            h(
              'select',
              {
                'aria-label': 'Selected project',
                'data-focus-key': 'project-select',
                onchange: (e) => selectProject(e.target.value),
              },
              S.data.projects.map((pr) => h('option', { value: pr.id, selected: p && pr.id === p.id, text: pr.name }))
            )
          )
        : null,
      p ? h('span', { class: 'phase-pill', title: 'Project phase', text: 'Phase: ' + (PHASE_LABEL[p.phase] || p.phase || 'Build') }) : null,
      h(
        'nav',
        { class: 'tabs', role: 'tablist', 'aria-label': 'Board sections' },
        tabs.map((t) =>
          h(
            'button',
            {
              class: 'tab',
              role: 'tab',
              'aria-label': t[1],
              'aria-selected': S.tab === t[0] ? 'true' : 'false',
              'data-focus-key': 'tab-' + t[0],
              onclick: () => {
                S.tab = t[0];
                render();
              },
            },
            icon(t[2]),
            h('span', { class: 'tab-label', text: t[1] })
          )
        )
      ),
      h('div', { class: 'spacer' }),
      h(
        'div',
        { class: 'topbar-right' },
        S.mode === 'demo' ? h('span', { class: 'demo-badge', title: 'Sample data, no backend', text: 'Demo data' }) : null,
        S.mode === 'demo'
          ? h(
              'button',
              {
                class: 'btn icon-only',
                title: S.demoPaused ? 'Resume demo stream' : 'Pause demo stream',
                'aria-pressed': S.demoPaused ? 'true' : 'false',
                'data-focus-key': 'demo-pause',
                onclick: () => {
                  S.demoPaused = !S.demoPaused;
                  render();
                },
              },
              icon(S.demoPaused ? 'play' : 'pause'),
              h('span', { class: 'sr', text: S.demoPaused ? 'Resume demo stream' : 'Pause demo stream' })
            )
          : null,
        h('span', { class: 'conn ' + S.conn, title: 'Realtime connection' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), connLabel),
        h('span', { class: 'clock', id: 'clock', text: clockTime(Date.now()), 'aria-label': 'Local time' }),
        h(
          'button',
          {
            class: 'btn icon-only',
            'aria-label': currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
            'data-focus-key': 'theme',
            onclick: () => {
              const next = currentTheme() === 'dark' ? 'light' : 'dark';
              applyTheme(next);
              setPref('theme', next);
              render();
            },
          },
          icon(currentTheme() === 'dark' ? 'sun' : 'moon')
        ),
        h(
          'button',
          {
            class: 'btn icon-only',
            'aria-label': 'Projector mode',
            'aria-pressed': document.documentElement.classList.contains('projector') ? 'true' : 'false',
            'data-focus-key': 'projector',
            onclick: () => {
              const on = document.documentElement.classList.toggle('projector');
              setPref('projector', on);
              render();
            },
          },
          icon('projector')
        ),
        S.data.me
          ? h('span', { class: 'avatar lg', title: 'Signed in as ' + S.data.me.name, 'aria-label': 'Signed in as ' + S.data.me.name, text: initials(S.data.me.name) })
          : null,
        S.mode === 'live'
          ? h('button', { class: 'btn icon-only', 'aria-label': 'Sign out', onclick: () => H1.Auth.signOut() }, icon('logout'))
          : null
      )
    );
  }

  function mainContent() {
    if (S.tab === 'rules') return rulesTab();
    if (S.tab === 'tokens') return tokensTab();
    if (S.tab === 'settings') return settingsTab();
    if (!S.data.projects.length) {
      const empty = h(
        'section',
        { class: 'panel', style: { padding: '24px' } },
        h('h2', { text: 'No projects yet' }),
        h('p', { class: 'muted', text: 'Start one here, or run /h1:project new in Claude Code and approve it on the right.' }),
        h('button', { class: 'btn primary', 'data-focus-key': 'new-project', onclick: () => openProjectEditor(null) }, icon('plus'), 'New project')
      );
      return h('div', { class: 'board-layout' }, h('div', { class: 'board-main' }, empty, eventLog()), rail());
    }
    return [projectsStrip(), h('div', { class: 'board-layout' }, h('div', { class: 'board-main' }, goalHeader(), reposPanel(), blockedLane(), kanban(), eventLog()), rail())];
  }

  /* ---- all projects strip */

  function projectStats(pid) {
    const ts = projectTickets(pid).filter((t) => t.status !== 'dropped');
    const c = { total: ts.length, done: 0, review: 0, progress: 0, blocked: 0 };
    ts.forEach((t) => {
      if (t.status === 'done') c.done++;
      else if (t.status === 'review') c.review++;
      else if (t.status === 'booked' || t.status === 'in_progress') c.progress++;
      else if (t.status === 'blocked') c.blocked++;
    });
    return c;
  }

  function projectsStrip() {
    return h(
      'section',
      { 'aria-labelledby': 'projects-h' },
      h('div', { class: 'section-title' }, h('h2', { id: 'projects-h', text: 'All projects' }), h('span', { class: 'meta', text: S.data.projects.length + ' active · everyone sees every project' })),
      h(
        'div',
        { class: 'projects', style: { marginTop: '8px' } },
        S.data.projects.map((p) => {
          const c = projectStats(p.id);
          const esc = S.data.escalations.filter((e) => e.projectId === p.id && e.status !== 'resolved' && e.status !== 'defaulted').length;
          const votes = S.data.decisions.filter((d) => d.projectId === p.id && d.status === 'open').length;
          const members = S.data.seats.filter((s) => (s.projects || []).indexOf(p.id) >= 0);
          const pct = (n) => (c.total ? (n / c.total) * 100 : 0) + '%';
          const selected = project() && project().id === p.id;
          return h(
            'button',
            {
              class: 'project-card',
              'aria-pressed': selected ? 'true' : 'false',
              'aria-label': p.name + ': ' + c.done + ' of ' + c.total + ' tickets done',
              'data-focus-key': 'project-' + p.id,
              onclick: () => selectProject(p.id),
            },
            h('div', { class: 'row' }, h('span', { class: 'name', text: p.name }), h('span', { class: 'chip mono', text: p.id })),
            h(
              'div',
              { class: 'progress', 'aria-hidden': 'true' },
              h('span', { class: 'p-done', style: { width: pct(c.done) } }),
              h('span', { class: 'p-review', style: { width: pct(c.review) } }),
              h('span', { class: 'p-progress', style: { width: pct(c.progress) } }),
              h('span', { class: 'p-blocked', style: { width: pct(c.blocked) } })
            ),
            h(
              'div',
              { class: 'row' },
              h(
                'div',
                { class: 'stats' },
                h('span', { class: 'chip strong', text: c.done + '/' + c.total + ' done' }),
                c.blocked ? h('span', { class: 'chip bad', text: c.blocked + ' blocked' }) : null,
                esc ? h('span', { class: 'chip warn', text: esc + ' escalation' + (esc > 1 ? 's' : '') }) : null,
                votes ? h('span', { class: 'chip accent', text: votes + ' vote' + (votes > 1 ? 's' : '') }) : null
              ),
              h(
                'div',
                { class: 'members', 'aria-label': members.length + ' members' },
                members.map((m) => h('span', { class: 'avatar', title: m.name, text: initials(m.name) }))
              )
            )
          );
        }),
        h(
          'button',
          { class: 'project-card new-project', 'data-focus-key': 'new-project', onclick: () => openProjectEditor(null) },
          h('span', { class: 'name' }, icon('plus'), ' New project'),
          h('span', { class: 'muted', text: 'Any participant can start one: repos, branches, protected paths and checks.' })
        )
      )
    );
  }

  /* ---- goal header */

  function dodState(p) {
    const goal = S.data.goals[p.id];
    if (!goal || !Array.isArray(goal.definitionOfDone)) return [];
    const ts = projectTickets(p.id);
    return goal.definitionOfDone.map((text, i) => {
      const refs = ts.filter((t) => (t.dodRefs || []).indexOf(i) >= 0 && t.status !== 'dropped');
      const done = refs.length > 0 && refs.every((t) => t.status === 'done');
      const doneCount = refs.filter((t) => t.status === 'done').length;
      return { text, done, refs: refs.length, doneCount };
    });
  }

  function goalHeader() {
    const p = project();
    const goal = S.data.goals[p.id];
    if (!goal) {
      return h(
        'section',
        { class: 'panel goal' },
        h('div', null, projectMeta(p), h('div', { class: 'eyebrow', text: 'No goal yet' }), h('p', { class: 'muted', text: 'Set one with /h1:goal in Claude Code, then approve it here.' }))
      );
    }
    const dod = dodState(p);
    const doneN = dod.filter((d) => d.done).length;
    return h(
      'section',
      { class: 'panel goal', 'aria-labelledby': 'goal-h' },
      h(
        'div',
        null,
        projectMeta(p),
        h(
          'div',
          { class: 'eyebrow' },
          h('span', { text: 'Goal' }),
          h('span', { class: 'chip mono', text: 'v' + goal.version }),
          goal.contact ? h('span', { text: 'context: ' + seatName(goal.contact) }) : null,
          h('span', { class: 'chip mono', text: (p.repos || []).map((r) => r.integrationBranch)[0] || 'hack/' + p.id })
        ),
        h('h1', { id: 'goal-h', class: 'statement', text: goal.statement }),
        h('details', { class: 'detail' }, h('summary', { text: 'Demo script' }), h('p', { text: goal.demoScript }), goal.nonGoals && goal.nonGoals.length ? h('p', { text: 'Not in scope: ' + goal.nonGoals.join(', ') }) : null)
      ),
      h(
        'div',
        null,
        h('div', { class: 'dod-head' }, h('h3', { text: 'Definition of done' }), h('span', { class: 'chip ' + (doneN === dod.length ? 'good' : 'strong'), text: doneN + ' of ' + dod.length })),
        h(
          'ul',
          { class: 'dod' },
          dod.map((d) =>
            h(
              'li',
              null,
              h('span', { class: 'tick' + (d.done ? ' on' : ''), 'aria-hidden': 'true' }, d.done ? icon('check') : null),
              h('span', { class: d.done ? 'done-text' : '' }, h('span', { class: 'sr', text: d.done ? 'Done: ' : 'Open: ' }), d.text),
              h('span', { class: 'chip mono', title: 'Tickets for this item', text: d.doneCount + '/' + d.refs })
            )
          )
        )
      )
    );
  }

  /* ---- tickets */

  function lastLogText(t) {
    const l = t.log && t.log.length ? t.log[t.log.length - 1] : null;
    return l ? l.text : '';
  }

  function openDeps(t) {
    return (t.deps || []).filter((d) => {
      const dt = S.data.tickets.find((x) => x.id === d);
      return !dt || dt.status !== 'done';
    });
  }

  function ticketCard(t, opts) {
    const owner = t.booking ? t.booking.seatId : null;
    const worker = t.booking && t.booking.workerId ? '/' + t.booking.workerId : '';
    return h(
      'button',
      {
        class: 'card' + (S.flash[t.id] ? ' flash' : ''),
        'aria-label': t.id + ' ' + t.title + ', ' + STATUS_LABEL[t.status],
        'data-focus-key': 'card-' + t.id,
        onclick: () => openDrawer(t.id),
      },
      h(
        'div',
        { class: 'top' },
        h('span', { class: 'tid', text: t.id }),
        h('span', { class: 'status st-' + t.status, text: STATUS_LABEL[t.status] })
      ),
      h('div', { class: 'title', text: t.title }),
      h(
        'div',
        { class: 'chips' },
        (t.lanes || []).map((l) => h('span', { class: 'chip', text: l })),
        t.type && t.type !== 'slice' ? h('span', { class: 'chip mono', text: t.type }) : null,
        t.attempts ? h('span', { class: 'chip warn', text: t.attempts + ' attempt' + (t.attempts > 1 ? 's' : '') }) : null,
        t.review ? h('span', { class: 'chip accent', text: 'review: ' + seatName(t.review.seatId) + (t.review.workerId ? '/' + t.review.workerId : '') }) : null
      ),
      opts && opts.reason && lastLogText(t) ? h('div', { class: 'reason', text: lastLogText(t) }) : null,
      t.prUrl || t.branch
        ? h('div', { class: 'branch' }, icon(t.prUrl ? 'pr' : 'branch'), h('span', { text: t.prUrl ? 'PR #' + (t.prUrl.split('/').pop() || '') : t.branch }))
        : null,
      h(
        'div',
        { class: 'foot' },
        owner
          ? h('span', { class: 'owner' }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(seatName(owner)) }), h('span', { text: seatName(owner) + worker }))
          : h('span', { text: openDeps(t).length ? 'waits for ' + openDeps(t).join(', ') : t.status === 'done' ? 'merged' : 'unassigned' }),
        h('span', { text: relTime(t.updatedAt) })
      )
    );
  }

  function blockedLane() {
    const p = project();
    const blocked = projectTickets(p.id).filter((t) => t.status === 'blocked');
    if (!blocked.length) return null;
    return h(
      'section',
      { class: 'panel blocked-lane', 'aria-labelledby': 'blocked-h' },
      h('div', { class: 'section-title' }, h('h2', { id: 'blocked-h' }, h('span', { class: 'status st-blocked', text: 'Blocked' })), h('span', { class: 'meta', text: blocked.length + ' ticket' + (blocked.length > 1 ? 's' : '') + ' waiting on an escalation' })),
      h('div', { class: 'lane-cards' }, blocked.map((t) => ticketCard(t, { reason: true })))
    );
  }

  function kanban() {
    const p = project();
    const ts = projectTickets(p.id);
    const cols = [
      ['planned', 'Planned', (t) => t.status === 'planned'],
      ['ready', 'Ready', (t) => t.status === 'ready'],
      ['in_progress', 'In progress', (t) => t.status === 'booked' || t.status === 'in_progress'],
      ['review', 'Review', (t) => t.status === 'review'],
      ['done', 'Done', (t) => t.status === 'done'],
    ];
    return h(
      'section',
      { 'aria-label': 'Tickets by status' },
      h(
        'div',
        { class: 'columns' },
        cols.map((c) => {
          let list = ts.filter(c[2]).sort((a, b) => (a.priority - b.priority) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
          if (c[0] === 'done') list = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          const shown = c[0] === 'done' ? list.slice(0, 6) : list;
          return h(
            'div',
            { class: 'column', role: 'region', 'aria-label': c[1] + ', ' + list.length + ' tickets' },
            h('div', { class: 'column-head' }, h('span', { class: 'status st-' + c[0], text: c[1] }), h('span', { class: 'count', text: String(list.length) })),
            h(
              'div',
              { class: 'column-body' },
              shown.length ? shown.map((t) => ticketCard(t)) : h('p', { class: 'column-empty', text: 'Nothing here' }),
              list.length > shown.length ? h('p', { class: 'more-done', text: '+' + (list.length - shown.length) + ' more done' }) : null
            )
          );
        })
      )
    );
  }

  /* ---- event log */

  function eventLog() {
    const streams = ['all', 'tasks', 'escalations', 'decisions', 'knowledge', 'broadcast', 'dm'];
    let list = S.data.events.slice().reverse();
    if (S.logFilter !== 'all') list = list.filter((e) => e.stream === S.logFilter);
    list = list.slice(0, 16);
    return h(
      'section',
      { class: 'panel log', 'aria-labelledby': 'log-h' },
      h(
        'div',
        { class: 'section-title' },
        h('h2', { id: 'log-h', text: 'Event log' }),
        h(
          'label',
          { class: 'field-inline' },
          h('span', { text: 'Stream' }),
          h(
            'select',
            {
              'data-focus-key': 'log-filter',
              onchange: (e) => {
                S.logFilter = e.target.value;
                render();
              },
            },
            streams.map((s) => h('option', { value: s, selected: S.logFilter === s, text: s === 'all' ? 'All streams' : s }))
          )
        )
      ),
      list.length
        ? h(
            'ol',
            { class: 'log-list', reversed: true },
            list.map((e) =>
              h(
                'li',
                { class: S.newSeqs[e.seq] ? 'new' : '' },
                h('span', { class: 't', text: clockTime(e.ts) }),
                h('span', { class: 'stream' }, h('span', { class: 'chip mono', text: e.stream })),
                h('span', { class: 's', title: e.summary, text: e.summary }),
                h('span', { class: 'from chip ' + (e.fromKind === 'human' ? 'human' : 'agent'), text: e.fromKind === 'system' ? 'system' : seatName(e.from) + ' · ' + e.fromKind })
              )
            )
          )
        : h('p', { class: 'empty', style: { marginTop: '8px' }, text: 'No events yet.' })
    );
  }

  /* ---- right rail */

  function humanItems() {
    const props = S.data.proposals.filter((p) => p.status === 'pending');
    const escs = S.data.escalations.filter((e) => {
      if (e.status === 'resolved' || e.status === 'defaulted') return false;
      const rule = S.data.rules.rows.find((r) => r.code === e.ruleCode);
      return e.status === 'resolved_pending_contest' || e.status === 'contested' || !rule || ['any_human', 'human_quorum', 'human_named'].indexOf(rule.resolver) >= 0;
    });
    const help = S.data.escalations.filter((e) => e.status === 'open' && e.kind === 'help');
    return { props, escs, help };
  }

  function rail() {
    const hi = humanItems();
    const count = hi.props.length + hi.escs.length;
    return h(
      'aside',
      { class: 'rail', 'aria-label': 'Actions and people' },
      h(
        'section',
        { class: 'panel rail-section', 'aria-labelledby': 'human-h' },
        h('h2', { id: 'human-h' }, icon('hand'), 'Needs a human', count ? h('span', { class: 'count-badge', text: String(count) }) : null),
        count ? null : h('p', { class: 'empty', text: 'Nothing waiting. Agents are working.' }),
        hi.props.map(proposalItem),
        hi.escs.map(escalationItem),
        hi.help.length
          ? h(
              'div',
              { class: 'detail help-list' },
              h('div', { class: 'sub muted', text: 'Help requests (agents first)' }),
              hi.help.map(helpItem)
            )
          : null
      ),
      votesSection(),
      peopleSection(),
      knowledgeSection()
    );
  }

  function proposalItem(p) {
    return h(
      'div',
      { class: 'item' },
      h(
        'div',
        { class: 'head' },
        h('span', { class: 'chip mono strong', text: p.id }),
        h('span', { class: 'chip accent', text: ACTION_LABEL[p.action] || p.action }),
        p.payload && p.payload.projectId ? h('span', { class: 'chip mono', text: p.payload.projectId }) : null
      ),
      h('div', { class: 'summary', text: p.summary }),
      h('div', { class: 'sub', text: 'Proposed by ' + seatName(p.proposedBy) + '’s agent · ' + relTime(p.createdAt) }),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary sm', 'data-focus-key': 'approve-' + p.id, onclick: () => openApprove(p.id) }, icon('check'), 'Approve'),
        h('button', { class: 'btn sm', 'data-focus-key': 'reject-' + p.id, onclick: () => doReject(p.id) }, icon('x'), 'Reject')
      )
    );
  }

  function escalationItem(e) {
    const rule = S.data.rules.rows.find((r) => r.code === e.ruleCode);
    const pending = e.status === 'resolved_pending_contest';
    return h(
      'div',
      { class: 'item' },
      h(
        'div',
        { class: 'head' },
        h('span', { class: 'chip mono strong', text: e.id }),
        h('span', { class: 'chip ' + (rule && rule.severity === 'P0' ? 'bad' : 'warn'), text: e.ruleCode + (rule ? ' ' + rule.name : '') }),
        h('span', { class: 'chip mono', text: e.projectId }),
        e.ticketId ? h('span', { class: 'chip mono', text: e.ticketId }) : null
      ),
      h('div', { class: 'summary', text: e.summary }),
      pending
        ? h(
            'div',
            { class: 'resolution' },
            h('div', null, h('strong', { text: seatName(e.resolution.by) + ': ' }), e.resolution.text),
            h('div', { style: { marginTop: '4px' } }, countdown(e.resolution.contestUntil, 'contest closes in '))
          )
        : e.status === 'contested'
        ? h('div', { class: 'resolution', text: 'Contested. A human vote decides.' })
        : h('div', { class: 'sub detail', text: e.detail }),
      h(
        'div',
        { class: 'actions' },
        pending
          ? h('button', { class: 'btn sm', 'data-focus-key': 'contest-' + e.id, onclick: () => openContest(e.id) }, icon('alert'), 'Contest')
          : e.status === 'open'
          ? h('button', { class: 'btn primary sm', 'data-focus-key': 'resolve-' + e.id, onclick: () => openResolve(e.id) }, icon('check'), 'Resolve')
          : null,
        h('span', { class: 'sub', text: 'raised by ' + seatName(e.raisedBy) + ' · ' + relTime(e.createdAt) })
      )
    );
  }

  function helpItem(e) {
    return h(
      'div',
      { class: 'item' },
      h('div', { class: 'head' }, h('span', { class: 'chip mono strong', text: e.id }), h('span', { class: 'chip warn', text: e.ruleCode + ' help' }), e.ticketId ? h('span', { class: 'chip mono', text: e.ticketId }) : null),
      h('div', { class: 'summary', text: e.summary }),
      e.deadline ? h('div', null, countdown(e.deadline, 'goes to humans in ')) : null
    );
  }

  function votesSection() {
    const open = S.data.decisions.filter((d) => d.status === 'open');
    const me = S.data.me;
    return h(
      'section',
      { class: 'panel rail-section', 'aria-labelledby': 'votes-h' },
      h('h2', { id: 'votes-h' }, icon('vote'), 'Votes'),
      open.length ? null : h('p', { class: 'empty', text: 'No open votes.' }),
      open.map((d) => {
        const counts = {};
        d.options.forEach((o) => (counts[o] = 0));
        d.votes.forEach((v) => (counts[v.option] = (counts[v.option] || 0) + 1));
        const eligible = me && (d.eligible || []).indexOf(me.id) >= 0;
        const myVote = me && d.votes.find((v) => v.seat === me.id);
        return h(
          'div',
          { class: 'item' },
          h('div', { class: 'head' }, h('span', { class: 'chip mono strong', text: d.id }), d.projectId ? h('span', { class: 'chip mono', text: d.projectId }) : null, countdown(d.deadline)),
          h('div', { class: 'summary', text: d.question }),
          h(
            'div',
            { class: 'tally' },
            d.options.map((o) =>
              h(
                'div',
                { class: 'tally-row' },
                h('span', { text: o + (o === d.defaultOption ? ' (default)' : '') }),
                h('span', { class: 'mono', text: counts[o] + '/' + (d.eligible || []).length }),
                h('span', { class: 'tally-bar', 'aria-hidden': 'true' }, h('span', { style: { width: ((counts[o] / Math.max(1, (d.eligible || []).length)) * 100) + '%' } }))
              )
            )
          ),
          h(
            'div',
            { class: 'votes detail' },
            d.votes.map((v) =>
              h(
                'div',
                { class: 'vote' },
                h('span', { class: 'avatar', title: seatName(v.seat), text: initials(seatName(v.seat)) }),
                h('span', { class: 'chip ' + v.by, text: v.option + ' · ' + v.by }),
                h('span', { class: 'why', title: v.why, text: v.why })
              )
            )
          ),
          eligible
            ? h(
                'div',
                { class: 'actions' },
                d.options.map((o) =>
                  h(
                    'button',
                    {
                      class: 'btn sm' + (myVote && myVote.option === o && myVote.by === 'human' ? ' primary' : ''),
                      'data-focus-key': 'vote-' + d.id + '-' + o,
                      onclick: () => openVote(d.id, o),
                    },
                    'Vote ' + o
                  )
                ),
                myVote && myVote.by === 'agent' ? h('span', { class: 'sub', text: 'Your agent voted ' + myVote.option + '. A vote here overrides it.' }) : null
              )
            : h('div', { class: 'sub', text: 'Electorate: ' + (d.eligible || []).map(seatName).join(', ') })
        );
      })
    );
  }

  function peopleSection() {
    return h(
      'section',
      { class: 'panel rail-section', 'aria-labelledby': 'people-h' },
      h('h2', { id: 'people-h' }, icon('users'), 'People'),
      h(
        'div',
        null,
        S.data.seats.map((s) => {
          const sessions = s.sessions || [];
          const working = sessions.filter((x) => x.state === 'working').length;
          const needs = sessions.filter((x) => x.state === 'needs_input').length;
          const pct = s.usage && typeof s.usage.sevenDayPct === 'number' ? s.usage.sevenDayPct : null;
          return h(
            'div',
            { class: 'person' },
            h('span', { class: 'avatar lg', 'aria-hidden': 'true', text: initials(s.name) }),
            h(
              'div',
              { style: { minWidth: '0' } },
              h('div', { class: 'name' }, s.name, h('span', { class: 'chip', text: WORK_MODE[s.workMode] || s.workMode }), needs ? h('span', { class: 'needs-input' }, icon('alert'), 'needs input') : null),
              h(
                'div',
                { class: 'meta' },
                h('span', { text: (s.projects || [])[0] ? (s.pinned ? 'pinned: ' : '') + (s.projects || [])[0] : 'no project' }),
                h('span', { class: 'detail', text: working + ' working · ' + sessions.length + ' session' + (sessions.length === 1 ? '' : 's') }),
                h('span', { text: s.autopilot ? 'autopilot on' : 'autopilot off' })
              )
            ),
            pct !== null
              ? h(
                  'div',
                  { class: 'usage', title: 'Weekly usage' },
                  h('span', { text: pct + '% wk' }),
                  h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { class: pct >= 80 ? 'high' : '', style: { width: Math.min(100, pct) + '%' } }))
                )
              : h('span')
          );
        })
      )
    );
  }

  function knowledgeSection() {
    const kinds = { skill: ['layers', 'Skill'], tip: ['bulb', 'Tip'], playbook: ['doc', 'Playbook'] };
    const items = S.data.knowledge.filter((k) => k.status === 'active').slice(0, 6);
    return h(
      'section',
      { class: 'panel rail-section detail', 'aria-labelledby': 'kn-h' },
      h('h2', { id: 'kn-h' }, icon('book'), 'Knowledge'),
      items.length ? null : h('p', { class: 'empty', text: 'Nothing shared yet.' }),
      h(
        'div',
        null,
        items.map((k) =>
          h(
            'div',
            { class: 'kn' },
            h('span', { class: 'kind-icon' }, icon((kinds[k.kind] || kinds.tip)[0], (kinds[k.kind] || kinds.tip)[1])),
            h(
              'div',
              { style: { minWidth: '0' } },
              h('div', { class: 'name' }, k.kind === 'skill' ? h('span', { class: 'mono', text: k.name }) : h('span', { text: k.name }), k.kind === 'skill' ? h('span', { class: 'chip mono', text: 'v' + k.version }) : h('span', { class: 'chip', text: (kinds[k.kind] || kinds.tip)[1] })),
              h('div', { class: 'body', text: k.body || '' }),
              h('div', { class: 'sub muted', style: { fontSize: '0.8rem' }, text: seatName(k.author) + ' · ' + relTime(k.createdAt) + (k.scope === 'global' ? ' · all projects' : '') })
            )
          )
        )
      )
    );
  }

  /* ---- rules tab */

  function rulesTab() {
    const rows = S.data.rules.rows;
    const resolvers = Object.keys(RESOLVER_LABEL);
    const scopes = ['none', 'ticket', 'dependents', 'all'];
    return h(
      'section',
      { class: 'panel', style: { padding: '16px' }, 'data-keep-focus': true },
      h(
        'div',
        { class: 'section-title' },
        h('h2', { text: 'Blocker rules' }),
        h('span', { class: 'meta' }, h('span', { class: 'chip mono strong', text: 'v' + S.data.rules.version }), ' · edits apply to every agent on its next decision')
      ),
      h('p', { class: 'muted', style: { margin: '6px 0 12px', maxWidth: '80ch' }, text: 'Agents check this table before asking anyone. A problem that matches no row is decided by the agent and logged. Any human can change a row; the change is broadcast to every session.' }),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, ['Code', 'Name', 'Trigger', 'Sev', 'Resolver', 'Timeout → default', 'Contest', 'Stops', 'Max tries', ''].map((c) => h('th', { scope: 'col', text: c })))),
          h(
            'tbody',
            null,
            rows.map((r) => {
              if (S.editingRule === r.code) {
                return h(
                  'tr',
                  { class: 'editing' },
                  h('td', null, h('span', { class: 'mono', text: r.code })),
                  h('td', null, h('input', { id: 'rule-name', 'aria-label': 'Name', value: r.name })),
                  h('td', null, h('textarea', { id: 'rule-trigger', 'aria-label': 'Trigger', text: r.trigger })),
                  h('td', null, h('select', { id: 'rule-sev', 'aria-label': 'Severity' }, ['P0', 'P1', 'P2', 'P3'].map((s) => h('option', { value: s, selected: r.severity === s, text: s })))),
                  h('td', null, h('select', { id: 'rule-resolver', 'aria-label': 'Resolver' }, resolvers.map((s) => h('option', { value: s, selected: r.resolver === s, text: RESOLVER_LABEL[s] })))),
                  h(
                    'td',
                    null,
                    h('input', { id: 'rule-timeout', type: 'number', min: '0', 'aria-label': 'Timeout minutes', value: r.timeoutMin == null ? '' : String(r.timeoutMin), placeholder: 'none' }),
                    h('textarea', { id: 'rule-default', 'aria-label': 'Default on timeout', style: { marginTop: '6px' }, text: r.defaultOnTimeout })
                  ),
                  h('td', null, h('input', { id: 'rule-contest', type: 'number', min: '0', 'aria-label': 'Contest minutes', value: r.contestMin == null ? '' : String(r.contestMin), placeholder: 'none' })),
                  h('td', null, h('select', { id: 'rule-scope', 'aria-label': 'Stop scope' }, scopes.map((s) => h('option', { value: s, selected: r.stopScope === s, text: s })))),
                  h('td', null, h('input', { id: 'rule-max', type: 'number', min: '0', 'aria-label': 'Max attempts', value: r.maxAttempts == null ? '' : String(r.maxAttempts), placeholder: '—' })),
                  h(
                    'td',
                    null,
                    h(
                      'div',
                      { style: { display: 'grid', gap: '6px' } },
                      h('button', { class: 'btn primary sm', onclick: () => saveRule(r.code) }, 'Save'),
                      h(
                        'button',
                        {
                          class: 'btn sm',
                          onclick: () => {
                            S.editingRule = null;
                            if (document.activeElement) document.activeElement.blur();
                            render();
                          },
                        },
                        'Cancel'
                      )
                    )
                  )
                );
              }
              return h(
                'tr',
                null,
                h('td', null, h('span', { class: 'mono', style: { fontWeight: '600' }, text: r.code })),
                h('td', null, h('strong', { text: r.name })),
                h('td', { class: 'muted', style: { maxWidth: '320px' }, text: r.trigger }),
                h('td', null, h('span', { class: 'sev sev-' + r.severity, text: r.severity })),
                h('td', null, RESOLVER_LABEL[r.resolver] || r.resolver, r.resolverNote ? h('div', { class: 'muted', style: { fontSize: '0.82rem' }, text: r.resolverNote }) : null),
                h('td', null, h('span', { class: 'mono', text: r.timeoutMin != null ? r.timeoutMin + ' min' : 'no timeout' }), h('div', { class: 'muted', style: { fontSize: '0.85rem' }, text: '→ ' + r.defaultOnTimeout })),
                h('td', { class: 'mono', text: r.contestMin != null ? r.contestMin + ' min' : '—' }),
                h('td', { text: r.stopScope }),
                h('td', { class: 'mono', text: r.maxAttempts != null ? String(r.maxAttempts) : '—' }),
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      class: 'btn sm',
                      'aria-label': 'Edit rule ' + r.code,
                      'data-focus-key': 'edit-' + r.code,
                      onclick: () => {
                        S.editingRule = r.code;
                        render();
                        const el = document.getElementById('rule-name');
                        if (el) el.focus();
                      },
                    },
                    'Edit'
                  )
                )
              );
            })
          )
        )
      )
    );
  }

  function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function saveRule(code) {
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : '';
    };
    const patch = {
      name: val('rule-name').trim(),
      trigger: val('rule-trigger').trim(),
      severity: val('rule-sev'),
      resolver: val('rule-resolver'),
      timeoutMin: numOrNull(val('rule-timeout')),
      defaultOnTimeout: val('rule-default').trim(),
      contestMin: numOrNull(val('rule-contest')),
      stopScope: val('rule-scope'),
      maxAttempts: numOrNull(val('rule-max')),
    };
    if (!patch.name || !patch.trigger || !patch.defaultOnTimeout) {
      toast('Name, trigger and default are required.', 'error');
      return;
    }
    if (document.activeElement) document.activeElement.blur();
    try {
      if (S.mode === 'demo') {
        const r = S.data.rules.rows.find((x) => x.code === code);
        Object.assign(r, patch);
        r.version += 1;
        S.data.rules.version += 1;
        demoEvent('broadcast', 'rules.updated', 'human', 'Rules v' + S.data.rules.version + ': ' + code + ' changed by ' + S.data.me.name);
      } else {
        await H1.Api.action('rules.set', { code, patch });
        await refreshRules();
      }
      S.editingRule = null;
      toast('Rule ' + code + ' saved. Every agent gets the new version.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ---- tokens tab */

  function tokensTab() {
    const jc = S.joinCode;
    const cmd = 'h1 join --code ' + (jc ? jc.code : 'XXXX-XXXX') + ' --api ' + location.origin;
    return h(
      'div',
      { class: 'split' },
      h(
        'section',
        { class: 'panel connect', 'aria-labelledby': 'connect-h' },
        h('h2', { id: 'connect-h', text: 'Connect a Mac' }),
        h('p', { class: 'muted', text: 'A join code links one Mac to your seat. It works once and expires after 10 minutes. The Mac stores its agent token in the Keychain.' }),
        jc
          ? h('div', { class: 'join-code', 'aria-label': 'Join code ' + jc.code.split('').join(' '), text: jc.code })
          : null,
        jc ? h('div', null, countdown(jc.expiresAt, 'expires in ')) : null,
        h(
          'div',
          { class: 'cmd' },
          h('code', { text: cmd }),
          h('button', { class: 'btn sm', 'aria-label': 'Copy the join command', disabled: !jc, onclick: () => copyText(cmd) }, icon('copy'), 'Copy')
        ),
        h(
          'ol',
          { class: 'steps' },
          h('li', { text: 'On the Mac, open Claude Code in the hackathon repo.' }),
          h('li', { text: 'Run /h1:join and paste the code, or run the command above.' }),
          h('li', { text: 'The Mac appears in the list on the right.' })
        ),
        h('div', null, h('button', { class: 'btn primary', 'data-focus-key': 'new-code', onclick: createJoinCode }, icon('plus'), jc ? 'New code' : 'Create join code'))
      ),
      h(
        'section',
        { class: 'panel', style: { padding: '16px' }, 'aria-labelledby': 'tokens-h' },
        h('div', { class: 'section-title' }, h('h2', { id: 'tokens-h', text: 'Your Macs and workers' }), h('span', { class: 'meta', text: 'Revoke a token and that Mac or worker stops at its next call' })),
        h(
          'div',
          { class: 'table-wrap', style: { marginTop: '8px' } },
          h(
            'table',
            { class: 'data' },
            h('thead', null, h('tr', null, ['Name', 'Kind', 'Created', 'Last used', 'Expires', ''].map((c) => h('th', { scope: 'col', text: c })))),
            h(
              'tbody',
              null,
              S.data.tokens.length
                ? S.data.tokens.map((t) =>
                    h(
                      'tr',
                      null,
                      h('td', null, h('strong', { text: t.label || t.machine || t.tokenId }), h('div', { class: 'mono muted', style: { fontSize: '0.8rem' }, text: t.tokenId })),
                      h('td', null, h('span', { class: 'chip', text: t.kind === 'worker' ? 'worker ' + (t.workerId || '') : 'agent' })),
                      h('td', { text: relTime(t.createdAt) }),
                      h('td', { text: t.lastUsedAt ? relTime(t.lastUsedAt) : 'never' }),
                      h('td', { text: t.expiresAt ? new Date(t.expiresAt).toLocaleString() : '—' }),
                      h('td', null, h('button', { class: 'btn sm danger', 'aria-label': 'Revoke ' + (t.label || t.machine || t.tokenId), onclick: () => revokeToken(t.tokenId) }, 'Revoke'))
                    )
                  )
                : h('tr', null, h('td', { colspan: '6', class: 'muted', text: 'No Macs connected yet.' }))
            )
          )
        )
      )
    );
  }

  async function createJoinCode() {
    try {
      if (S.mode === 'demo') {
        const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const pick = () => a[Math.floor(Math.random() * a.length)];
        let code = '';
        for (let i = 0; i < 8; i++) code += (i === 4 ? '-' : '') + pick();
        S.joinCode = { code, expiresAt: Date.now() + 10 * 60 * 1000 };
      } else {
        S.joinCode = await H1.Api.joinCode();
      }
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function revokeToken(tokenId) {
    try {
      if (S.mode === 'demo') S.data.tokens = S.data.tokens.filter((t) => t.tokenId !== tokenId);
      else {
        await H1.Api.revokeToken(tokenId);
        await refreshTokens();
      }
      toast('Token revoked.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ---- settings tab */

  function releaseBanner() {
    const r = S.releaseBanner;
    if (!r) return null;
    return h(
      'div',
      { class: 'release-banner', role: 'status' },
      h('strong', { text: 'HackathonOne ' + r.version + ' released' }),
      h('span', { text: r.notes || '' }),
      h('span', { class: 'muted', text: r.minimum ? 'Agents must run /h1:update before their next change.' : 'Agents: run /h1:update, then /reload-plugins.' }),
      h('button', { class: 'btn sm primary', onclick: () => location.reload() }, 'Reload the board'),
      h('button', { class: 'btn sm', 'aria-label': 'Dismiss', onclick: () => ((S.releaseBanner = null), render()) }, 'Dismiss')
    );
  }

  function releaseSection() {
    const r = S.data.release;
    return h(
      'section',
      { style: { display: 'grid', gap: '10px' }, 'aria-labelledby': 'release-h' },
      h('div', { class: 'section-title' }, h('h2', { id: 'release-h', text: 'HackathonOne releases' }), h('span', { class: 'meta', text: 'Announces a new plugin version to every connected Mac' })),
      h(
        'p',
        { class: r ? '' : 'muted', id: 'release-current' },
        r ? 'Latest ' + r.latest + (r.minimum ? ' · minimum ' + r.minimum : '') + ' · published by ' + seatName(r.by) + ' ' + relTime(r.publishedAt) + ': ' + r.notes : 'No release published yet.'
      ),
      h(
        'p',
        { class: 'muted', text: 'Bump plugin/.claude-plugin/plugin.json and merge it into the HackathonOne repo first: Claude Code only ships a plugin whose version changed. A minimum version stops older Macs from changing anything until they update.' }
      ),
      h(
        'form',
        {
          class: 'form-grid',
          onsubmit: (e) => {
            e.preventDefault();
            publishRelease();
          },
        },
        field('rel-version', 'Version', 'For example 0.3.1; must be newer than the latest.', h('input', { id: 'rel-version', placeholder: '0.3.1', pattern: '\\d+\\.\\d+\\.\\d+' })),
        field('rel-min', 'Minimum version', 'Optional. Set it only for changes older Macs must not miss.', h('input', { id: 'rel-min', placeholder: 'none' })),
        field('rel-notes', 'What changed', 'One or two lines; shown on every Mac.', h('input', { id: 'rel-notes', maxlength: '500' })),
        h('div', { style: { alignSelf: 'end' } }, h('button', { class: 'btn primary', type: 'submit' }, 'Publish release'))
      )
    );
  }

  async function publishRelease() {
    const val = (id) => document.getElementById(id).value.trim();
    const payload = { version: val('rel-version'), notes: val('rel-notes') };
    if (val('rel-min')) payload.minimum = val('rel-min');
    if (!/^\d+\.\d+\.\d+$/.test(payload.version) || !payload.notes) {
      toast('Give a version like 0.3.1 and a short note.', 'error');
      return;
    }
    try {
      if (S.mode === 'demo') {
        S.data.release = { latest: payload.version, minimum: payload.minimum, notes: payload.notes, publishedAt: Date.now(), by: S.data.me.id };
        demoEvent('broadcast', 'tool.released', 'human', 'HackathonOne ' + payload.version + ' released: ' + payload.notes);
      } else {
        S.data.release = await H1.Api.action('release.publish', payload).then((r) => r.result || r);
      }
      toast('Release ' + payload.version + ' published.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function settingsTab() {
    const st = S.data.settings || {};
    return h(
      'section',
      { class: 'panel', style: { padding: '18px', display: 'grid', gap: '16px', maxWidth: '980px' }, 'data-keep-focus': true },
      h('div', { class: 'section-title' }, h('h2', { text: 'Hub settings' }), h('span', { class: 'meta', text: 'Any human can change these; every change is in the event log' })),
      h(
        'form',
        {
          class: 'form-grid',
          onsubmit: (e) => {
            e.preventDefault();
            saveSettings();
          },
        },
        field('set-lease', 'Lease length (seconds)', 'How long a booking survives without a heartbeat.', h('input', { id: 'set-lease', type: 'number', min: '120', value: String(st.leaseTtlSec || 900) })),
        field('set-max', 'Max bookings per seat', 'Empty means no cap. Switch on if one seat starts starving the others.', h('input', { id: 'set-max', type: 'number', min: '1', value: st.maxBookingsPerSeat == null ? '' : String(st.maxBookingsPerSeat), placeholder: 'No cap' })),
        field('set-contest', 'Default contest window (minutes)', 'Used when a rule row sets no contest window.', h('input', { id: 'set-contest', type: 'number', min: '0', value: String(st.defaultContestMin == null ? 10 : st.defaultContestMin) })),
        field('set-tool-repo', 'HackathonOne repo (git URL)', 'Where fixes to HackathonOne itself go. /h1:bug files them into the "HackathonOne fixes" project.', h('input', { id: 'set-tool-repo', value: st.toolRepoUrl || '', placeholder: 'git@github.com:org/hakatonOne.git' })),
        h('div', { style: { alignSelf: 'end' } }, h('button', { class: 'btn primary', type: 'submit' }, 'Save settings'))
      ),
      releaseSection(),
      h(
        'div',
        { class: 'callout' },
        h('strong', { text: 'Where the data lives' }),
        h('span', { class: 'muted', text: 'Everything is stored in the hackathon AWS sandbox and deleted automatically after the event. The hub never sees Claude credentials.' })
      )
    );
  }

  function field(id, label, hint, input) {
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, h('span', { class: 'hint', text: hint }));
  }

  async function saveSettings() {
    const val = (id) => document.getElementById(id).value;
    const payload = { leaseTtlSec: numOrNull(val('set-lease')) || 900, maxBookingsPerSeat: numOrNull(val('set-max')), defaultContestMin: numOrNull(val('set-contest')), toolRepoUrl: val('set-tool-repo').trim() || null };
    if (document.activeElement) document.activeElement.blur();
    try {
      if (S.mode === 'demo') {
        S.data.settings = Object.assign({}, S.data.settings, payload);
        demoEvent('broadcast', 'settings.updated', 'human', 'Hub settings changed by ' + S.data.me.name);
      } else {
        const r = await H1.Api.action('settings.set', payload);
        S.data.settings = (r && r.result) || Object.assign({}, S.data.settings, payload);
      }
      toast('Settings saved.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- projects & repos (CONTRACT §13) */

  // Same values as plugin/templates/repo-presets.json
  const REPO_PRESETS = {
    "nx-monorepo": {
      "label": "Nx monorepo",
      "baseBranch": "main",
      "hotPaths": [
        "package.json",
        "package-lock.json",
        "nx.json",
        "**/project.json",
        "tsconfig.base.json",
        ".github/**",
        "**/serverless*.yml"
      ],
      "contractPaths": [
        "libs/shared/**"
      ],
      "setup": [
        "npm ci"
      ],
      "verify": [
        {
          "name": "typecheck",
          "cmd": "npm run type:check"
        },
        {
          "name": "lint",
          "cmd": "npx nx affected -t lint"
        },
        {
          "name": "unit",
          "cmd": "npx nx affected -t unit"
        }
      ],
      "instructionsPath": "CLAUDE.md",
      "laneMap": [
        {
          "glob": "apps/mobile/**",
          "lane": "mobile"
        },
        {
          "glob": "apps/web/**",
          "lane": "web"
        },
        {
          "glob": "services/**",
          "lane": "api"
        },
        {
          "glob": "libs/shared/**",
          "lane": "contract"
        },
        {
          "glob": "e2e-tests/**",
          "lane": "e2e"
        }
      ],
      "prLabels": [
        "hackathon"
      ],
      "notes": "Never run builds (npm run build, nx build, affected:build): use type:check and unit tests. Contracts in libs/shared are owned by contract tickets only."
    },
    "node-app": {
      "label": "Node app",
      "baseBranch": "main",
      "hotPaths": [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        ".github/**"
      ],
      "contractPaths": [
        "src/contracts/**",
        "src/types/shared/**"
      ],
      "setup": [
        "npm ci"
      ],
      "verify": [
        {
          "name": "typecheck",
          "cmd": "npx tsc --noEmit"
        },
        {
          "name": "lint",
          "cmd": "npm run lint --if-present"
        },
        {
          "name": "test",
          "cmd": "npm test"
        }
      ],
      "instructionsPath": "CLAUDE.md",
      "laneMap": [],
      "prLabels": [
        "hackathon"
      ],
      "notes": ""
    },
    "expo-app": {
      "label": "Expo / React Native app",
      "baseBranch": "main",
      "hotPaths": [
        "package.json",
        "package-lock.json",
        "app.json",
        "app.config.ts",
        "app.config.js",
        "eas.json",
        "babel.config.js",
        "metro.config.js",
        ".github/**"
      ],
      "contractPaths": [
        "src/api/types/**"
      ],
      "setup": [
        "npm ci"
      ],
      "verify": [
        {
          "name": "typecheck",
          "cmd": "npx tsc --noEmit"
        },
        {
          "name": "lint",
          "cmd": "npx expo lint"
        },
        {
          "name": "test",
          "cmd": "npm test -- --watchAll=false"
        }
      ],
      "instructionsPath": "CLAUDE.md",
      "laneMap": [
        {
          "glob": "**",
          "lane": "mobile"
        }
      ],
      "prLabels": [
        "hackathon",
        "mobile"
      ],
      "notes": "Run the app on the iOS Simulator with npx expo run:ios; check shared h1-- skills for the team's working recipe first."
    }
  };

  const LIMITS = { desc: 2000, links: 20, tags: 20, repos: 10, hot: 50, contract: 50, glob: 200, setup: 10, verify: 10, cmd: 500, laneMap: 30, prLabels: 10, notes: 2000 };

  function repoWithDefaults(r, pid) {
    r = r || {};
    return {
      name: r.name || '',
      url: r.url || '',
      baseBranch: r.baseBranch || 'main',
      integrationBranch: r.integrationBranch || 'hack/' + pid,
      hotPaths: r.hotPaths || [],
      contractPaths: r.contractPaths || [],
      setup: r.setup || [],
      verify: r.verify || [],
      instructionsPath: r.instructionsPath || '',
      laneMap: r.laneMap || [],
      prLabels: r.prLabels || [],
      notes: r.notes || '',
    };
  }

  function projectRepos(p) {
    return (p && p.repos ? p.repos : []).map((r) => repoWithDefaults(r, p.id));
  }

  function isHttps(u) {
    return /^https:\/\/[^\s]+$/i.test(u || '');
  }

  /* goal header: description + links + settings */
  function projectMeta(p) {
    const links = (p.links || []).filter((l) => isHttps(l.url));
    return h(
      'div',
      { class: 'project-meta' },
      h(
        'div',
        { class: 'pm-row' },
        h('span', { class: 'pm-name', text: p.name }),
        (p.tags || []).map((t) => h('span', { class: 'chip', text: t })),
        h('div', { class: 'spacer' }),
        h(
          'button',
          { class: 'btn sm', 'data-focus-key': 'project-settings', 'aria-label': 'Project settings for ' + p.name, onclick: () => openProjectEditor(p) },
          icon('sliders'),
          h('span', { text: 'Project settings' })
        )
      ),
      p.description ? h('p', { class: 'pm-desc', text: p.description }) : null,
      links.length || (p.demo && (p.demo.url || p.demo.stage))
        ? h(
            'div',
            { class: 'pm-links' },
            links.map((l) => h('a', { class: 'chip link', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), ' ', l.label)),
            p.demo && p.demo.url ? h('a', { class: 'chip link accent', href: p.demo.url, target: '_blank', rel: 'noopener noreferrer' }, icon('play'), ' Demo') : null,
            p.demo && p.demo.stage ? h('span', { class: 'chip mono', title: 'Demo stage', text: 'stage ' + p.demo.stage }) : null
          )
        : null
    );
  }

  /* compact repos panel on the board */
  function pathList(title, items, cls) {
    if (!items.length) return h('span', { class: 'chip ' + (cls || ''), text: '0 ' + title });
    return h(
      'details',
      { class: 'repo-paths' },
      h('summary', null, h('span', { class: 'chip ' + (cls || ''), text: items.length + ' ' + title })),
      h('div', { class: 'paths' }, items.map((x) => h('span', { class: 'chip mono', text: x })))
    );
  }

  function repoTile(r) {
    return h(
      'article',
      { class: 'repo-tile' },
      h(
        'div',
        { class: 'repo-head' },
        h('span', { class: 'repo-name' }, icon('branch'), ' ', r.name),
        h('span', { class: 'mono muted branches', title: 'Base branch → integration branch' }, r.baseBranch, ' → ', h('span', { class: 'accent-text', text: r.integrationBranch }))
      ),
      h('div', { class: 'repo-url mono muted', title: r.url, text: r.url }),
      h('div', { class: 'stats' }, pathList('protected', r.hotPaths, 'warn'), pathList('contract', r.contractPaths, 'accent')),
      r.verify.length ? h('ul', { class: 'verify' }, r.verify.map((v) => h('li', null, h('span', { class: 'v-name', text: v.name }), h('code', { text: v.cmd })))) : h('p', { class: 'muted', text: 'No verify commands yet.' }),
      r.notes ? h('p', { class: 'repo-notes', text: r.notes }) : null
    );
  }

  function reposPanel() {
    const p = project();
    const repos = projectRepos(p);
    return h(
      'section',
      { class: 'panel repos-panel', 'aria-labelledby': 'repos-h' },
      h(
        'div',
        { class: 'section-title' },
        h('h2', { id: 'repos-h', text: 'Repos' }),
        h('span', { class: 'meta', text: repos.length + (repos.length === 1 ? ' repo' : ' repos') + ' · agents read these before working' })
      ),
      repos.length ? h('div', { class: 'repo-grid' }, repos.map(repoTile)) : h('p', { class: 'muted', text: 'No repos yet. Add one in Project settings.' })
    );
  }

  /* ticket drawer: the ticket's repo */
  function drawerRepoSection(t, p) {
    const r = projectRepos(p).find((x) => x.name === t.repo);
    if (!r) return h('section', null, h('h3', { text: 'Repo' }), h('p', { class: 'muted', text: 'Repo ' + (t.repo || '—') + ' is not described on this project yet.' }));
    return h(
      'section',
      null,
      h('h3', { text: 'Repo: ' + r.name }),
      h(
        'dl',
        { class: 'kv' },
        h('dt', { text: 'Branches' }),
        h('dd', { class: 'mono', text: r.baseBranch + ' → ' + r.integrationBranch }),
        h('dt', { text: 'Remote' }),
        h('dd', { class: 'mono', text: r.url }),
        r.instructionsPath ? h('dt', { text: 'Instructions' }) : null,
        r.instructionsPath ? h('dd', { class: 'mono', text: r.instructionsPath }) : null,
        r.setup.length ? h('dt', { text: 'Setup' }) : null,
        r.setup.length ? h('dd', null, r.setup.map((c) => h('code', { class: 'block', text: c }))) : null
      ),
      r.verify.length ? h('ul', { class: 'acc', style: { marginTop: '8px' } }, r.verify.map((v) => h('li', null, h('span', { text: 'Verify: ' + v.name }), h('code', { text: v.cmd })))) : null,
      r.notes ? h('div', { class: 'callout', style: { marginTop: '8px' } }, h('strong', { text: 'Notes for agents' }), h('span', { text: r.notes })) : null
    );
  }

  /* ---- project editor (new project + project settings) */

  function slugify(x) {
    return String(x || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ł/g, 'l')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  const lines = (txt) =>
    String(txt || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
  const commaList = (txt) =>
    String(txt || '')
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);

  function repoDraft(r, pid, open) {
    const d = repoWithDefaults(r, pid);
    return {
      name: d.name,
      url: d.url,
      baseBranch: d.baseBranch,
      integrationBranch: d.integrationBranch,
      integrationTouched: !!(r && r.integrationBranch && r.integrationBranch !== 'hack/' + pid),
      preset: '',
      hotPaths: d.hotPaths.join('\n'),
      contractPaths: d.contractPaths.join('\n'),
      setup: d.setup.join('\n'),
      verify: d.verify.map((v) => ({ name: v.name, cmd: v.cmd })),
      instructionsPath: d.instructionsPath,
      laneMap: d.laneMap.map((m) => ({ glob: m.glob, lane: m.lane })),
      prLabels: d.prLabels.join(', '),
      notes: d.notes,
      open: !!open,
    };
  }

  function projectDraft(p) {
    if (!p) {
      return { isNew: true, id: '', idTouched: false, name: '', description: '', tags: '', lanes: '', links: [], demo: { url: '', stage: '', notes: '' }, repos: [repoDraft(null, '<id>', true)] };
    }
    return {
      isNew: false,
      id: p.id,
      idTouched: true,
      name: p.name || '',
      description: p.description || '',
      tags: (p.tags || []).join(', '),
      lanes: (p.lanes || []).join(', '),
      links: (p.links || []).map((l) => ({ label: l.label, url: l.url })),
      demo: { url: (p.demo && p.demo.url) || '', stage: (p.demo && p.demo.stage) || '', notes: (p.demo && p.demo.notes) || '' },
      repos: projectRepos(p).map((r, i) => repoDraft(r, p.id, i === 0)),
    };
  }

  function validateDraft(d) {
    const errs = [];
    const pid = d.id;
    if (!d.name.trim()) errs.push('Project name is required.');
    if (d.name.length > 80) errs.push('Project name is longer than 80 characters.');
    if (!/^[a-z0-9-]{2,40}$/.test(pid)) errs.push('Project id must be 2–40 characters: lowercase letters, digits and dashes.');
    if (d.isNew && S.data.projects.some((p) => p.id === pid)) errs.push('A project with id ' + pid + ' already exists.');
    if (d.description.length > LIMITS.desc) errs.push('Description is longer than ' + LIMITS.desc + ' characters.');
    if (commaList(d.tags).length > LIMITS.tags) errs.push('At most ' + LIMITS.tags + ' tags.');
    const links = d.links.filter((l) => l.label.trim() || l.url.trim());
    if (links.length > LIMITS.links) errs.push('At most ' + LIMITS.links + ' links.');
    links.forEach((l, i) => {
      if (!l.label.trim()) errs.push('Link ' + (i + 1) + ' needs a label.');
      if (!isHttps(l.url.trim())) errs.push('Link "' + (l.label || i + 1) + '" must be an https:// URL.');
    });
    if (d.demo.url.trim() && !isHttps(d.demo.url.trim())) errs.push('Demo URL must be an https:// URL.');
    if (!d.repos.length) errs.push('Add at least one repo.');
    if (d.repos.length > LIMITS.repos) errs.push('At most ' + LIMITS.repos + ' repos.');
    const seen = {};
    d.repos.forEach((r, i) => {
      const label = 'Repo ' + (r.name || i + 1);
      if (!/^[A-Za-z0-9._-]{1,60}$/.test(r.name)) errs.push(label + ': name must be 1–60 characters (letters, digits, . _ -).');
      else if (seen[r.name]) errs.push(label + ': repo names must be unique in a project.');
      seen[r.name] = true;
      if (!r.url.trim()) errs.push(label + ': git URL is required.');
      if (r.url.length > 300) errs.push(label + ': git URL is longer than 300 characters.');
      if (!r.baseBranch.trim()) errs.push(label + ': base branch is required.');
      if (!/^[A-Za-z0-9._/-]{1,120}$/.test(r.integrationBranch.trim())) errs.push(label + ': integration branch must be a valid branch name (letters, digits, . _ / -).');
      if (!/^[A-Za-z0-9._/-]{1,120}$/.test(r.baseBranch.trim())) errs.push(label + ': base branch must be a valid branch name.');
      const hot = lines(r.hotPaths);
      const contract = lines(r.contractPaths);
      if (hot.length > LIMITS.hot) errs.push(label + ': at most ' + LIMITS.hot + ' protected paths.');
      if (contract.length > LIMITS.contract) errs.push(label + ': at most ' + LIMITS.contract + ' contract paths.');
      hot.concat(contract).forEach((g) => {
        if (g.length > LIMITS.glob) errs.push(label + ': path "' + g.slice(0, 30) + '…" is longer than ' + LIMITS.glob + ' characters.');
      });
      const setup = lines(r.setup);
      if (setup.length > LIMITS.setup) errs.push(label + ': at most ' + LIMITS.setup + ' setup commands.');
      setup.forEach((c) => {
        if (c.length > LIMITS.cmd) errs.push(label + ': a setup command is longer than ' + LIMITS.cmd + ' characters.');
      });
      const verify = r.verify.filter((v) => v.name.trim() || v.cmd.trim());
      if (verify.length > LIMITS.verify) errs.push(label + ': at most ' + LIMITS.verify + ' verify commands.');
      verify.forEach((v) => {
        if (!v.name.trim() || !v.cmd.trim()) errs.push(label + ': each verify row needs a name and a command.');
        if (v.cmd.length > LIMITS.cmd) errs.push(label + ': verify command "' + v.name + '" is longer than ' + LIMITS.cmd + ' characters.');
      });
      const lm = r.laneMap.filter((m) => m.glob.trim() || m.lane.trim());
      if (lm.length > LIMITS.laneMap) errs.push(label + ': at most ' + LIMITS.laneMap + ' lane mappings.');
      lm.forEach((m) => {
        if (!m.glob.trim() || !m.lane.trim()) errs.push(label + ': each lane mapping needs a folder glob and a lane.');
        if (m.glob.length > LIMITS.glob) errs.push(label + ': a lane mapping glob is longer than ' + LIMITS.glob + ' characters.');
      });
      if (commaList(r.prLabels).length > LIMITS.prLabels) errs.push(label + ': at most ' + LIMITS.prLabels + ' PR labels.');
      if (r.notes.length > LIMITS.notes) errs.push(label + ': notes are longer than ' + LIMITS.notes + ' characters.');
    });
    return errs;
  }

  function draftPayload(d) {
    const demo = {};
    if (d.demo.url.trim()) demo.url = d.demo.url.trim();
    if (d.demo.stage.trim()) demo.stage = d.demo.stage.trim();
    if (d.demo.notes.trim()) demo.notes = d.demo.notes.trim();
    const payload = {
      name: d.name.trim(),
      description: d.description.trim() || undefined,
      tags: commaList(d.tags),
      lanes: commaList(d.lanes),
      links: d.links.filter((l) => l.label.trim() || l.url.trim()).map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
      demo: Object.keys(demo).length ? demo : undefined,
      repos: d.repos.map((r) => {
        const out = {
          name: r.name.trim(),
          url: r.url.trim(),
          baseBranch: r.baseBranch.trim(),
          integrationBranch: r.integrationBranch.trim(),
          hotPaths: lines(r.hotPaths),
          contractPaths: lines(r.contractPaths),
          setup: lines(r.setup),
          verify: r.verify.filter((v) => v.name.trim() && v.cmd.trim()).map((v) => ({ name: v.name.trim(), cmd: v.cmd.trim() })),
          laneMap: r.laneMap.filter((m) => m.glob.trim() && m.lane.trim()).map((m) => ({ glob: m.glob.trim(), lane: m.lane.trim() })),
          prLabels: commaList(r.prLabels),
        };
        if (r.instructionsPath.trim()) out.instructionsPath = r.instructionsPath.trim();
        if (r.notes.trim()) out.notes = r.notes.trim();
        return out;
      }),
    };
    if (d.isNew) payload.id = d.id;
    else payload.projectId = d.id;
    return payload;
  }

  function openProjectEditor(existing) {
    const d = projectDraft(existing);
    const body = h('div', { class: 'pe' });
    const errBox = h('div', { class: 'pe-errors', role: 'alert', 'aria-live': 'assertive' });
    let uid = 0;
    const nid = (x) => 'pe-' + x + '-' + ++uid;

    const bind = (obj, key, el, after) => {
      el.addEventListener('input', () => {
        obj[key] = el.value;
        if (after) after(el.value);
      });
      return el;
    };
    const txt = (label, obj, key, opts) => {
      opts = opts || {};
      const id = nid(key);
      const input = opts.multiline
        ? h('textarea', { id, rows: String(opts.rows || 3), value: obj[key], placeholder: opts.placeholder || '', class: opts.mono ? 'mono' : '', spellcheck: opts.mono ? 'false' : null })
        : h('input', { id, type: opts.type || 'text', value: obj[key], placeholder: opts.placeholder || '', class: opts.mono ? 'mono' : '', spellcheck: opts.mono ? 'false' : null, autocomplete: 'off' });
      bind(obj, key, input, opts.after);
      if (opts.ref) opts.ref(input);
      return h('div', { class: 'field' + (opts.wide ? ' span-2' : '') }, h('label', { for: id, text: label }), input, opts.hint ? h('span', { class: 'hint', text: opts.hint }) : null);
    };

    const rowList = (title, rows, cols, addLabel, focusKey) => {
      const listEl = h(
        'div',
        { class: 'pe-rows' },
        rows.map((row, i) =>
          h(
            'div',
            { class: 'pe-row' },
            cols.map((c) => {
              const id = nid(c.key);
              return h(
                'div',
                { class: 'field' + (c.grow ? ' grow' : '') },
                h('label', { for: id, class: i === 0 ? '' : 'sr', text: c.label }),
                bind(row, c.key, h('input', { id, type: 'text', value: row[c.key], placeholder: c.placeholder || '', class: c.mono ? 'mono' : '', spellcheck: c.mono ? 'false' : null, autocomplete: 'off', 'data-row-focus': focusKey + '-' + i }))
              );
            }),
            h(
              'button',
              {
                class: 'btn icon-only sm',
                type: 'button',
                'aria-label': 'Remove ' + title.toLowerCase() + ' row ' + (i + 1),
                onclick: () => {
                  rows.splice(i, 1);
                  paint();
                },
              },
              icon('x')
            )
          )
        )
      );
      return h(
        'div',
        { class: 'pe-rowlist span-2' },
        h('div', { class: 'pe-rowlist-head' }, h('span', { class: 'pe-label', text: title })),
        rows.length ? listEl : null,
        h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            onclick: () => {
              const blank = {};
              cols.forEach((c) => (blank[c.key] = ''));
              rows.push(blank);
              paint('[data-row-focus="' + focusKey + '-' + (rows.length - 1) + '"]');
            },
          },
          icon('plus'),
          ' ',
          addLabel
        )
      );
    };

    let idInput = null;
    const branchInputs = [];
    const summaries = [];

    function onIdChange(v) {
      d.id = v.trim();
      d.repos.forEach((r, i) => {
        if (!r.integrationTouched) {
          r.integrationBranch = 'hack/' + (d.id || '<id>');
          if (branchInputs[i]) branchInputs[i].value = r.integrationBranch;
          if (summaries[i]) summaries[i]();
        }
      });
    }

    function repoCard(r, i) {
      const presetId = nid('preset');
      const nameEl = h('span', { text: r.name || 'New repo' });
      const branchEl = h('span', { class: 'mono muted', text: r.baseBranch + ' → ' + r.integrationBranch });
      const syncSummary = () => {
        nameEl.textContent = r.name || 'New repo';
        branchEl.textContent = r.baseBranch + ' → ' + r.integrationBranch;
      };
      summaries[i] = syncSummary;
      const select = h(
        'select',
        {
          id: presetId,
          onchange: (e) => {
            const key = e.target.value;
            const pr = REPO_PRESETS[key];
            if (!pr) return;
            r.preset = key;
            r.hotPaths = pr.hotPaths.join('\n');
            r.contractPaths = pr.contractPaths.join('\n');
            r.setup = pr.setup.join('\n');
            r.verify = pr.verify.map((v) => ({ name: v.name, cmd: v.cmd }));
            r.instructionsPath = pr.instructionsPath;
            r.notes = pr.notes;
            if (pr.laneMap && pr.laneMap.length) r.laneMap = pr.laneMap.map((m) => ({ glob: m.glob, lane: m.lane }));
            if (pr.prLabels) r.prLabels = pr.prLabels.join(', ');
            r.open = true;
            paint('#' + presetId);
            toast('Applied the ' + pr.label + ' preset to ' + (r.name || 'repo ' + (i + 1)) + '.');
          },
        },
        h('option', { value: '', text: 'Choose a preset…' }),
        Object.keys(REPO_PRESETS).map((k) => h('option', { value: k, selected: r.preset === k, text: REPO_PRESETS[k].label }))
      );
      const details = h(
        'details',
        { class: 'repo-card', open: r.open },
        h(
          'summary',
          null,
          h('span', { class: 'repo-name' }, icon('branch'), ' ', nameEl),
          branchEl,
          h('span', { class: 'spacer' }),
          h(
            'button',
            {
              class: 'btn sm danger',
              type: 'button',
              'aria-label': 'Remove repo ' + (r.name || i + 1),
              onclick: (e) => {
                e.preventDefault();
                d.repos.splice(i, 1);
                paint();
              },
            },
            'Remove'
          )
        ),
        h(
          'div',
          { class: 'pe-grid' },
          txt('Repo name', r, 'name', { placeholder: 'platform', mono: true, hint: 'Unique in this project; tickets refer to it.', after: syncSummary }),
          txt('Git URL', r, 'url', { placeholder: 'git@github.com:org/repo.git', mono: true }),
          txt('Base branch', r, 'baseBranch', { mono: true, hint: 'The integration branch is cut from it.', after: syncSummary }),
          txt('Integration branch', r, 'integrationBranch', {
            mono: true,
            hint: 'Defaults to hack/<project id>.',
            ref: (el) => (branchInputs[i] = el),
            after: () => {
              r.integrationTouched = true;
              syncSummary();
            },
          }),
          h('div', { class: 'field span-2' }, h('label', { for: presetId, text: 'Preset' }), select, h('span', { class: 'hint', text: 'Fills protected and contract paths, setup, verify, instructions and notes. You can edit them afterwards.' })),
          txt('Protected paths (one glob per line)', r, 'hotPaths', { multiline: true, rows: 4, mono: true, hint: 'Nobody edits these from a build ticket: lockfiles, workspace config, CI, registrations.' }),
          txt('Contract paths (one glob per line)', r, 'contractPaths', { multiline: true, rows: 4, mono: true, hint: 'Shared contracts. Only contract or glue tickets may own them.' }),
          txt('Setup commands (one per line)', r, 'setup', { multiline: true, rows: 2, mono: true, hint: 'Run in a fresh worktree, e.g. npm ci.' }),
          txt('Instructions file', r, 'instructionsPath', { mono: true, placeholder: 'CLAUDE.md' }),
          rowList('Verify commands', r.verify, [
            { key: 'name', label: 'Name', placeholder: 'typecheck', mono: true },
            { key: 'cmd', label: 'Command', placeholder: 'npm run type:check', mono: true, grow: true },
          ], 'Add verify command', 'verify-' + i),
          rowList('Folder → lane hints', r.laneMap, [
            { key: 'glob', label: 'Folder glob', placeholder: 'apps/mobile/**', mono: true, grow: true },
            { key: 'lane', label: 'Lane', placeholder: 'mobile' },
          ], 'Add lane hint', 'lane-' + i),
          txt('PR labels (comma separated)', r, 'prLabels', { placeholder: 'hackathon, agent' }),
          txt('Notes for agents', r, 'notes', { multiline: true, rows: 2, wide: true, placeholder: 'e.g. never run builds' })
        )
      );
      details.addEventListener('toggle', () => (r.open = details.open));
      return details;
    }

    function paint(focusSel) {
      branchInputs.length = 0;
      summaries.length = 0;
      body.replaceChildren(
        errBox,
        h(
          'fieldset',
          { class: 'pe-section' },
          h('legend', { text: 'Project' }),
          h(
            'div',
            { class: 'pe-grid' },
            txt('Name', d, 'name', {
              placeholder: 'Offline note capture',
              after: (v) => {
                if (d.isNew && !d.idTouched) {
                  const slug = slugify(v);
                  if (idInput) idInput.value = slug;
                  onIdChange(slug);
                }
              },
            }),
            d.isNew
              ? txt('Project id', d, 'id', {
                  mono: true,
                  placeholder: 'offline-capture',
                  hint: 'Lowercase, digits and dashes. Used in branch names.',
                  ref: (el) => (idInput = el),
                  after: (v) => {
                    d.idTouched = true;
                    onIdChange(v);
                  },
                })
              : h('div', { class: 'field' }, h('span', { class: 'pe-label', text: 'Project id' }), h('span', { class: 'chip mono strong', text: d.id }), h('span', { class: 'hint', text: 'The id can’t change after creation.' })),
            txt('Description', d, 'description', { multiline: true, rows: 3, wide: true, placeholder: 'What this project proves, for whom.' }),
            txt('Lanes (comma separated)', d, 'lanes', { placeholder: 'mobile, api, web' }),
            txt('Tags (comma separated)', d, 'tags', { placeholder: 'offline, mobile' })
          )
        ),
        h(
          'fieldset',
          { class: 'pe-section' },
          h('legend', { text: 'Links and demo' }),
          h(
            'div',
            { class: 'pe-grid' },
            rowList('Links', d.links, [
              { key: 'label', label: 'Label', placeholder: 'Slack channel' },
              { key: 'url', label: 'https URL', placeholder: 'https://…', mono: true, grow: true },
            ], 'Add link', 'link'),
            txt('Demo URL', d.demo, 'url', { mono: true, placeholder: 'https://…' }),
            txt('Demo stage', d.demo, 'stage', { mono: true, placeholder: 'hack-int' }),
            txt('Demo notes', d.demo, 'notes', { multiline: true, rows: 2, wide: true, placeholder: 'Seed data, test accounts (no secrets).' })
          )
        ),
        h(
          'fieldset',
          { class: 'pe-section' },
          h('legend', { text: 'Repos' }),
          h('p', { class: 'hint', text: 'Agents read these before working: where to branch from, what not to touch, how to set up and verify.' }),
          d.repos.map(repoCard),
          d.repos.length < LIMITS.repos
            ? h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: () => {
                    d.repos.forEach((r) => (r.open = false));
                    d.repos.push(repoDraft(null, d.id || '<id>', true));
                    paint('.repo-card[open] input');
                  },
                },
                icon('plus'),
                ' Add repo'
              )
            : null
        )
      );
      if (focusSel) {
        const el = body.querySelector(focusSel);
        if (el) el.focus();
      }
    }

    paint();
    openModal(
      d.isNew ? 'New project' : 'Project settings · ' + d.name,
      [body],
      d.isNew ? 'Create project' : 'Save changes',
      async () => {
        const errs = validateDraft(d);
        if (errs.length) {
          errBox.replaceChildren(h('strong', { text: 'Fix these before saving' }), h('ul', null, errs.map((e) => h('li', { text: e }))));
          errBox.classList.add('on');
          errBox.scrollIntoView({ block: 'nearest' });
          return false;
        }
        errBox.classList.remove('on');
        errBox.replaceChildren();
        return saveProject(d);
      },
      { wide: true }
    );
  }

  async function saveProject(d) {
    const payload = draftPayload(d);
    try {
      if (S.mode === 'demo') {
        if (d.isNew) {
          const p = Object.assign({}, payload, { status: 'active', phase: 'plan', goalVersion: 0, createdBy: S.data.me.id, createdAt: Date.now() });
          delete p.projectId;
          S.data.projects.push(p);
          demoEvent('broadcast', 'project.created', 'human', 'Project ' + p.name + ' created by ' + S.data.me.name);
          S.selectedProjectId = p.id;
        } else {
          const p = S.data.projects.find((x) => x.id === d.id);
          const patch = Object.assign({}, payload);
          delete patch.projectId;
          Object.keys(patch).forEach((k) => {
            if (patch[k] === undefined) delete p[k];
            else p[k] = patch[k];
          });
          demoEvent('broadcast', 'project.updated', 'human', 'Project ' + p.name + ' settings changed by ' + S.data.me.name, p.id);
        }
      } else {
        await H1.Api.action(d.isNew ? 'project.create' : 'project.update', payload);
        if (d.isNew) S.selectedProjectId = payload.id;
        await loadBoard();
      }
      toast(d.isNew ? 'Project created.' : 'Project settings saved.');
      render();
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  }

  /* ---------------------------------------------------------------- drawer */

  let drawerReturnFocus = null;

  function openDrawer(tid) {
    drawerReturnFocus = document.activeElement;
    S.drawerTicketId = tid;
    renderDrawer();
    if (S.mode === 'live') {
      refreshTicket(tid).then(() => {
        if (S.drawerTicketId === tid) renderDrawer();
      });
    }
  }

  function closeDrawer() {
    S.drawerTicketId = null;
    overlay.replaceChildren();
    const key = drawerReturnFocus && drawerReturnFocus.getAttribute ? drawerReturnFocus.getAttribute('data-focus-key') : null;
    const target = drawerReturnFocus && document.body.contains(drawerReturnFocus) ? drawerReturnFocus : key ? root.querySelector('[data-focus-key="' + key + '"]') : null;
    if (target) target.focus();
  }

  function renderDrawer() {
    const t = S.data.tickets.find((x) => x.id === S.drawerTicketId);
    if (!t) {
      overlay.replaceChildren();
      return;
    }
    const p = S.data.projects.find((x) => x.id === t.projectId);
    const closeBtn = h('button', { class: 'btn icon-only', 'aria-label': 'Close ticket details', onclick: closeDrawer }, icon('x'));
    const depChips = (t.deps || []).map((d) => {
      const dt = S.data.tickets.find((x) => x.id === d);
      return h('span', { class: 'chip mono' }, d, dt ? h('span', { class: 'status st-' + dt.status, text: STATUS_LABEL[dt.status] }) : null);
    });
    const drawer = h(
      'aside',
      { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' },
      h(
        'header',
        null,
        h('div', { class: 'row' }, h('div', { class: 'stats' }, h('span', { class: 'chip mono strong', text: t.id }), h('span', { class: 'status st-' + t.status, text: STATUS_LABEL[t.status] }), h('span', { class: 'chip mono', text: t.type })), closeBtn),
        h('h2', { id: 'drawer-title', text: t.title }),
        h('div', { class: 'muted', text: (p ? p.name : t.projectId) + ' · repo ' + t.repo + ' · priority ' + t.priority + (t.wave != null ? ' · wave ' + t.wave : '') })
      ),
      h(
        'div',
        { class: 'body' },
        t.description ? h('section', null, h('h3', { text: 'Description' }), h('p', { text: t.description })) : null,
        h(
          'section',
          null,
          h('h3', { text: 'Who and where' }),
          h(
            'dl',
            { class: 'kv' },
            h('dt', { text: 'Booked by' }),
            h('dd', null, t.booking ? seatName(t.booking.seatId) + (t.booking.workerId ? ' / worker ' + t.booking.workerId : '') + (t.booking.sessionId ? ' · ' + t.booking.sessionId : '') : 'nobody'),
            t.booking ? h('dt', { text: 'Lease' }) : null,
            t.booking ? h('dd', null, countdown(t.booking.leaseExpiresAt, 'expires in ')) : null,
            t.review ? h('dt', { text: 'Reviewer' }) : null,
            t.review ? h('dd', { text: seatName(t.review.seatId) + (t.review.workerId ? ' / ' + t.review.workerId : '') }) : null,
            h('dt', { text: 'Branch' }),
            h('dd', null, h('span', { class: 'mono', text: t.branch || 'hack/' + t.projectId + '/' + t.id })),
            h('dt', { text: 'Pull request' }),
            h('dd', null, t.prUrl ? h('a', { href: t.prUrl, target: '_blank', rel: 'noopener noreferrer' }, t.prUrl.replace(/^https:\/\/github\.com\//, ''), ' ', icon('link')) : 'not opened yet'),
            h('dt', { text: 'Lanes' }),
            h('dd', { text: (t.lanes || []).join(', ') || '—' }),
            h('dt', { text: 'Attempts' }),
            h('dd', { text: String(t.attempts || 0) }),
            h('dt', { text: 'Created by' }),
            h('dd', { text: seatName(t.createdBy) + (t.createdByAgent ? ' (agent)' : '') })
          )
        ),
        h(
          'section',
          null,
          h('h3', { text: 'Acceptance' }),
          (t.acceptance || []).length
            ? h('ul', { class: 'acc' }, t.acceptance.map((a) => h('li', null, h('span', { text: a.criterion }), a.cmd ? h('code', { text: a.cmd }) : null)))
            : h('p', { class: 'muted', text: 'No acceptance criteria.' })
        ),
        drawerRepoSection(t, p),
        h('section', null, h('h3', { text: 'Depends on' }), depChips.length ? h('div', { class: 'paths' }, depChips) : h('p', { class: 'muted', text: 'No dependencies.' })),
        h('section', null, h('h3', { text: 'Owned paths' }), h('div', { class: 'paths' }, (t.pathsOwned || []).map((x) => h('span', { class: 'chip mono', text: x })))),
        h(
          'section',
          null,
          h('h3', { text: 'Log' }),
          (t.log || []).length
            ? h('ol', { class: 'timeline' }, t.log.slice().reverse().map((l) => h('li', null, h('span', { class: 'mono muted', text: clockTime(l.ts) }), h('span', null, h('strong', { text: seatName(l.who) + ' ' }), h('span', { class: 'chip ' + (l.kind === 'human' ? 'human' : 'agent'), text: l.kind }), ' ', l.text))))
            : h('p', { class: 'muted', text: 'Nothing logged yet.' })
        )
      )
    );
    overlay.replaceChildren(h('div', { class: 'drawer-backdrop', onclick: closeDrawer }), drawer);
    closeBtn.focus();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.drawerTicketId && !document.querySelector('dialog[open]')) closeDrawer();
  });

  /* ---------------------------------------------------------------- dialogs */

  function openModal(title, bodyNodes, submitLabel, onSubmit, opts) {
    const dlg = h('dialog', { class: 'modal' + (opts && opts.wide ? ' wide' : ''), 'aria-labelledby': 'modal-title' });
    const form = h(
      'form',
      {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          const ok = await onSubmit(form);
          if (ok !== false) dlg.close();
        },
      },
      h('h2', { id: 'modal-title', text: title }),
      bodyNodes,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn ' + (opts && opts.danger ? 'danger' : 'primary'), type: 'submit' }, submitLabel)
      )
    );
    dlg.appendChild(form);
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (location.hash.indexOf('#/approve/') === 0) history.replaceState(null, '', location.pathname + location.search);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    const first = form.querySelector('textarea, input, select');
    if (first) first.focus();
  }

  function openApprove(pid) {
    const p = S.data.proposals.find((x) => x.id === pid);
    if (!p) {
      toast('Proposal ' + pid + ' is no longer pending.', 'error');
      return;
    }
    openModal(
      'Approve ' + p.id + '?',
      [
        h(
          'div',
          { class: 'callout' },
          h('div', null, h('span', { class: 'chip accent', text: ACTION_LABEL[p.action] || p.action }), ' ', p.payload && p.payload.projectId ? h('span', { class: 'chip mono', text: p.payload.projectId }) : null),
          h('strong', { text: p.summary }),
          h('span', { class: 'muted', text: 'Proposed by ' + seatName(p.proposedBy) + '’s agent ' + relTime(p.createdAt) + '. Approving runs it as you.' })
        ),
      ],
      'Approve',
      () => doApprove(pid)
    );
  }

  async function doApprove(pid) {
    try {
      if (S.mode === 'demo') {
        const p = S.data.proposals.find((x) => x.id === pid);
        p.status = 'approved';
        S.data.proposals = S.data.proposals.filter((x) => x.id !== pid);
        demoEvent('decisions', 'proposal.approved', 'human', pid + ' approved by ' + S.data.me.name + ': ' + p.summary, p.payload && p.payload.projectId);
      } else {
        await H1.Api.approve(pid);
        await refreshProposals();
      }
      toast(pid + ' approved.');
      render();
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  }

  async function doReject(pid) {
    try {
      if (S.mode === 'demo') {
        const p = S.data.proposals.find((x) => x.id === pid);
        S.data.proposals = S.data.proposals.filter((x) => x.id !== pid);
        demoEvent('decisions', 'proposal.rejected', 'human', pid + ' rejected by ' + S.data.me.name, p && p.payload && p.payload.projectId);
      } else {
        await H1.Api.reject(pid);
        await refreshProposals();
      }
      toast(pid + ' rejected.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function openResolve(eid) {
    const e = S.data.escalations.find((x) => x.id === eid);
    if (!e) return;
    const rule = S.data.rules.rows.find((r) => r.code === e.ruleCode);
    const opts = (e.proposed || []).map((o, i) =>
      h('label', { class: 'field-inline', style: { color: 'var(--ink)' } }, h('input', { type: 'radio', name: 'opt', value: o, checked: i === 0, style: { minHeight: 'auto' } }), o)
    );
    openModal(
      'Resolve ' + e.id,
      [
        h('div', { class: 'callout' }, h('strong', { text: e.summary }), h('span', { class: 'muted', text: e.detail || '' })),
        opts.length ? h('fieldset', { style: { border: '0', padding: '0', margin: '0', display: 'grid', gap: '6px' } }, h('legend', { class: 'muted', style: { marginBottom: '4px' }, text: 'Proposed options' }), opts) : null,
        h('div', { class: 'field' }, h('label', { for: 'res-text', text: 'Decision' }), h('textarea', { id: 'res-text', placeholder: opts.length ? 'Leave empty to use the picked option' : 'What should happen' })),
        h('div', { class: 'field' }, h('label', { for: 'res-reason', text: 'Reason' }), h('textarea', { id: 'res-reason', placeholder: 'One or two lines for the log' })),
        h('p', { class: 'muted', text: 'Anyone can contest this for ' + ((rule && rule.contestMin) || S.data.settings.defaultContestMin || 10) + ' minutes after you resolve it.' }),
      ],
      'Resolve',
      async (form) => {
        const picked = form.querySelector('input[name="opt"]:checked');
        let text = form.querySelector('#res-text').value.trim();
        if (!text && picked) text = picked.value;
        const reason = form.querySelector('#res-reason').value.trim();
        if (!text) {
          toast('Write the decision first.', 'error');
          return false;
        }
        try {
          if (S.mode === 'demo') {
            e.status = 'resolved_pending_contest';
            e.resolution = { text, by: S.data.me.id, at: Date.now(), contestUntil: Date.now() + ((rule && rule.contestMin) || 10) * 60000 };
            demoEvent('escalations', 'escalation.resolved', 'human', e.id + ' resolved by ' + S.data.me.name + ': ' + text, e.projectId, e.ticketId);
          } else {
            await H1.Api.resolve(eid, text, reason);
            await refreshEscalations();
          }
          toast(e.id + ' resolved. Contest window is open.');
          render();
          return true;
        } catch (err) {
          toast(err.message, 'error');
          return false;
        }
      }
    );
  }

  function openContest(eid) {
    const e = S.data.escalations.find((x) => x.id === eid);
    if (!e) return;
    openModal(
      'Contest ' + e.id,
      [
        h('div', { class: 'callout' }, h('strong', { text: e.summary }), e.resolution ? h('span', null, h('span', { class: 'muted', text: 'Resolved by ' + seatName(e.resolution.by) + ': ' }), e.resolution.text) : null),
        h('div', { class: 'field' }, h('label', { for: 'con-reason', text: 'Why you disagree' }), h('textarea', { id: 'con-reason', required: true })),
        h('p', { class: 'muted', text: 'Contesting opens a quick vote among the humans. The ticket stays parked until it closes.' }),
      ],
      'Contest',
      async (form) => {
        const reason = form.querySelector('#con-reason').value.trim();
        if (!reason) {
          toast('Add a reason.', 'error');
          return false;
        }
        try {
          if (S.mode === 'demo') {
            e.status = 'contested';
            const did = 'D' + (S.data.decisions.length + 4);
            S.data.decisions.unshift({
              id: did,
              projectId: e.projectId,
              escalationId: e.id,
              question: 'Keep the resolution of ' + e.id + '? (' + e.resolution.text + ')',
              options: ['Keep', 'Overturn'],
              context: 'Contested by ' + S.data.me.name + ': ' + reason,
              electorate: 'humans',
              eligible: S.data.seats.map((s) => s.id),
              rule: 'majority',
              quorum: 3,
              deadline: Date.now() + 10 * 60000,
              defaultOption: 'Keep',
              votes: [],
              status: 'open',
            });
            demoEvent('escalations', 'escalation.contested', 'human', e.id + ' contested by ' + S.data.me.name + '; human vote ' + did + ' opened', e.projectId, e.ticketId);
          } else {
            await H1.Api.contest(eid, reason);
            await Promise.all([refreshEscalations(), refreshDecisions()]);
          }
          toast(e.id + ' contested. A human vote is open.');
          render();
          return true;
        } catch (err) {
          toast(err.message, 'error');
          return false;
        }
      },
      { danger: true }
    );
  }

  function openVote(did, option) {
    const d = S.data.decisions.find((x) => x.id === did);
    if (!d) return;
    openModal(
      'Vote ' + option + ' on ' + d.id,
      [
        h('div', { class: 'callout' }, h('strong', { text: d.question }), h('span', { class: 'muted', text: d.context || '' })),
        h('div', { class: 'field' }, h('label', { for: 'vote-why', text: 'Reason (one line)' }), h('input', { id: 'vote-why', maxlength: '200', placeholder: 'Shown next to your vote' })),
      ],
      'Vote ' + option,
      async (form) => {
        const why = form.querySelector('#vote-why').value.trim() || 'Human vote';
        try {
          if (S.mode === 'demo') {
            d.votes = d.votes.filter((v) => v.seat !== S.data.me.id);
            d.votes.push({ seat: S.data.me.id, option, by: 'human', why, ts: Date.now() });
            demoEvent('decisions', 'vote.cast', 'human', S.data.me.name + ' voted ' + option + ' on ' + d.id, d.projectId);
          } else {
            await H1.Api.vote(did, option, why);
            await refreshDecisions();
          }
          toast('Vote recorded.');
          render();
          return true;
        } catch (err) {
          toast(err.message, 'error');
          return false;
        }
      }
    );
  }

  /* ---------------------------------------------------------------- navigation */

  function selectProject(pid) {
    S.selectedProjectId = pid;
    setPref('project', pid);
    if (S.mode === 'live') loadBoard().catch((e) => toast(e.message, 'error'));
    render();
  }

  function handleHash() {
    const m = /^#\/approve\/(P\d+)$/.exec(location.hash || '');
    if (m) openApprove(m[1]);
  }
  window.addEventListener('hashchange', handleHash);

  /* ---------------------------------------------------------------- events */

  function markNew(env) {
    S.newSeqs[env.seq] = true;
    if (env.ticketId) S.flash[env.ticketId] = true;
    setTimeout(() => {
      delete S.newSeqs[env.seq];
      if (env.ticketId) delete S.flash[env.ticketId];
    }, 2000);
  }

  function pushEvent(env) {
    S.data.events.push(env);
    if (S.data.events.length > 300) S.data.events.splice(0, S.data.events.length - 300);
    S.data.lastSeq = Math.max(S.data.lastSeq, env.seq);
    markNew(env);
  }

  function demoEvent(stream, type, fromKind, summary, projectId, ticketId) {
    S.data.lastSeq += 1;
    const e = { seq: S.data.lastSeq, ts: Date.now(), stream, type, from: S.data.me.id, fromKind, summary };
    if (projectId) e.projectId = projectId;
    if (ticketId) e.ticketId = ticketId;
    pushEvent(e);
  }

  /* ---- demo mode */

  function startDemo() {
    S.mode = 'demo';
    S.conn = 'demo';
    S.data = H1.demoData();
    S.selectedProjectId = pref('project', null);
    if (!S.data.projects.find((p) => p.id === S.selectedProjectId)) S.selectedProjectId = S.data.projects[0].id;
    render();
    handleHash();
    setInterval(() => {
      if (S.demoPaused || document.querySelector('dialog[open]')) return;
      if (S.demoStep >= H1.demoSteps.length) {
        const keep = { me: S.data.me };
        S.data = H1.demoData();
        S.data.me = keep.me;
        S.demoStep = 0;
        render();
        return;
      }
      const env = H1.demoSteps[S.demoStep++](S.data, Date.now());
      pushEvent(env);
      render();
      if (S.drawerTicketId && env.ticketId === S.drawerTicketId) renderDrawer();
    }, 4500);
  }

  /* ---- live mode */

  function list(x, key) {
    if (Array.isArray(x)) return x;
    if (x && Array.isArray(x[key])) return x[key];
    if (x && Array.isArray(x.items)) return x.items;
    return [];
  }

  function normalizeRules(r) {
    if (!r) return { version: 0, rows: [] };
    if (Array.isArray(r)) return { version: Math.max.apply(null, [0].concat(r.map((x) => x.version || 0))), rows: r };
    return { version: r.version || 0, rows: r.rows || r.rules || [] };
  }

  async function loadBoard() {
    const b = await H1.Api.board(S.selectedProjectId);
    const d = S.data;
    d.projects = list(b.projects, 'projects');
    if (!S.selectedProjectId || !d.projects.find((p) => p.id === S.selectedProjectId)) S.selectedProjectId = (d.projects[0] || {}).id || null;
    if (b.goal) d.goals[b.goal.projectId] = b.goal;
    if (b.goals) Object.assign(d.goals, b.goals);
    const fresh = list(b.tickets, 'tickets');
    const freshIds = {};
    fresh.forEach((t) => (freshIds[t.id] = true));
    d.tickets = d.tickets.filter((t) => !freshIds[t.id] && t.projectId !== S.selectedProjectId).concat(fresh);
    d.seats = list(b.seats, 'seats');
    d.escalations = list(b.escalations, 'escalations');
    d.decisions = list(b.decisions, 'decisions');
    d.proposals = list(b.proposals, 'proposals');
    d.knowledge = list(b.knowledge, 'knowledge');
    if (b.rules) d.rules = normalizeRules(b.rules);
    else d.rules = normalizeRules(await H1.Api.rules(S.selectedProjectId).catch(() => null));
    if (b.settings) d.settings = b.settings;
    if (typeof b.lastSeq === 'number') d.lastSeq = Math.max(d.lastSeq, b.lastSeq);
    if (Array.isArray(b.events)) d.events = b.events.slice(-100);
    // Tickets of the other projects feed the all-projects strip.
    await Promise.all(
      d.projects
        .filter((p) => p.id !== S.selectedProjectId)
        .map((p) =>
          H1.Api.get('/projects/' + encodeURIComponent(p.id) + '/tickets')
            .then((r) => {
              const ts = list(r, 'tickets');
              d.tickets = d.tickets.filter((t) => t.projectId !== p.id).concat(ts);
            })
            .catch(() => null)
        )
    );
    if (!d.goals[S.selectedProjectId] && S.selectedProjectId) {
      try {
        const g = await H1.Api.get('/projects/' + encodeURIComponent(S.selectedProjectId) + '/goal');
        const goal = g && 'goal' in g ? g.goal : g;
        if (goal && Array.isArray(goal.definitionOfDone)) d.goals[S.selectedProjectId] = goal;
      } catch (e) {
        /* no goal yet */
      }
    }
    render();
  }

  async function loadHistory() {
    if (S.data.events.length || !S.data.lastSeq) return;
    const r = await H1.Api.events(Math.max(0, S.data.lastSeq - 100)).catch(() => null);
    const evs = list(r, 'events');
    if (!evs.length) return;
    S.data.events = evs.slice(-100);
    render();
  }

  async function refreshTicket(tid) {
    if (!tid) return;
    const r = await H1.Api.ticket(tid);
    const t = r && r.ticket ? r.ticket : r;
    if (!t || !t.id) return;
    const i = S.data.tickets.findIndex((x) => x.id === t.id);
    if (i >= 0) S.data.tickets[i] = t;
    else S.data.tickets.push(t);
  }
  async function refreshEscalations() {
    S.data.escalations = list(await H1.Api.escalations(), 'escalations');
  }
  async function refreshDecisions() {
    S.data.decisions = list(await H1.Api.decisions(), 'decisions');
  }
  async function refreshProposals() {
    S.data.proposals = list(await H1.Api.proposals(), 'proposals');
  }
  async function refreshKnowledge() {
    S.data.knowledge = list(await H1.Api.knowledge(), 'knowledge');
  }
  async function refreshRules() {
    S.data.rules = normalizeRules(await H1.Api.rules(S.selectedProjectId));
  }
  async function refreshTokens() {
    S.data.tokens = list(await H1.Api.tokens(), 'tokens');
  }

  const pending = { jobs: {}, timer: null };

  function schedule(key, fn) {
    pending.jobs[key] = fn;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(async () => {
      const jobs = pending.jobs;
      pending.jobs = {};
      await Promise.all(Object.keys(jobs).map((k) => jobs[k]().catch(() => null)));
      render();
      if (S.drawerTicketId) renderDrawer();
    }, 300);
  }

  function onEnvelope(env) {
    if (env.seq <= S.data.lastSeq) return;
    pushEvent(env);
    const t = env.type || '';
    if (env.ticketId && /^(ticket|review)\./.test(t)) schedule('ticket-' + env.ticketId, () => refreshTicket(env.ticketId));
    if (/^(escalation|blocker|help|issue|urgent)\./.test(t)) {
      schedule('esc', refreshEscalations);
      if (env.ticketId) schedule('ticket-' + env.ticketId, () => refreshTicket(env.ticketId));
    }
    if (/^(decision|vote)\./.test(t)) schedule('dec', refreshDecisions);
    if (/^proposal\./.test(t)) schedule('prop', refreshProposals);
    if (/^(skill|tip|playbook|knowledge)\./.test(t)) schedule('kn', refreshKnowledge);
    if (/^rules\./.test(t)) schedule('rules', refreshRules);
    if (t === 'tool.released' && env.data) {
      S.data.release = { latest: env.data.version, minimum: env.data.minimum || undefined, notes: env.data.notes, publishedAt: env.ts, by: env.from };
      if (!S.historyLoading) S.releaseBanner = env.data;
    }
    if (t === 'seat.connected' && S.data.me && env.from === S.data.me.id) {
      S.joinCode = null;
      schedule('tokens', refreshTokens);
    }
    if (/^(project|goal|phase|plan|seat|session|participant|settings)\./.test(t) || env.stream === 'presence') schedule('board', loadBoard);
    schedule('render', async () => null);
  }

  async function catchUp() {
    let more = true;
    let guard = 0;
    while (more && guard++ < 20) {
      const r = await H1.Api.events(S.data.lastSeq);
      const evs = list(r, 'events');
      evs.forEach(onEnvelope);
      more = evs.length >= 200;
    }
    render();
  }

  function screen(title, bodyNodes) {
    root.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'panel center-card' }, h('div', { class: 'brand' }, brandMark(), 'HackathonOne'), h('h1', { text: title }), bodyNodes)));
  }

  function signInScreen(error) {
    screen('Sign in to the team board', [
      h('p', { class: 'muted', text: 'Use your hackathon account. Sign-in asks for your authenticator code.' }),
      error ? h('p', { class: 'chip bad', style: { whiteSpace: 'normal' }, text: error }) : null,
      h('button', { class: 'btn primary', onclick: () => H1.Auth.signIn() }, 'Sign in'),
      h('p', { class: 'muted', style: { fontSize: '0.85rem' } }, 'Just looking? ', h('a', { href: '?demo', text: 'Open the demo board' }), '.'),
    ]);
  }

  function seatScreen(claims) {
    const suggested = String((claims && (claims.given_name || claims.name || (claims.email || '').split('@')[0])) || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const form = h(
      'form',
      {
        style: { display: 'grid', gap: '12px' },
        onsubmit: async (e) => {
          e.preventDefault();
          const v = (id) => form.querySelector('#' + id).value.trim();
          const id = v('seat-id');
          if (!/^[a-z0-9-]{2,40}$/.test(id)) {
            toast('Seat id: 2 to 40 lowercase letters, digits or dashes.', 'error');
            return;
          }
          try {
            await H1.Api.createSeat({
              id,
              name: v('seat-name') || id,
              plan: v('seat-plan'),
              lanes: v('seat-lanes')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            });
            bootLive();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      field('seat-id', 'Seat id', 'Lowercase, used in branch names and messages.', h('input', { id: 'seat-id', required: true, value: suggested })),
      field('seat-name', 'Display name', 'Shown on the board.', h('input', { id: 'seat-name', value: (claims && (claims.name || claims.given_name)) || '' })),
      field('seat-plan', 'Claude plan', 'Shown next to your usage bar.', h('select', { id: 'seat-plan' }, ['ultra', 'max', 'pro'].map((p) => h('option', { value: p, text: p[0].toUpperCase() + p.slice(1) })))),
      field('seat-lanes', 'Lanes', 'Comma-separated, for example mobile, api.', h('input', { id: 'seat-lanes', placeholder: 'mobile, api' })),
      h('button', { class: 'btn primary', type: 'submit' }, 'Create my seat')
    );
    screen('Create your seat', [h('p', { class: 'muted', text: 'One seat per person. Your Macs and agent workers connect to it later.' }), form]);
  }

  let rt = null;

  async function bootLive() {
    try {
      const me = await H1.Api.me().catch((e) => {
        if (e.status === 404 || e.code === 'not_found' || e.code === 'forbidden') return null;
        throw e;
      });
      const seat = me && (me.seat || (me.id ? me : null));
      if (!seat) {
        seatScreen(H1.Auth.claims());
        return;
      }
      S.data.me = seat;
      S.selectedProjectId = pref('project', null) || (seat.projects || [])[0] || null;
      await loadBoard();
      S.historyLoading = true;
      await loadHistory();
      S.historyLoading = false;
      H1.Api.release()
        .then((r) => ((S.data.release = (r && r.release) || null), render()))
        .catch(() => null);
      refreshTokens()
        .then(render)
        .catch(() => null);
      handleHash();
      if (rt) rt.stop();
      rt = new H1.Realtime({
        httpHost: S.config.events.httpHost,
        realtimeUrl: S.config.events.realtimeUrl,
        channels: ['/h1/all', '/h1/p/*', '/h1/s/' + seat.id],
        getToken: () => H1.Auth.idToken(),
        onEvent: onEnvelope,
        onStatus: (s) => {
          S.conn = s;
          const c = root.querySelector('.conn');
          if (c) render();
        },
        catchUp,
      });
      rt.start();
    } catch (e) {
      if (e.status === 401) signInScreen('Your session expired. Sign in again.');
      else if (console && console.error) console.error(e);
      if (e.status !== 401) screen('The board could not load', [h('p', { class: 'muted', text: e.message }), h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again')]);
    }
  }

  async function startLive(config) {
    S.mode = 'live';
    S.conn = 'connecting';
    S.config = config;
    S.data = emptyData();
    H1.Auth.init(config);
    H1.Api.init(config);
    try {
      const restoreHash = await H1.Auth.handleCallback();
      if (restoreHash) history.replaceState(null, '', location.pathname + restoreHash);
    } catch (e) {
      signInScreen(e.message);
      return;
    }
    const token = await H1.Auth.idToken();
    if (!token) {
      signInScreen();
      return;
    }
    bootLive();
  }

  /* ---------------------------------------------------------------- tickers & boot */

  setInterval(() => {
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const t = el.querySelector('.cd-text');
      if (t) t.textContent = (el.getAttribute('data-prefix') || '') + countdownText(Number(el.getAttribute('data-deadline')));
    });
    const c = document.getElementById('clock');
    if (c) c.textContent = clockTime(Date.now());
  }, 1000);

  async function boot() {
    initPrefs();
    const params = new URLSearchParams(location.search);
    if (params.has('demo') || location.protocol === 'file:') {
      startDemo();
      return;
    }
    let config = null;
    try {
      const res = await fetch('config.json', { cache: 'no-store' });
      if (res.ok) config = await res.json();
    } catch (e) {
      config = null;
    }
    if (!config || !config.apiBase || !config.cognito) {
      startDemo();
      return;
    }
    startLive(config);
  }

  boot();
})();
