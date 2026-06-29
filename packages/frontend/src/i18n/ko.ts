import type { Dict } from './t.js';

// Korean UI strings. Feature/proper-noun names stay English (matching en);
// labels, descriptions, and tooltips are translated.
export const ko: Dict = {
  // ── Settings shell ──
  'settings.title': '설정',
  'settings.close': '설정 닫기',
  'settings.cat.features': '기능 및 언어',
  'settings.cat.agents': '에이전트 및 검색',
  'settings.cat.system': '시스템',
  'settings.cat.data': '데이터 및 백업',
  'settings.checking': '확인 중…',
  'settings.loading': '불러오는 중…',

  // ── Feature settings ──
  'settings.preset': '프리셋',
  'settings.preset.desc':
    '어떤 기능을 보여줄지 시작점. 아래에서 무엇이든 바꾸면 Custom으로 전환됩니다.',
  'settings.preset.simple': 'Simple',
  'settings.preset.full': 'Full',
  'settings.preset.custom': 'Custom',
  'settings.features': '기능',
  'settings.features.desc':
    '기능을 끄면 어디서도 안 보입니다. 데이터는 보존되며, 다시 켜면 복원됩니다.',
  'settings.group.workspace': '워크스페이스',
  'settings.group.sideRail': '세션 사이드 레일',
  'settings.group.tools': '도구',
  'settings.group.bots': '봇',
  'settings.defaults': '기본값',
  'settings.defaults.desc':
    '세션별 피커를 보여주거나, 값을 고정하고 피커를 숨깁니다.',
  'settings.model': '모델',
  'settings.effort': 'Effort',
  'settings.transport': '새 세션 모드',
  'settings.showPicker': '피커 표시',
  'settings.fixed': '고정: {value}',
  'settings.transport.terminal': 'Terminal',
  'settings.transport.sdk': 'SDK (채팅)',
  'settings.language': '언어',
  'settings.agentClis': '에이전트 CLI',

  // Feature display names — English 유지(고유명사).
  'feature.teams': 'Teams',
  'feature.wiki': 'Wiki',
  'feature.timeline': 'Timeline',
  'feature.recap': 'Recap',
  'feature.history': 'History',
  'feature.pins': 'Pins',
  'feature.sessionWikiTab': 'Session Wiki 탭',
  'feature.globalSearch': '전체 검색 (⌘K)',
  'feature.templates': '프롬프트 템플릿',
  'feature.notepad': 'Notepad',
  'feature.scheduleBot': 'Schedule bot',
  'feature.skillBot': 'Skill bot',

  // ── Sidebar nav ──
  'nav.settings': '설정',

  // ── App top-right cluster (tooltips) + home ──
  'app.search': '히스토리 검색 (⌘K)',
  'app.templates': '프롬프트 템플릿',
  'app.scheduleBot': 'Schedule bot',
  'app.skillBot': 'Skill bot',
  'app.home': '왼쪽에서 프로젝트를 선택하거나 + 를 눌러 새로 만드세요.',
};
