/**
 * This plugin's telemetry front door — a thin policy layer over the Bug
 * Collector plugin's library. Everything reusable (the @Span decorator,
 * StartActiveSpan, the active-span attribute helpers, the registration API
 * and its types) is IMPORTED from `obsidian-bug-collector`, never copied.
 *
 * What lives here is only what is specific to this plugin:
 *   - the registration call (our plugin id, version and baggage);
 *   - the failsafe policy: telemetry is the ONLY logging path, and the
 *     console is written to solely when the collector is unreachable, once
 *     per reason so a missing collector cannot spam devtools;
 *   - StatusError -> structured data (code, message, stack, full payload).
 *
 * With no Bug Collector installed every helper degrades to a no-op and the
 * plugin behaves exactly as it did before.
 */

import {None, Optional, Some} from 'standard-ts-lib/src/optional';
import {Result} from 'standard-ts-lib/src/result';
import {ErrorCode, StatusError} from 'standard-ts-lib/src/status_error';
import {WrapToResult} from 'standard-ts-lib/src/wrap_to_result';
import type {Tracer} from '@opentelemetry/api';
import {
  getBugCollectorApi,
  registerPluginTelemetry,
  type PluginTelemetryApi,
} from 'obsidian-bug-collector/src/api';
import {SetTracerScope} from 'obsidian-bug-collector/src/telemetry/tracing/span.decorator';

// Re-exported so the rest of the plugin has one telemetry import. These are
// the Bug Collector's own implementations — not copies.
export {
  Span,
  StartActiveSpan,
} from 'obsidian-bug-collector/src/telemetry/tracing/span.decorator';
export {
  setAttributeOnActiveSpan as SetSpanAttribute,
  setAttributesOnActiveSpan as SetSpanAttributes,
} from 'obsidian-bug-collector/src/telemetry/tracing/set_attributes_on_active_span';

/** The plugin id the collector attributes our telemetry to. */
export const TELEMETRY_PLUGIN_ID = 'hanzi-practice';

/** Bug Collector API versions this plugin knows how to talk to. */
export const SUPPORTED_COLLECTOR_API_VERSIONS = [3];

let handle: Optional<PluginTelemetryApi> = None;
/** Reasons already reported to the console, so each is logged at most once. */
const reportedFailsafes = new Set<string>();

/**
 * The failsafe: the ONLY place this plugin writes to the console. Each
 * distinct reason is printed once per session.
 */
function failsafe(reason: string, detail?: unknown): void {
  if (reportedFailsafes.has(reason)) return;
  reportedFailsafes.add(reason);
  console.error(
    `[${TELEMETRY_PLUGIN_ID}] telemetry unavailable: ${reason}`,
    detail ?? '',
  );
}

/**
 * Acquire the telemetry handle from the global Bug Collector API. Safe to
 * call more than once (a second call re-registers, which the collector
 * treats as a version/baggage update).
 *
 * @param pluginVersion this plugin's manifest version — becomes baggage
 * @param baggage extra context stamped onto every record we emit
 */
export function InitTelemetry(
  pluginVersion: string,
  baggage?: Record<string, string | number | boolean>,
): Optional<PluginTelemetryApi> {
  const api = getBugCollectorApi();
  if (api.none) {
    failsafe('window.bugCollector is not available (plugin not installed?)');
    handle = None;
    return None;
  }
  const apiVersion = api.safeValue().apiVersion;
  if (!SUPPORTED_COLLECTOR_API_VERSIONS.includes(apiVersion)) {
    failsafe(
      `unsupported collector apiVersion ${apiVersion} ` +
        `(expected one of ${SUPPORTED_COLLECTOR_API_VERSIONS.join(', ')})`,
    );
    handle = None;
    return None;
  }
  // register() is another plugin's code — treat it as able to throw.
  const registered = WrapToResult(
    () =>
      registerPluginTelemetry({
        pluginId: TELEMETRY_PLUGIN_ID,
        pluginVersion,
        baggage,
      }),
    /*textForUnknown=*/ 'Bug Collector register() failed',
  );
  if (registered.err) {
    failsafe('register() failed', registered.val.toString());
    handle = None;
    return None;
  }
  const result = registered.safeUnwrap();
  if (result.none) {
    failsafe('register() returned no telemetry handle');
    handle = None;
    return None;
  }
  handle = Some(result.safeValue());
  // Point the imported @Span decorator at OUR scope, so spans are attributed
  // to this plugin (and picked up by the collector's baggage stamping).
  SetTracerScope(TELEMETRY_PLUGIN_ID);
  return handle;
}

/** The live handle, or None when the collector is unavailable. */
export function GetTelemetry(): Optional<PluginTelemetryApi> {
  return handle;
}

/** Drop the handle (plugin unload / tests). */
export function ResetTelemetry(): void {
  handle = None;
  reportedFailsafes.clear();
}

/** The plugin-scoped tracer, or None when the collector is unavailable. */
export function GetTracer(): Optional<Tracer> {
  if (handle.none) return None;
  // Bind before the closure: the narrowing above does not survive into it.
  const api = handle.safeValue();
  const tracer = WrapToResult(
    () => api.getTracer(),
    /*textForUnknown=*/ 'getTracer() failed',
  );
  if (tracer.err) {
    failsafe('getTracer() failed', tracer.val.toString());
    return None;
  }
  return Some(tracer.safeUnwrap());
}

// ------------------------------------------------------------------- logs

export function Log(
  level: 'critical' | 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly',
  message: string,
  data?: Record<string, unknown>,
): void {
  if (handle.none) {
    failsafe('no telemetry handle; dropping logs');
    return;
  }
  handle.safeValue().log(level, message, data);
}

export const LogInfo = (message: string, data?: Record<string, unknown>) =>
  Log('info', message, data);
export const LogDebug = (message: string, data?: Record<string, unknown>) =>
  Log('debug', message, data);
export const LogWarn = (message: string, data?: Record<string, unknown>) =>
  Log('warn', message, data);

/**
 * Flatten a StatusError into structured log data: its gRPC code (name and
 * number), message, stack, and EVERY entry of its payload map — the whole
 * point of the payload is that it carries the context a bug report needs.
 */
export function StatusErrorToData(error: StatusError): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const entries = WrapToResult(
    () => [...error.getPayload().entries()],
    /*textForUnknown=*/ 'Failed to read StatusError payload',
  );
  if (entries.ok) {
    for (const [key, value] of entries.safeUnwrap()) {
      payload[key] = value;
    }
  }
  return {
    errorCode: ErrorCode[error.errorCode] ?? error.errorCode,
    errorCodeValue: error.errorCode,
    message: error.message,
    // StatusError keeps its stack private; toString(true) is the only way to
    // get it, and it also renders the payload — so this field is the full
    // human-readable rendering that a bug report wants verbatim.
    detail: error.toString(/*includeStack=*/ true),
    payload,
  };
}

/**
 * Report a failure with everything we know about it. `context` names the
 * operation that failed; `extra` adds call-site detail.
 */
export function LogError(
  context: string,
  error: StatusError,
  extra?: Record<string, unknown>,
): void {
  const data = {...StatusErrorToData(error), ...extra};
  if (handle.none) {
    failsafe(
      'no telemetry handle; dropping error',
      `${context}: ${error.toString()}`,
    );
    return;
  }
  handle.safeValue().log('error', context, data);
}

/**
 * Like {@link LogError} but at warn level — for failures that are expected in
 * normal operation (an optional file that does not exist yet). The full
 * StatusError payload and stack still travel with it.
 */
export function LogErrorAsWarning(
  context: string,
  error: StatusError,
  extra?: Record<string, unknown>,
): void {
  const data = {...StatusErrorToData(error), ...extra};
  if (handle.none) {
    failsafe('no telemetry handle; dropping warning', context);
    return;
  }
  handle.safeValue().log('warn', context, data);
}

/**
 * Report a failure and pass the Result through unchanged, so it can wrap a
 * call site: `const r = ReportIfErr('load', await load());`
 */
export function ReportIfErr<T>(
  context: string,
  result: Result<T, StatusError>,
  extra?: Record<string, unknown>,
): Result<T, StatusError> {
  if (result.err) {
    LogError(context, result.val, extra);
  }
  return result;
}
