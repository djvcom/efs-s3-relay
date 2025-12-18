import { type Span, SpanKind, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';

import { SERVICE_VERSION } from '../constants';
import { recordSpanError } from '../utils/errors';

export type SpanAttributes = Record<string, string | number | boolean>;

export interface SpanOptions {
	readonly kind?: SpanKind;
	readonly attributes?: SpanAttributes | undefined;
}

const tracerCache = new Map<string, Tracer>();

function getOrCreateTracer(tracerName: string): Tracer {
	let tracer = tracerCache.get(tracerName);
	if (!tracer) {
		tracer = trace.getTracer(tracerName, SERVICE_VERSION);
		tracerCache.set(tracerName, tracer);
	}
	return tracer;
}

export async function withSpan<T>(
	tracerName: string,
	spanName: string,
	operation: (span: Span) => Promise<T>,
	options?: SpanOptions,
): Promise<T> {
	const tracer = getOrCreateTracer(tracerName);
	const kind = options?.kind ?? SpanKind.INTERNAL;

	return tracer.startActiveSpan(spanName, { kind }, async span => {
		if (options?.attributes) {
			for (const [key, value] of Object.entries(options.attributes)) {
				span.setAttribute(key, value);
			}
		}

		try {
			const result = await operation(span);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			recordSpanError(span, error);
			throw error;
		} finally {
			span.end();
		}
	});
}

export function withClientSpan<T>(
	tracerName: string,
	spanName: string,
	operation: (span: Span) => Promise<T>,
	attributes?: SpanAttributes,
): Promise<T> {
	return withSpan(tracerName, spanName, operation, { kind: SpanKind.CLIENT, attributes });
}

export function withServerSpan<T>(
	tracerName: string,
	spanName: string,
	operation: (span: Span) => Promise<T>,
	attributes?: SpanAttributes,
): Promise<T> {
	return withSpan(tracerName, spanName, operation, { kind: SpanKind.SERVER, attributes });
}
