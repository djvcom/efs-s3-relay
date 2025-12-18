import { logs } from '@opentelemetry/api-logs';
import { createLogger, format, transports } from 'winston';

import { SERVICE_NAME, SERVICE_VERSION } from '../constants';

/**
 * Winston logger configured for OTel integration.
 *
 * The @opentelemetry/instrumentation-winston package (loaded via Lambda layer)
 * automatically injects trace context (trace_id, span_id) into log records
 * when there's an active span, enabling log-trace correlation.
 */
export const logger = createLogger({
	level: process.env['LOG_LEVEL'] ?? 'info',
	format: format.combine(format.timestamp(), format.errors({ stack: true }), format.json()),
	defaultMeta: {
		service: SERVICE_NAME,
		version: SERVICE_VERSION,
	},
	transports: [new transports.Console()],
});

/**
 * Creates a logger adapter compatible with AWS SDK v3's Logger interface.
 * Routes SDK logs through our Winston logger for unified observability.
 */
export interface SdkLogger {
	debug: (content: object | string, ...meta: unknown[]) => void;
	info: (content: object | string, ...meta: unknown[]) => void;
	warn: (content: object | string, ...meta: unknown[]) => void;
	error: (content: object | string, ...meta: unknown[]) => void;
}

export function createSdkLogger(component: string): SdkLogger {
	const childLogger = logger.child({ component });

	return {
		debug: (content, ...meta) => childLogger.debug(formatSdkMessage(content), ...meta),
		info: (content, ...meta) => childLogger.info(formatSdkMessage(content), ...meta),
		warn: (content, ...meta) => childLogger.warn(formatSdkMessage(content), ...meta),
		error: (content, ...meta) => childLogger.error(formatSdkMessage(content), ...meta),
	};
}

function formatSdkMessage(content: object | string): string {
	if (typeof content === 'string') return content;
	return JSON.stringify(content);
}

/**
 * OTel Logger for direct OTel Logs API usage.
 * Use this when you need to emit logs directly to the OTel Logs SDK
 * (e.g., for metrics-related events or when Winston isn't appropriate).
 */
export const otelLogger = logs.getLogger(SERVICE_NAME, SERVICE_VERSION);
