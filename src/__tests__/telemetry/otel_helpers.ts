import { logs } from '@opentelemetry/api-logs';
import {
	InMemoryLogRecordExporter,
	LoggerProvider,
	SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { createTestSdk, type TestSdk } from '@semantic-lambda/testing';

let testSdk: TestSdk;
let logExporter: InMemoryLogRecordExporter;
let loggerProvider: LoggerProvider;

export interface OtelTestExporters {
	readonly spans: { getFinishedSpans(): ReadableSpan[]; reset(): void };
	readonly logs: InMemoryLogRecordExporter;
}

export function setupOtelTesting(): OtelTestExporters {
	testSdk = createTestSdk({ serviceName: 'test-lambda' });

	logExporter = new InMemoryLogRecordExporter();
	loggerProvider = new LoggerProvider({
		processors: [new SimpleLogRecordProcessor(logExporter)],
	});
	logs.setGlobalLoggerProvider(loggerProvider);

	return { spans: testSdk, logs: logExporter };
}

export function getTestSdk(): TestSdk {
	return testSdk;
}

export function getExporter(): { getFinishedSpans(): ReadableSpan[]; reset(): void } {
	return testSdk;
}

export function getLogExporter(): InMemoryLogRecordExporter {
	return logExporter;
}

export async function shutdownOtelTesting(): Promise<void> {
	await testSdk.shutdown();
	await loggerProvider.shutdown();
}

export {
	assertSpanExists,
	findSpan,
	findSpans,
	getSpanAttribute,
	hasSpan,
} from '@semantic-lambda/testing';
