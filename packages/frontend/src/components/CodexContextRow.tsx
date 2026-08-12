import { useEffect, useId, useRef, useState } from 'react';
import type { CodexContextState, Session } from '@pinloom/shared';
import { api } from '../api/client.js';
import { useT } from '../i18n/t.js';
import {
  formatTokenCount,
  getCodexConfirmationFocusTarget,
  getCodexContextPercentage,
  getCodexContextPresentation,
  getCodexContextSeverity,
} from './codex-context.js';

export interface CodexContextRowProps {
  sessionId: string;
  context: CodexContextState;
  onHandoff?: (session: Session) => void;
  onError: (message: string | null) => void;
}

const SEVERITY_CLASS = {
  unavailable: 'border-[var(--color-border)] bg-[var(--color-surface-2)]/50',
  normal: 'border-[var(--color-border)] bg-[var(--color-surface-2)]/50',
  elevated: 'border-[var(--color-tool-border)] bg-[var(--color-tool-bg)]',
  critical: 'border-[var(--color-error-border)] bg-[var(--color-error-bg)]',
} as const;

const SEVERITY_TEXT_CLASS = {
  unavailable: 'text-[var(--color-ink-muted)]',
  normal: 'text-[var(--color-ink)]',
  elevated: 'text-[var(--color-tool-ink)]',
  critical: 'text-[var(--color-error-ink)]',
} as const;

const ACTION_CLASS = {
  secondary:
    'border border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]',
  recommended:
    'border border-[var(--color-accent)] bg-[var(--color-accent)] text-black hover:brightness-110',
} as const;

export function CodexContextRow({
  sessionId,
  context,
  onHandoff,
  onError,
}: CodexContextRowProps) {
  const t = useT();
  const translationRef = useRef(t);
  translationRef.current = t;
  const [confirming, setConfirming] = useState(false);
  const [rollingOver, setRollingOver] = useState(false);
  const rollingOverRef = useRef(false);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const contextSectionRef = useRef<HTMLElement>(null);
  const returnFocusAfterCancelRef = useRef(false);
  const previousConfirmingRef = useRef(false);
  const previousRollingOverRef = useRef(false);
  const checkpointDescriptionId = useId();
  const severity = getCodexContextSeverity(context);
  const percentage = getCodexContextPercentage(context);
  const presentation = getCodexContextPresentation(
    context,
    confirming,
    rollingOver,
  );
  const rolloverEligible = presentation.actionEmphasis !== null;

  useEffect(() => {
    const enteredConfirmation = confirming && !previousConfirmingRef.current;
    const requestFinished =
      confirming && previousRollingOverRef.current && !rollingOver;
    const cancelled =
      !confirming &&
      previousConfirmingRef.current &&
      returnFocusAfterCancelRef.current;
    previousConfirmingRef.current = confirming;
    previousRollingOverRef.current = rollingOver;

    const target =
      enteredConfirmation || requestFinished
        ? getCodexConfirmationFocusTarget(true, rollingOver, false, rolloverEligible)
        : cancelled
          ? getCodexConfirmationFocusTarget(
              false,
              rollingOver,
              true,
              rolloverEligible,
            )
          : null;
    if (target === 'confirm') {
      confirmButtonRef.current?.focus();
    } else if (target === 'continue' && continueButtonRef.current) {
      returnFocusAfterCancelRef.current = false;
      continueButtonRef.current.focus();
    } else if (target === 'context' && contextSectionRef.current) {
      returnFocusAfterCancelRef.current = false;
      contextSectionRef.current.focus();
    }
  }, [confirming, rollingOver, rolloverEligible]);

  async function rollover() {
    if (rollingOverRef.current) return;
    rollingOverRef.current = true;
    setRollingOver(true);
    onError(null);
    let created: Session;
    try {
      created = await api.rolloverSession(sessionId);
    } catch (error) {
      rollingOverRef.current = false;
      setRollingOver(false);
      const message = error instanceof Error ? error.message : String(error);
      onError(
        translationRef.current('cmp.codexContext.error', { error: message }),
      );
      return;
    }
    onHandoff?.(created);
  }

  return (
    <section
      ref={contextSectionRef}
      tabIndex={-1}
      aria-label={t('cmp.codexContext.title')}
      className={`mx-2 mt-2 rounded-md border px-2.5 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${SEVERITY_CLASS[severity]}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-ink-muted)]">
          {t('cmp.codexContext.title')}
        </span>
        {percentage !== null && (
          <span className={`text-sm font-semibold tabular-nums ${SEVERITY_TEXT_CLASS[severity]}`}>
            {Math.round(percentage)}%
          </span>
        )}
      </div>

      {percentage === null || context.inputTokens === null || context.contextWindowTokens === null ? (
        <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
          {t('cmp.codexContext.unavailable')}
        </p>
      ) : (
        <p className="mt-1 text-[11px] tabular-nums text-[var(--color-ink-muted)]">
          {t('cmp.codexContext.usage', {
            used: formatTokenCount(context.inputTokens),
            window: formatTokenCount(context.contextWindowTokens),
          })}
        </p>
      )}

      {presentation.showObservedCompactions && (
        <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
          {t('cmp.codexContext.trackedCompactions', { n: context.observedCompactions })}
        </p>
      )}
      {presentation.showPostCompactionBaseline &&
        context.postCompactionInputTokens !== null && (
          <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
            {t('cmp.codexContext.postCompactionBaseline', {
              tokens: formatTokenCount(context.postCompactionInputTokens),
            })}
          </p>
        )}

      <p
        role="status"
        aria-live="polite"
        className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink)]"
      >
        {t(presentation.guidanceKey)}
      </p>

      {presentation.showConfirmation ? (
        <div className="mt-2 border-t border-[var(--color-border)]/60 pt-2">
          <p
            id={checkpointDescriptionId}
            className="text-[10px] leading-relaxed text-[var(--color-ink-muted)]"
          >
            {t('cmp.codexContext.checkpointExplanation')}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              ref={confirmButtonRef}
              type="button"
              onClick={() => void rollover()}
              disabled={rollingOver}
              aria-label={t('cmp.codexContext.confirm')}
              aria-describedby={checkpointDescriptionId}
              aria-busy={rollingOver}
              className="min-h-8 rounded bg-[var(--color-accent)] px-3 text-[10px] font-medium text-black hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {rollingOver
                ? t('cmp.codexContext.working')
                : t('cmp.codexContext.confirm')}
            </button>
            {rollingOver && (
              <span role="status" aria-live="polite" className="sr-only">
                {t('cmp.codexContext.working')}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                returnFocusAfterCancelRef.current = true;
                setConfirming(false);
              }}
              disabled={rollingOver}
              aria-label={t('cmp.codexContext.cancel')}
              className="min-h-8 rounded border border-[var(--color-border)] px-3 text-[10px] text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('cmp.codexContext.cancel')}
            </button>
          </div>
        </div>
      ) : presentation.actionEmphasis ? (
        <button
          ref={continueButtonRef}
          type="button"
          onClick={() => {
            onError(null);
            setConfirming(true);
          }}
          disabled={rollingOver}
          aria-label={t('cmp.codexContext.switchFresh')}
          className={`mt-2 min-h-8 rounded px-3 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-60 ${ACTION_CLASS[presentation.actionEmphasis]}`}
        >
          {t('cmp.codexContext.switchFresh')}
        </button>
      ) : null}
    </section>
  );
}
