import { type Span, SpanStatusCode } from '@opentelemetry/api';
import { SEMATTRS_EXCEPTION_TYPE } from '@opentelemetry/semantic-conventions';

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function getErrorType(error: unknown): string {
	if (error instanceof Error) {
		return error.name;
	}
	return typeof error;
}

export function recordSpanError(span: Span, error: unknown): void {
	const message = getErrorMessage(error);
	span.setStatus({ code: SpanStatusCode.ERROR, message });
	span.setAttribute(SEMATTRS_EXCEPTION_TYPE, getErrorType(error));
	if (error instanceof Error) {
		span.recordException(error);
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Exhaustiveness check helper for discriminated unions.
 * TypeScript will error if all cases aren't handled before this function is called.
 * Provides both compile-time and runtime safety.
 */
export function assertNever(value: never, message?: string): never {
	throw new Error(message ?? `Unexpected value: ${JSON.stringify(value)}`);
}
