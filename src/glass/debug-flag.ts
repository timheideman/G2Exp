/**
 * Debug feature flag
 *
 * Returns true when the debug panel should be shown.
 * Enable via:
 *   - URL param: ?debug=true
 *   - localStorage: localStorage.setItem('debugPanel', 'true')
 */
export function isDebugEnabled(): boolean {
  try {
    if (new URLSearchParams(location.search).get('debug') === 'true') return true;
    return localStorage.getItem('debugPanel') === 'true';
  } catch {
    return false;
  }
}
