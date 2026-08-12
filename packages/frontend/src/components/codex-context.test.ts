import { describe, expect, it } from 'vitest';
import type { CodexContextState } from '@pinloom/shared';
import {
  createCodexContextPanelState,
  formatTokenCount,
  getCodexCollapsedIndicator,
  getCodexConfirmationFocusTarget,
  getCodexContextGuidance,
  getCodexContextPercentage,
  getCodexContextPresentation,
  getCodexContextSeverity,
  getCodexPostCompactionPercentage,
  reduceCodexContextPanelState,
} from './codex-context.js';

function state(
  inputTokens: number | null,
  contextWindowTokens: number | null,
  available = true,
  overrides: Partial<CodexContextState> = {},
): CodexContextState {
  return {
    sessionId: 'session-1',
    available,
    inputTokens,
    cachedInputTokens: null,
    contextWindowTokens,
    observedCompactions: 0,
    postCompactionInputTokens: null,
    rolloutBytes: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('getCodexContextSeverity', () => {
  it('uses the exact elevated and critical boundaries', () => {
    expect(getCodexContextSeverity(state(749, 1_000))).toBe('normal');
    expect(getCodexContextSeverity(state(750, 1_000))).toBe('elevated');
    expect(getCodexContextSeverity(state(899, 1_000))).toBe('elevated');
    expect(getCodexContextSeverity(state(900, 1_000))).toBe('critical');
  });

  it.each([
    ['unavailable', state(10, 100, false)],
    ['null input', state(null, 100)],
    ['negative input', state(-1, 100)],
    ['decimal input', state(1.5, 100)],
    ['unsafe input', state(Number.MAX_SAFE_INTEGER + 1, 100)],
    ['NaN input', state(Number.NaN, 100)],
    ['infinite input', state(Number.POSITIVE_INFINITY, 100)],
    ['null window', state(10, null)],
    ['zero window', state(10, 0)],
    ['negative window', state(10, -1)],
    ['decimal window', state(10, 100.5)],
    ['unsafe window', state(10, Number.MAX_SAFE_INTEGER + 1)],
    ['NaN window', state(10, Number.NaN)],
    ['infinite window', state(10, Number.POSITIVE_INFINITY)],
  ])('is unavailable for %s telemetry', (_label, context) => {
    expect(getCodexContextPercentage(context)).toBeNull();
    expect(getCodexContextSeverity(context)).toBe('unavailable');
  });
});

describe('getCodexContextPercentage', () => {
  it('keeps over-window observations visible', () => {
    expect(getCodexContextPercentage(state(125, 100))).toBe(125);
  });
});

describe('getCodexPostCompactionPercentage', () => {
  it('uses exact baseline boundaries and keeps over-window observations', () => {
    expect(
      getCodexPostCompactionPercentage(
        state(500, 1_000, true, {
          observedCompactions: 1,
          postCompactionInputTokens: 749,
        }),
      ),
    ).toBe(74.9);
    expect(
      getCodexPostCompactionPercentage(
        state(500, 1_000, true, {
          observedCompactions: 1,
          postCompactionInputTokens: 750,
        }),
      ),
    ).toBe(75);
    expect(
      getCodexPostCompactionPercentage(
        state(500, 1_000, true, {
          observedCompactions: 2,
          postCompactionInputTokens: 1_250,
        }),
      ),
    ).toBe(125);
  });

  it.each([
    ['zero count', { observedCompactions: 0, postCompactionInputTokens: 800 }],
    ['negative count', { observedCompactions: -1, postCompactionInputTokens: 800 }],
    ['decimal count', { observedCompactions: 1.5, postCompactionInputTokens: 800 }],
    [
      'unsafe count',
      {
        observedCompactions: Number.MAX_SAFE_INTEGER + 1,
        postCompactionInputTokens: 800,
      },
    ],
    ['NaN count', { observedCompactions: Number.NaN, postCompactionInputTokens: 800 }],
    [
      'infinite count',
      { observedCompactions: Number.POSITIVE_INFINITY, postCompactionInputTokens: 800 },
    ],
    ['null baseline', { observedCompactions: 1, postCompactionInputTokens: null }],
    ['negative baseline', { observedCompactions: 1, postCompactionInputTokens: -1 }],
    ['decimal baseline', { observedCompactions: 1, postCompactionInputTokens: 1.5 }],
    [
      'unsafe baseline',
      {
        observedCompactions: 1,
        postCompactionInputTokens: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    ['NaN baseline', { observedCompactions: 1, postCompactionInputTokens: Number.NaN }],
    [
      'infinite baseline',
      { observedCompactions: 1, postCompactionInputTokens: Number.POSITIVE_INFINITY },
    ],
  ])('rejects %s', (_label, overrides) => {
    expect(
      getCodexPostCompactionPercentage(state(500, 1_000, true, overrides)),
    ).toBeNull();
  });

  it('requires valid current telemetry even with a populated baseline', () => {
    expect(
      getCodexPostCompactionPercentage(
        state(500, 1_000, false, {
          observedCompactions: 1,
          postCompactionInputTokens: 800,
        }),
      ),
    ).toBeNull();
  });
});

describe('getCodexContextGuidance', () => {
  it('recommends rollover when the valid post-compaction baseline is at least 75%', () => {
    expect(
      getCodexContextGuidance(
        state(700, 1_000, true, {
          observedCompactions: 1,
          postCompactionInputTokens: 750,
        }),
      ),
    ).toBe('recommended');
  });

  it('gives a valid high baseline precedence over critical current usage', () => {
    expect(
      getCodexContextGuidance(
        state(900, 1_000, true, {
          observedCompactions: 1,
          postCompactionInputTokens: 800,
        }),
      ),
    ).toBe('recommended');
  });

  it('falls back at critical current usage when no recommendation applies', () => {
    expect(getCodexContextGuidance(state(900, 1_000))).toBe('fallback');
    expect(
      getCodexContextGuidance(
        state(900, 1_000, true, {
          observedCompactions: 1,
          postCompactionInputTokens: 749,
        }),
      ),
    ).toBe('fallback');
  });

  it('keeps ordinary elevated and invalid telemetry on automatic management', () => {
    expect(getCodexContextGuidance(state(899, 1_000))).toBe('auto');
    expect(getCodexContextGuidance(state(900, 1_000, false))).toBe('auto');
  });

  it('ignores an invalid auxiliary baseline without invalidating critical current telemetry', () => {
    expect(
      getCodexContextGuidance(
        state(900, 1_000, true, {
          observedCompactions: 1,
          postCompactionInputTokens: -1,
        }),
      ),
    ).toBe('fallback');
  });
});

describe('getCodexContextPresentation', () => {
  it('maps automatic management to guidance without a rollover action', () => {
    expect(getCodexContextPresentation(state(800, 1_000), false, false)).toMatchObject({
      guidance: 'auto',
      guidanceKey: 'cmp.codexContext.guidance.auto',
      actionEmphasis: null,
      showConfirmation: false,
    });
  });

  it('maps fallback and recommendation to distinct guidance and emphasis', () => {
    expect(getCodexContextPresentation(state(900, 1_000), false, false)).toMatchObject({
      guidance: 'fallback',
      guidanceKey: 'cmp.codexContext.guidance.fallback',
      actionEmphasis: 'secondary',
    });
    expect(
      getCodexContextPresentation(
        state(800, 1_000, true, {
          observedCompactions: 1,
          postCompactionInputTokens: 750,
        }),
        false,
        false,
      ),
    ).toMatchObject({
      guidance: 'recommended',
      guidanceKey: 'cmp.codexContext.guidance.recommended',
      actionEmphasis: 'recommended',
    });
  });

  it('keeps confirmation latched while open or in flight despite automatic guidance', () => {
    expect(getCodexContextPresentation(state(500, 1_000), true, false).showConfirmation).toBe(
      true,
    );
    expect(getCodexContextPresentation(state(500, 1_000), false, true).showConfirmation).toBe(
      true,
    );
    expect(getCodexContextPresentation(state(500, 1_000), false, false).showConfirmation).toBe(
      false,
    );
  });

  it.each([
    ['zero', 0, false],
    ['negative', -1, false],
    ['decimal', 1.5, false],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1, false],
    ['positive', 1, true],
  ])('shows observed compaction text only for a %s safe-integer count', (_label, count, shown) => {
    expect(
      getCodexContextPresentation(
        state(500, 1_000, true, { observedCompactions: count }),
        false,
        false,
      ).showObservedCompactions,
    ).toBe(shown);
  });
});

describe('getCodexCollapsedIndicator', () => {
  it('returns only elevated and critical indicators when Codex context is enabled', () => {
    expect(getCodexCollapsedIndicator(state(749, 1_000), true)).toBeNull();
    expect(getCodexCollapsedIndicator(state(750, 1_000), true)).toBe('elevated');
    expect(getCodexCollapsedIndicator(state(900, 1_000), true)).toBe('critical');
    expect(getCodexCollapsedIndicator(state(900, 1_000), false)).toBeNull();
    expect(getCodexCollapsedIndicator(state(900, 1_000, false), true)).toBeNull();
  });
});

describe('formatTokenCount', () => {
  it('formats token counts compactly with at most one decimal', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1_000)).toBe('1k');
    expect(formatTokenCount(258_400)).toBe('258.4k');
    expect(formatTokenCount(1_500_000)).toBe('1.5m');
  });
});

describe('reduceCodexContextPanelState', () => {
  it('clears a failed initial load after a valid WebSocket observation', () => {
    const failed = reduceCodexContextPanelState(
      createCodexContextPanelState('session-1'),
      { type: 'load_failed', message: 'GET failed' },
    );
    const observed = reduceCodexContextPanelState(failed, {
      type: 'context_received',
      context: state(80, 100),
    });

    expect(failed.loadError).toBe('GET failed');
    expect(observed.loadError).toBeNull();
    expect(observed.context.inputTokens).toBe(80);
  });

  it('clears only the load error after reconnect hydration succeeds', () => {
    const actionFailed = reduceCodexContextPanelState(
      createCodexContextPanelState('session-1'),
      { type: 'action_error', message: 'Rollover failed' },
    );
    const loadFailed = reduceCodexContextPanelState(actionFailed, {
      type: 'load_failed',
      message: 'Reconnect GET failed',
    });
    const rehydrated = reduceCodexContextPanelState(loadFailed, {
      type: 'context_received',
      context: state(45, 100),
    });

    expect(rehydrated.loadError).toBeNull();
    expect(rehydrated.actionError).toBe('Rollover failed');
    expect(rehydrated.context.inputTokens).toBe(45);
  });
});

describe('getCodexConfirmationFocusTarget', () => {
  it('focuses confirm on entry and again after a failed request re-enables it', () => {
    expect(getCodexConfirmationFocusTarget(true, false, false)).toBe('confirm');
    expect(getCodexConfirmationFocusTarget(true, true, false)).toBeNull();
    expect(getCodexConfirmationFocusTarget(true, false, false)).toBe('confirm');
  });

  it('returns focus to the eligible CTA or stable context section after cancellation', () => {
    expect(getCodexConfirmationFocusTarget(false, false, true, true)).toBe('continue');
    expect(getCodexConfirmationFocusTarget(false, false, true, false)).toBe('context');
    expect(getCodexConfirmationFocusTarget(false, false, false)).toBeNull();
  });
});
