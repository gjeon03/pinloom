import type { Dict } from './t.js';

// English UI strings. Keys are dotted namespaces by surface. Proper nouns
// (Wiki, Teams, Recap, …) read the same in every locale.
export const en: Dict = {
  // ── Settings shell ──
  'settings.title': 'Settings',
  'settings.close': 'Close settings',
  'settings.cat.features': 'Features & Language',
  'settings.cat.agents': 'Agents & Search',
  'settings.cat.system': 'System',
  'settings.cat.data': 'Data & Backup',
  'settings.checking': 'Checking…',
  'settings.loading': 'Loading…',

  // ── Feature settings ──
  'settings.preset': 'Preset',
  'settings.preset.desc':
    'Start point for which features are visible. Toggling anything below switches to Custom.',
  'settings.preset.simple': 'Simple',
  'settings.preset.full': 'Full',
  'settings.preset.custom': 'Custom',
  'settings.features': 'Features',
  'settings.features.desc':
    'Turning a feature off hides it everywhere. Your data is kept — turning it back on restores access.',
  'settings.group.workspace': 'Workspace',
  'settings.group.sideRail': 'Session side rail',
  'settings.group.tools': 'Tools',
  'settings.group.bots': 'Bots',
  'settings.defaults': 'Defaults',
  'settings.defaults.desc':
    'Show the per-session picker, or fix a value and hide the picker.',
  'settings.model': 'Model',
  'settings.effort': 'Effort',
  'settings.transport': 'New-session mode',
  'settings.showPicker': 'Show picker',
  'settings.fixed': 'Fixed: {value}',
  'settings.transport.terminal': 'Terminal',
  'settings.transport.sdk': 'SDK (chat)',
  'settings.language': 'Language',
  'settings.agentClis': 'Agent CLIs',

  // Feature display names (proper nouns — identical across locales).
  'feature.teams': 'Teams',
  'feature.wiki': 'Wiki',
  'feature.timeline': 'Timeline',
  'feature.recap': 'Recap',
  'feature.history': 'History',
  'feature.pins': 'Pins',
  'feature.sessionWikiTab': 'Session Wiki tab',
  'feature.globalSearch': 'Global search (⌘K)',
  'feature.templates': 'Prompt templates',
  'feature.notepad': 'Notepad',
  'feature.scheduleBot': 'Schedule bot',
  'feature.skillBot': 'Skill bot',

  // ── Sidebar nav ──
  'nav.settings': 'Settings',

  // ── App top-right cluster (tooltips) + home ──
  'app.search': 'Search history (⌘K)',
  'app.templates': 'Prompt templates',
  'app.scheduleBot': 'Schedule bot',
  'app.skillBot': 'Skill bot',
  'app.home': 'Select a project from the sidebar or click + to create one.',
};
