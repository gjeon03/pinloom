import { useFirstRunNeeded, setUiPreset } from '../stores/uiConfig.js';
import { useT } from '../i18n/t.js';

// One-time chooser on a fresh install: pick the Simple (minimal) or Full
// feature set. Without this a new user (colleague) would start in Full and see
// every feature — defeating the gating system's purpose. Picking either preset
// marks the config as configured, so it never shows again.
export function FirstRunChooser() {
  const needed = useFirstRunNeeded();
  const t = useT();
  if (!needed) return null;

  const card =
    'flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left hover:border-[var(--color-accent)] transition-colors';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{t('firstRun.title')}</h2>
          <p className="text-sm text-[var(--color-ink-muted)] mt-1">{t('firstRun.desc')}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button type="button" className={card} onClick={() => void setUiPreset('simple')}>
            <span className="font-semibold text-sm">{t('firstRun.simple')}</span>
            <span className="text-xs text-[var(--color-ink-muted)]">{t('firstRun.simpleDesc')}</span>
          </button>
          <button type="button" className={card} onClick={() => void setUiPreset('full')}>
            <span className="font-semibold text-sm">{t('firstRun.full')}</span>
            <span className="text-xs text-[var(--color-ink-muted)]">{t('firstRun.fullDesc')}</span>
          </button>
        </div>
        <p className="text-[11px] text-[var(--color-ink-muted)]">{t('firstRun.changeLater')}</p>
      </div>
    </div>
  );
}
