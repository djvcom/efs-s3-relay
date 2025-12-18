import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SpanStatusCode } from '@opentelemetry/api';
import { mockClient } from 'aws-sdk-client-mock';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from 'vitest';

import { resetConfig } from '../../config';
import { ContextBuilder, ScheduledEventBuilder } from '../fixtures/builders';
import { getExporter, setupOtelTesting, shutdownOtelTesting } from './otel_helpers';

vi.mock('node:fs/promises', () => ({
	readdir: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
	mkdir: vi.fn(),
	stat: vi.fn(),
}));

vi.mock('../../archive/extractor', () => ({
	extractZipStreaming: vi.fn(),
}));

import { extractZipStreaming } from '../../archive/extractor';
import { handler } from '../../index';

// Helper to create an async generator from an array (for mocking streaming extraction)
async function* mockAsyncGenerator<T>(items: T[]): AsyncGenerator<T, void, unknown> {
	for (const item of items) {
		yield item;
	}
}

// Helper to create a failing async iterable
function mockFailingGenerator<T>(error: Error): AsyncGenerator<T, void, unknown> {
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next(): Promise<IteratorResult<T, void>> {
			throw error;
		},
		async return(): Promise<IteratorResult<T, void>> {
			return { done: true, value: undefined };
		},
		async throw(e: unknown): Promise<IteratorResult<T, void>> {
			throw e;
		},
	};
}

const s3Mock = mockClient(S3Client);

const mockContext = new ContextBuilder().build();
const mockScheduledEvent = new ScheduledEventBuilder().build();

describe('OpenTelemetry spans', () => {
	beforeAll(() => {
		setupOtelTesting();
	});

	afterAll(async () => {
		await shutdownOtelTesting();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		s3Mock.reset();
		resetConfig();
		getExporter().reset();

		s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
		(mkdir as Mock).mockResolvedValue(undefined);
		(rename as Mock).mockResolvedValue(undefined);
		(unlink as Mock).mockResolvedValue(undefined);
		(stat as Mock).mockResolvedValue({ mtimeMs: Date.now() - 10_000 });
	});

	afterEach(() => {
		vi.resetAllMocks();
		s3Mock.reset();
	});

	it('creates batch.process span with config attributes', async () => {
		(readdir as Mock).mockResolvedValue(['batch.zip']);
		(extractZipStreaming as Mock).mockReturnValue(
			mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
		);

		await handler(mockScheduledEvent, mockContext);

		const spans = getExporter().getFinishedSpans();
		const batchSpan = spans.find(s => s.name === 'batch.process');

		expect(batchSpan).toBeDefined();
		expect(batchSpan?.attributes['app.config.source_dir']).toBe('/input');
		expect(batchSpan?.attributes['app.config.destination_bucket']).toBe('test-bucket');
	});

	it('creates filesystem.list_zips span', async () => {
		(readdir as Mock).mockResolvedValue(['batch.zip']);
		(extractZipStreaming as Mock).mockReturnValue(
			mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
		);

		await handler(mockScheduledEvent, mockContext);

		const spans = getExporter().getFinishedSpans();
		const listSpan = spans.find(s => s.name === 'filesystem.list_zips');

		expect(listSpan).toBeDefined();
		expect(listSpan?.attributes['app.file.directory']).toBe('/input');
		expect(listSpan?.attributes['app.zip.count']).toBe(1);
	});

	it('creates zip.process span with file counts', async () => {
		(readdir as Mock).mockResolvedValue(['batch.zip']);
		(extractZipStreaming as Mock).mockReturnValue(
			mockAsyncGenerator([
				{ name: 'txn-1.xml', content: Buffer.from('<txn>1</txn>') },
				{ name: 'txn-2.xml', content: Buffer.from('<txn>2</txn>') },
			]),
		);

		await handler(mockScheduledEvent, mockContext);

		const spans = getExporter().getFinishedSpans();
		const processSpan = spans.find(s => s.name === 'zip.process');

		expect(processSpan).toBeDefined();
		expect(processSpan?.attributes['app.archive.path']).toBe('/input/batch.zip');
		expect(processSpan?.attributes['app.files.extracted']).toBe(2);
		expect(processSpan?.attributes['app.files.uploaded']).toBe(2);
		expect(processSpan?.attributes['app.files.filtered']).toBe(0);
	});

	it('creates s3.upload_batch span with batch details', async () => {
		(readdir as Mock).mockResolvedValue(['batch.zip']);
		(extractZipStreaming as Mock).mockReturnValue(
			mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
		);

		await handler(mockScheduledEvent, mockContext);

		const spans = getExporter().getFinishedSpans();
		const uploadSpan = spans.find(s => s.name === 's3.upload_batch');

		expect(uploadSpan).toBeDefined();
		expect(uploadSpan?.attributes['aws.s3.bucket']).toBe('test-bucket');
		expect(uploadSpan?.attributes['rpc.system']).toBe('aws-api');
		expect(uploadSpan?.attributes['rpc.service']).toBe('S3');
		expect(uploadSpan?.attributes['app.batch.file_count']).toBe(1);
		expect(uploadSpan?.attributes['app.batch.successful']).toBe(1);
		expect(uploadSpan?.attributes['app.batch.failed']).toBe(0);
	});

	it('sets error status on span when processing fails', async () => {
		(readdir as Mock).mockResolvedValue(['bad.zip']);
		(extractZipStreaming as Mock).mockReturnValue(mockFailingGenerator(new Error('Corrupt zip')));

		await handler(mockScheduledEvent, mockContext);

		const spans = getExporter().getFinishedSpans();
		const processSpan = spans.find(s => s.name === 'zip.process');

		expect(processSpan).toBeDefined();
		expect(processSpan?.status.code).toBe(SpanStatusCode.ERROR);
		expect(processSpan?.status.message).toContain('Failed to extract zip file');
	});

	it('records exception on span when error occurs', async () => {
		(readdir as Mock).mockResolvedValue(['bad.zip']);
		(extractZipStreaming as Mock).mockReturnValue(mockFailingGenerator(new Error('Corrupt zip')));

		await handler(mockScheduledEvent, mockContext);

		const spans = getExporter().getFinishedSpans();
		const processSpan = spans.find(s => s.name === 'zip.process');
		const events = processSpan?.events ?? [];
		const exceptionEvent = events.find(e => e.name === 'exception');

		expect(exceptionEvent).toBeDefined();
		expect(exceptionEvent?.attributes?.['exception.message']).toContain(
			'Failed to extract zip file',
		);
	});

	it('adds timeout_approaching event when stopping early', async () => {
		const zipFiles = Array.from({ length: 10 }, (_, i) => `batch-${i}.zip`);
		(readdir as Mock).mockResolvedValue(zipFiles);
		(extractZipStreaming as Mock).mockReturnValue(
			mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
		);

		let callCount = 0;
		const contextWithTimeout = new ContextBuilder().build();
		contextWithTimeout.getRemainingTimeInMillis = () => {
			callCount++;
			return callCount <= 2 ? 60_000 : 20_000;
		};

		await handler(mockScheduledEvent, contextWithTimeout);

		const spans = getExporter().getFinishedSpans();
		const batchSpan = spans.find(s => s.name === 'batch.process');
		const events = batchSpan?.events ?? [];
		const timeoutEvent = events.find(e => e.name === 'timeout_approaching');

		expect(timeoutEvent).toBeDefined();
		expect(batchSpan?.attributes['app.batch.stopped_early']).toBe(true);
	});

	it('creates all expected spans for a successful operation', async () => {
		(readdir as Mock).mockResolvedValue(['batch.zip']);
		(extractZipStreaming as Mock).mockReturnValue(
			mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
		);

		await handler(mockScheduledEvent, mockContext);

		const spans = getExporter().getFinishedSpans();
		const spanNames = spans.map(s => s.name);

		expect(spanNames).toContain('batch.process');
		expect(spanNames).toContain('filesystem.list_zips');
		expect(spanNames).toContain('zip.process');
		expect(spanNames).toContain('s3.upload_batch');
	});
});
