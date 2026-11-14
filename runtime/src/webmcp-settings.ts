/**
 * The WebMCP settings schema: defaults and validation.
 *
 * This file has no imports, so the runtime and the extension options page
 * share one validator.
 */

/** The defaults of the WebMCP settings, as in the upstream schema. */
export const WEBMCP_DEFAULTS: Record<string, unknown> = {
  tools: [],
  disabledTools: [],
  blockedCommands: ['apputils:run-all-enabled', 'apputils:run-first-enabled'],
  executionTimeout: 20,
  maxResultLength: 40000
};

/**
 * The stored values that are kept: unknown keys and values of the wrong type
 * are dropped, so a bad value falls back to the default.
 */
export function normalizeSettings(raw: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return values;
  }
  const source = raw as Record<string, unknown>;
  for (const key of ['disabledTools', 'blockedCommands'] as const) {
    if (Array.isArray(source[key])) {
      values[key] = source[key].filter(
        (item): item is string => typeof item === 'string'
      );
    }
  }
  if (Array.isArray(source.tools)) {
    values.tools = source.tools.filter(
      item => !!item && typeof item === 'object' && !Array.isArray(item)
    );
  }
  if (
    typeof source.executionTimeout === 'number' &&
    source.executionTimeout >= 0 &&
    source.executionTimeout <= 3600
  ) {
    values.executionTimeout = source.executionTimeout;
  }
  if (
    Number.isInteger(source.maxResultLength) &&
    (source.maxResultLength as number) >= 1000
  ) {
    values.maxResultLength = source.maxResultLength;
  }
  return values;
}
