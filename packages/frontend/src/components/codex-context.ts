import type { CodexContextState } from '@pinloom/shared';

export type CodexContextSeverity =
  | 'unavailable'
  | 'normal'
  | 'elevated'
  | 'critical';

export type CodexContextGuidance = 'auto' | 'fallback' | 'recommended';

export type CodexContextActionEmphasis = 'secondary' | 'recommended' | null;

export interface CodexContextPresentation {
  readonly guidance: CodexContextGuidance;
  readonly guidanceKey:
    | 'cmp.codexContext.guidance.auto'
    | 'cmp.codexContext.guidance.fallback'
    | 'cmp.codexContext.guidance.recommended';
  readonly actionEmphasis: CodexContextActionEmphasis;
  readonly showConfirmation: boolean;
  readonly showObservedCompactions: boolean;
  readonly showPostCompactionBaseline: boolean;
}

export type CodexCollapsedIndicator = 'elevated' | 'critical' | null;

export type CodexConfirmationFocusTarget =
  | 'confirm'
  | 'continue'
  | 'context'
  | null;

export function getCodexConfirmationFocusTarget(
  confirming: boolean,
  rollingOver: boolean,
  returnFocusToContinue: boolean,
  rolloverEligible = true,
): CodexConfirmationFocusTarget {
  if (confirming) return rollingOver ? null : 'confirm';
  if (!returnFocusToContinue) return null;
  return rolloverEligible ? 'continue' : 'context';
}

export interface CodexContextPanelState {
  context: CodexContextState;
  loadError: string | null;
  actionError: string | null;
}

export type CodexContextPanelAction =
  | { type: 'reset'; sessionId: string }
  | { type: 'load_failed'; message: string }
  | { type: 'context_received'; context: CodexContextState }
  | { type: 'action_error'; message: string | null };

export function createUnavailableCodexContext(
  sessionId: string,
): CodexContextState {
  return {
    sessionId,
    available: false,
    inputTokens: null,
    cachedInputTokens: null,
    contextWindowTokens: null,
    observedCompactions: 0,
    postCompactionInputTokens: null,
    rolloutBytes: null,
    updatedAt: null,
  };
}

export function createCodexContextPanelState(
  sessionId: string,
): CodexContextPanelState {
  return {
    context: createUnavailableCodexContext(sessionId),
    loadError: null,
    actionError: null,
  };
}

export function reduceCodexContextPanelState(
  state: CodexContextPanelState,
  action: CodexContextPanelAction,
): CodexContextPanelState {
  switch (action.type) {
    case 'reset':
      return createCodexContextPanelState(action.sessionId);
    case 'load_failed':
      return { ...state, loadError: action.message };
    case 'context_received':
      return { ...state, context: action.context, loadError: null };
    case 'action_error':
      return { ...state, actionError: action.message };
  }
}

export function getCodexContextPercentage(
  context: CodexContextState,
): number | null {
  if (
    context.available !== true ||
    !isNonNegativeSafeInteger(context.inputTokens) ||
    !isPositiveSafeInteger(context.contextWindowTokens)
  ) {
    return null;
  }

  return (context.inputTokens / context.contextWindowTokens) * 100;
}

const ELEVATED_PERCENTAGE = 75;
const CRITICAL_PERCENTAGE = 90;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

export function getCodexPostCompactionPercentage(
  context: CodexContextState,
): number | null {
  if (
    getCodexContextPercentage(context) === null ||
    !isPositiveSafeInteger(context.observedCompactions) ||
    !isNonNegativeSafeInteger(context.postCompactionInputTokens) ||
    !isPositiveSafeInteger(context.contextWindowTokens)
  ) {
    return null;
  }

  return (context.postCompactionInputTokens / context.contextWindowTokens) * 100;
}

export function getCodexContextGuidance(
  context: CodexContextState,
): CodexContextGuidance {
  const postCompactionPercentage = getCodexPostCompactionPercentage(context);
  if (
    postCompactionPercentage !== null &&
    postCompactionPercentage >= ELEVATED_PERCENTAGE
  ) {
    return 'recommended';
  }

  const currentPercentage = getCodexContextPercentage(context);
  if (currentPercentage !== null && currentPercentage >= CRITICAL_PERCENTAGE) {
    return 'fallback';
  }
  return 'auto';
}

export function getCodexContextPresentation(
  context: CodexContextState,
  confirming: boolean,
  rollingOver: boolean,
): CodexContextPresentation {
  const guidance = getCodexContextGuidance(context);
  return {
    guidance,
    guidanceKey: `cmp.codexContext.guidance.${guidance}`,
    actionEmphasis:
      guidance === 'recommended'
        ? 'recommended'
        : guidance === 'fallback'
          ? 'secondary'
          : null,
    showConfirmation: confirming || rollingOver,
    showObservedCompactions: isPositiveSafeInteger(context.observedCompactions),
    showPostCompactionBaseline:
      getCodexPostCompactionPercentage(context) !== null,
  };
}

export function getCodexContextSeverity(
  context: CodexContextState,
): CodexContextSeverity {
  const percentage = getCodexContextPercentage(context);
  if (percentage === null) return 'unavailable';
  if (percentage >= CRITICAL_PERCENTAGE) return 'critical';
  if (percentage >= ELEVATED_PERCENTAGE) return 'elevated';
  return 'normal';
}

export function getCodexCollapsedIndicator(
  context: CodexContextState,
  contextEnabled: boolean,
): CodexCollapsedIndicator {
  if (!contextEnabled) return null;
  const severity = getCodexContextSeverity(context);
  return severity === 'elevated' || severity === 'critical' ? severity : null;
}

function compact(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${compact(value / 1_000_000)}m`;
  if (absolute >= 1_000) return `${compact(value / 1_000)}k`;
  return String(Math.round(value));
}
