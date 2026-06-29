import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type { FeatureKey } from '@pinloom/shared';
import { useFeatures } from '../stores/uiConfig.js';

// Guards a route behind a feature flag. If the feature is disabled, a deep-link
// to its route redirects home instead of rendering a dead page (the nav entry
// is already hidden, but the URL could still be typed / bookmarked).
export function FeatureRoute({ flag, children }: { flag: FeatureKey; children: ReactNode }) {
  const features = useFeatures();
  if (!features[flag]) return <Navigate to="/" replace />;
  return <>{children}</>;
}
