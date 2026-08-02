import {InternalError, NotFoundError} from 'standard-ts-lib/src/status_error';
import {Err, Ok} from 'standard-ts-lib/src/result';
import {trace} from '@opentelemetry/api';
import {
  GetTelemetry,
  GetTracer,
  InitTelemetry,
  LogError,
  LogErrorAsWarning,
  LogInfo,
  ReportIfErr,
  ResetTelemetry,
  StatusErrorToData,
  TELEMETRY_PLUGIN_ID,
  Span,
  StartActiveSpan,
} from '../src/telemetry/telemetry';

interface LoggedRecord {
  level: string;
  message: string;
  data?: unknown;
}

/** A stand-in for the Bug Collector's PluginTelemetryApi. */
function makeFakeCollector(apiVersion = 3) {
  const logs: LoggedRecord[] = [];
  const spans: Array<{name: string; ended: boolean}> = [];
  const registrations: unknown[] = [];
  const handle = {
    pluginId: TELEMETRY_PLUGIN_ID,
    pluginVersion: '9.9.9',
    getBaggage: () => ({}),
    setBaggage: () => {},
    log: (level: string, message: string, data?: unknown) =>
      void logs.push({level, message, data}),
    getTracer: () => ({
      startActiveSpan: (name: string, fn: (span: unknown) => unknown) => {
        const record = {name, ended: false};
        spans.push(record);
        return fn({
          end: () => void (record.ended = true),
          setAttributes: () => {},
          setAttribute: () => {},
        });
      },
    }),
    getMeter: () => ({}),
    start: jest.fn(),
    restart: jest.fn(),
    end: jest.fn(),
    startGroup: jest.fn(),
    endGroup: jest.fn(),
  };
  const api = {
    apiVersion,
    register: jest.fn((config: unknown) => {
      registrations.push(config);
      return handle;
    }),
  };
  return {api, handle, logs, spans, registrations};
}

describe('InitTelemetry failsafe', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    ResetTelemetry();
    delete window.bugCollector;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    ResetTelemetry();
    delete window.bugCollector;
    jest.restoreAllMocks();
  });

  it('falls back to a single console error when the global API is absent', () => {
    const result = InitTelemetry('1.0.0');
    expect(result.some).toBe(false);
    expect(GetTelemetry().some).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]![0])).toContain(
      'window.bugCollector is not available',
    );
  });

  it('does not repeat the same failsafe reason', () => {
    InitTelemetry('1.0.0');
    LogInfo('dropped');
    LogInfo('dropped again');
    // One for the missing API, one for the first dropped log — and no more.
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it('refuses a collector whose apiVersion we do not speak', () => {
    window.bugCollector = makeFakeCollector(99).api as never;
    expect(InitTelemetry('1.0.0').some).toBe(false);
    expect(String(consoleError.mock.calls[0]![0])).toContain(
      'unsupported collector apiVersion 99',
    );
  });

  it('survives a collector whose register() throws', () => {
    window.bugCollector = {
      apiVersion: 3,
      register: () => {
        throw new Error('collector exploded');
      },
    } as never;
    expect(InitTelemetry('1.0.0').some).toBe(false);
    expect(String(consoleError.mock.calls[0]![0])).toContain(
      'register() failed',
    );
  });

  it('registers with the plugin id, version and baggage', () => {
    const fake = makeFakeCollector();
    window.bugCollector = fake.api as never;
    const result = InitTelemetry('3.5.0', {env: 'test'});
    expect(result.some).toBe(true);
    expect(fake.registrations[0]).toEqual({
      pluginId: 'hanzi-practice',
      pluginVersion: '3.5.0',
      baggage: {env: 'test'},
    });
    // A reachable collector must never write to the console.
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('logging through the collector', () => {
  let fake: ReturnType<typeof makeFakeCollector>;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    ResetTelemetry();
    fake = makeFakeCollector();
    window.bugCollector = fake.api as never;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    InitTelemetry('1.0.0');
  });

  afterEach(() => {
    ResetTelemetry();
    delete window.bugCollector;
    jest.restoreAllMocks();
  });

  it('sends info logs with their data', () => {
    LogInfo('Plugin loaded', {banks: 2});
    expect(fake.logs).toEqual([
      {level: 'info', message: 'Plugin loaded', data: {banks: 2}},
    ]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('uploads the full StatusError: code, message, stack and payload', () => {
    const error = InternalError('disk on fire')
      .setPayload('filePath', 'words.md')
      .setPayload('attempt', 3);
    LogError('Failed to write history', error, {bank: 'Hanzi'});

    expect(fake.logs).toHaveLength(1);
    const record = fake.logs[0]!;
    expect(record.level).toBe('error');
    expect(record.message).toBe('Failed to write history');
    const data = record.data as Record<string, unknown>;
    expect(data['errorCode']).toBe('INTERNAL');
    expect(data['message']).toBe('disk on fire');
    expect(data['payload']).toEqual({filePath: 'words.md', attempt: 3});
    // detail carries the rendered stack trace.
    expect(String(data['detail'])).toContain('disk on fire');
    expect(String(data['detail'])).toContain('at ');
    expect(data['bank']).toBe('Hanzi');
  });

  it('reports expected failures at warn level', () => {
    LogErrorAsWarning('Practice file missing', NotFoundError('nope'));
    expect(fake.logs[0]!.level).toBe('warn');
  });

  it('ReportIfErr forwards errors and passes results through untouched', () => {
    const ok = ReportIfErr('load', Ok(42));
    expect(ok.unwrapOr(0)).toBe(42);
    expect(fake.logs).toHaveLength(0);

    const failed = ReportIfErr('load', Err(NotFoundError('missing')));
    expect(failed.err).toBe(true);
    expect(fake.logs).toHaveLength(1);
    expect(fake.logs[0]!.message).toBe('load');
  });

  it('StatusErrorToData tolerates an empty payload', () => {
    const data = StatusErrorToData(NotFoundError('plain'));
    expect(data['payload']).toEqual({});
    expect(data['errorCode']).toBe('NOT_FOUND');
  });
});

describe('tracing (through the imported Bug Collector decorator)', () => {
  let fake: ReturnType<typeof makeFakeCollector>;
  let spans: Array<{name: string; tracer: string; ended: boolean}>;

  /**
   * The @Span decorator comes from the Bug Collector library and resolves its
   * tracer through the GLOBAL OpenTelemetry API — which is exactly how it
   * works in production, where the collector plugin registers the global
   * provider. So these tests register a recording provider globally rather
   * than stubbing our handle.
   */
  beforeEach(() => {
    ResetTelemetry();
    spans = [];
    fake = makeFakeCollector();
    window.bugCollector = fake.api as never;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    trace.setGlobalTracerProvider({
      getTracer: (tracerName: string) => ({
        startSpan: (spanName: string) => {
          const record = {name: spanName, tracer: tracerName, ended: false};
          spans.push(record);
          return {
            end: () => void (record.ended = true),
            setAttribute: () => {},
            setAttributes: () => {},
            isRecording: () => true,
            spanContext: () => ({
              traceId: 'a'.repeat(32),
              spanId: 'b'.repeat(16),
              traceFlags: 1,
            }),
          };
        },
      }),
    } as never);
    InitTelemetry('1.0.0');
  });

  afterEach(() => {
    ResetTelemetry();
    delete window.bugCollector;
    trace.disable();
    jest.restoreAllMocks();
  });

  it('attributes spans to THIS plugin (scope = hanzi-practice)', () => {
    class Loader {
      @Span()
      load(): string {
        return 'loaded';
      }
    }
    expect(new Loader().load()).toBe('loaded');
    // SetTracerScope was pointed at our plugin id during InitTelemetry, which
    // is what makes the collector stamp our baggage onto these spans.
    expect(spans[0]!.tracer).toBe('hanzi-practice');
  });

  it('@Span names spans ClassName::method', () => {
    class Loader {
      @Span()
      load(): string {
        return 'loaded';
      }
    }
    new Loader().load();
    expect(spans[0]!.name).toBe('Loader::load');
    expect(spans[0]!.ended).toBe(true);
  });

  it('@Span names STATIC method spans ClassName::method too', () => {
    class Loader {
      @Span()
      static loadAll(): string {
        return 'loaded';
      }
    }
    expect(Loader.loadAll()).toBe('loaded');
    expect(spans[0]!.name).toBe('Loader::loadAll');
  });

  it('@Span accepts an explicit span name', () => {
    class Loader {
      @Span('custom-name')
      load(): number {
        return 1;
      }
    }
    new Loader().load();
    expect(spans[0]!.name).toBe('custom-name');
  });

  it('@Span keeps an async method span open until it settles', async () => {
    let resolve: (v: string) => void = () => {};
    const pending = new Promise<string>(r => (resolve = r));
    class Loader {
      @Span()
      load(): Promise<string> {
        return pending;
      }
    }
    const result = new Loader().load();
    expect(spans[0]!.ended).toBe(false);
    resolve('done');
    await expect(result).resolves.toBe('done');
    expect(spans[0]!.ended).toBe(true);
  });

  it('StartActiveSpan runs work inside a span', () => {
    const value = StartActiveSpan('load', span => {
      span.end();
      return 7;
    });
    expect(value).toBe(7);
    expect(spans[0]!.name).toBe('load');
  });

  it('exposes the tracer', () => {
    expect(GetTracer().some).toBe(true);
  });
});

describe('tracing without a collector', () => {
  beforeEach(() => {
    ResetTelemetry();
    delete window.bugCollector;
    trace.disable();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    ResetTelemetry();
    jest.restoreAllMocks();
  });

  it('reports no tracer and still runs decorated methods untouched', () => {
    expect(GetTracer().some).toBe(false);
    class Loader {
      @Span()
      load(): number {
        return 5;
      }
    }
    expect(new Loader().load()).toBe(5);
  });
});
