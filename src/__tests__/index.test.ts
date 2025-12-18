import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { handler } from '../index';
import { ContextBuilder, ScheduledEventBuilder } from './fixtures/builders';

vi.mock('node:fs/promises', () => ({
	readdir: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
	mkdir: vi.fn(),
	stat: vi.fn(),
}));

vi.mock('../archive/extractor', () => ({
	extractZipStreaming: vi.fn(),
}));

import { extractZipStreaming } from '../archive/extractor';

async function* mockAsyncGenerator<T>(items: T[]): AsyncGenerator<T, void, unknown> {
	for (const item of items) {
		yield item;
	}
}

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

describe('handler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		s3Mock.reset();
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

	describe('successful processing', () => {
		it('processes zip files from directory', async () => {
			(readdir as Mock).mockResolvedValue(['batch-001.zip', 'batch-002.zip']);
			(extractZipStreaming as Mock).mockImplementation(() =>
				mockAsyncGenerator([
					{ name: 'txn-1.xml', content: Buffer.from('<transaction>1</transaction>') },
					{ name: 'txn-2.xml', content: Buffer.from('<transaction>2</transaction>') },
				]),
			);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.zipsProcessed).toBe(2);
			expect(result.zipsFailed).toBe(0);
			expect(result.totalFilesUploaded).toBe(4);
			expect(result.stoppedEarly).toBe(false);
		});

		it('returns empty result when no zip files to process', async () => {
			(readdir as Mock).mockResolvedValue([]);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.zipsProcessed).toBe(0);
			expect(result.zipsFailed).toBe(0);
			expect(result.totalFilesUploaded).toBe(0);
			expect(result.successes).toHaveLength(0);
			expect(result.failures).toHaveLength(0);
		});

		it('ignores non-zip files', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip', 'readme.txt', '.hidden.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{ name: 'txn.xml', content: Buffer.from('<transaction>1</transaction>') },
				]),
			);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.zipsProcessed).toBe(1);
			expect(extractZipStreaming).toHaveBeenCalledTimes(1);
		});

		it('moves zip to archive after successful processing', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{ name: 'txn.xml', content: Buffer.from('<transaction>1</transaction>') },
				]),
			);

			await handler(mockScheduledEvent, mockContext);

			expect(mkdir).toHaveBeenCalledWith('/archived', { recursive: true });
			expect(rename).toHaveBeenCalledWith('/input/batch.zip', '/archived/batch.zip');
		});

		it('returns success with file counts for successful zips', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{ name: 'txn.xml', content: Buffer.from('<transaction>1</transaction>') },
				]),
			);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.successes).toHaveLength(1);
			expect(result.successes[0]?.filesUploaded).toBe(1);
			expect(result.successes[0]?.zipPath).toBe('/input/batch.zip');
		});
	});

	describe('content filtering', () => {
		it('filters files matching filter pattern', async () => {
			const originalEnv = process.env['APP_FILTER_PATTERN'];
			process.env['APP_FILTER_PATTERN'] = '<isTest>true</isTest>';

			const { resetConfig } = await import('../config');
			resetConfig();

			vi.resetModules();
			const { handler: freshHandler } = await import('../index');

			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{
						name: 'prod.xml',
						content: Buffer.from('<transaction><isTest>false</isTest></transaction>'),
					},
					{
						name: 'test.xml',
						content: Buffer.from('<transaction><isTest>true</isTest></transaction>'),
					},
				]),
			);

			const result = await freshHandler(mockScheduledEvent, mockContext);

			expect(result.totalFilesUploaded).toBe(1);
			expect(result.totalFilesFiltered).toBe(1);

			process.env['APP_FILTER_PATTERN'] = originalEnv;
		});
	});

	describe('partial failure handling', () => {
		it('continues processing when zip extraction fails', async () => {
			(readdir as Mock).mockResolvedValue(['good.zip', 'bad.zip', 'good2.zip']);
			(extractZipStreaming as Mock)
				.mockReturnValueOnce(
					mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
				)
				.mockReturnValueOnce(mockFailingGenerator(new Error('Corrupt zip file')))
				.mockReturnValueOnce(
					mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>2</txn>') }]),
				);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.zipsProcessed).toBe(2);
			expect(result.zipsFailed).toBe(1);
			expect(result.successes).toHaveLength(2);
			expect(result.failures).toHaveLength(1);
		});

		it('moves failed zip to failed directory', async () => {
			(readdir as Mock).mockResolvedValue(['bad.zip']);
			(extractZipStreaming as Mock).mockReturnValue(mockFailingGenerator(new Error('Corrupt zip')));

			await handler(mockScheduledEvent, mockContext);

			expect(mkdir).toHaveBeenCalledWith('/failed', { recursive: true });
			expect(rename).toHaveBeenCalledWith('/input/bad.zip', '/failed/bad.zip');
		});

		it('continues processing when S3 upload fails', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{ name: 'txn-1.xml', content: Buffer.from('<txn>1</txn>') },
					{ name: 'txn-2.xml', content: Buffer.from('<txn>2</txn>') },
				]),
			);

			s3Mock
				.on(PutObjectCommand)
				.rejectsOnce(new Error('Access Denied'))
				.resolvesOnce({ ETag: '"abc123"' });

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.totalFilesUploaded).toBe(1);
			expect(result.zipsFailed).toBe(1);
		});

		it('moves zip to failed directory on partial upload failure', async () => {
			(readdir as Mock).mockResolvedValue(['partial.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{ name: 'txn-1.xml', content: Buffer.from('<txn>1</txn>') },
					{ name: 'txn-2.xml', content: Buffer.from('<txn>2</txn>') },
				]),
			);

			s3Mock
				.on(PutObjectCommand)
				.rejectsOnce(new Error('Rate limited'))
				.resolvesOnce({ ETag: '"ok"' });

			await handler(mockScheduledEvent, mockContext);

			expect(mkdir).toHaveBeenCalledWith('/failed', { recursive: true });
			expect(rename).toHaveBeenCalledWith('/input/partial.zip', '/failed/partial.zip');
			expect(rename).not.toHaveBeenCalledWith('/input/partial.zip', '/archived/partial.zip');
		});

		it('returns failure with error for failed zips', async () => {
			(readdir as Mock).mockResolvedValue(['bad.zip']);
			(extractZipStreaming as Mock).mockReturnValue(mockFailingGenerator(new Error('Corrupt zip')));

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.failures).toHaveLength(1);
			expect(result.failures[0]?.error.message).toContain('Failed to extract zip file');
			expect(result.failures[0]?.zipPath).toBe('/input/bad.zip');
		});
	});

	describe('timeout handling', () => {
		it('stops processing when timeout approaches', async () => {
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

			const result = await handler(mockScheduledEvent, contextWithTimeout);

			expect(result.stoppedEarly).toBe(true);
			expect(result.zipsProcessed).toBeLessThan(zipFiles.length);
		});
	});

	describe('batch size limiting', () => {
		it('limits zips processed per invocation', async () => {
			const zipFiles = Array.from({ length: 1500 }, (_, i) => `batch-${i}.zip`);
			(readdir as Mock).mockResolvedValue(zipFiles);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
			);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.successes.length + result.failures.length).toBe(1000);
		});
	});

	describe('error handling', () => {
		it('returns failure when directory listing fails', async () => {
			const error = new Error('ENOENT: no such file or directory');
			(readdir as Mock).mockRejectedValue(error);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.zipsFailed).toBe(1);
			expect(result.failures).toHaveLength(1);
			expect(result.failures[0]?.error.message).toContain('Failed to list directory');
		});
	});

	describe('file age filtering', () => {
		it('skips files younger than MIN_FILE_AGE_MS', async () => {
			(stat as Mock).mockResolvedValue({ mtimeMs: Date.now() - 5_000 });
			(readdir as Mock).mockResolvedValue(['new-file.zip', 'old-file.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
			);

			const originalEnv = process.env['APP_MIN_FILE_AGE_MS'];
			process.env['APP_MIN_FILE_AGE_MS'] = '10000';

			const { resetConfig } = await import('../config');
			resetConfig();
			vi.resetModules();

			const { handler: freshHandler } = await import('../index');

			(stat as Mock)
				.mockResolvedValueOnce({ mtimeMs: Date.now() - 5_000 })
				.mockResolvedValueOnce({ mtimeMs: Date.now() - 15_000 });

			const result = await freshHandler(mockScheduledEvent, mockContext);

			expect(result.zipsProcessed).toBe(1);
			expect(extractZipStreaming).toHaveBeenCalledTimes(1);

			process.env['APP_MIN_FILE_AGE_MS'] = originalEnv;
		});

		it('includes file when stat fails (conservative approach)', async () => {
			(readdir as Mock).mockResolvedValue(['unknown.zip']);
			(stat as Mock).mockRejectedValue(new Error('ENOENT'));
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
			);

			const originalEnv = process.env['APP_MIN_FILE_AGE_MS'];
			process.env['APP_MIN_FILE_AGE_MS'] = '10000';

			const { resetConfig } = await import('../config');
			resetConfig();
			vi.resetModules();

			const { handler: freshHandler } = await import('../index');

			const result = await freshHandler(mockScheduledEvent, mockContext);

			expect(result.zipsProcessed).toBe(1);

			process.env['APP_MIN_FILE_AGE_MS'] = originalEnv;
		});

		it('processes all files when MIN_FILE_AGE_MS is zero', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') }]),
			);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(stat).toHaveBeenCalled();
			expect(result.zipsProcessed).toBe(1);
		});
	});

	describe('filename collision handling', () => {
		it('handles duplicate filenames by appending UUID suffix', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{
						name: 'transaction.xml',
						content: Buffer.from(
							'<Transaction><TransactionId>TXN-001</TransactionId></Transaction>',
						),
					},
					{
						name: 'transaction.xml',
						content: Buffer.from(
							'<Transaction><TransactionId>TXN-002</TransactionId></Transaction>',
						),
					},
				]),
			);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.totalFilesUploaded).toBe(2);
			expect(result.zipsProcessed).toBe(1);

			const putCalls = s3Mock.commandCalls(PutObjectCommand);
			expect(putCalls).toHaveLength(2);

			const keys = putCalls.map(call => call.args[0].input.Key as string);
			const filenames = keys.map(key => key.split('/').pop());

			expect(filenames[0]).toBe('transaction.xml');
			expect(filenames[1]).toMatch(/^transaction-[a-f0-9]{8}\.xml$/);
		});

		it('preserves extension when adding collision suffix', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{ name: 'data.xml', content: Buffer.from('<doc>1</doc>') },
					{ name: 'data.xml', content: Buffer.from('<doc>2</doc>') },
				]),
			);

			await handler(mockScheduledEvent, mockContext);

			const putCalls = s3Mock.commandCalls(PutObjectCommand);
			const keys = putCalls.map(call => call.args[0].input.Key as string);
			const filenames = keys.map(key => key.split('/').pop());

			expect(filenames[0]).toBe('data.xml');
			expect(filenames[1]).toMatch(/^data-[a-f0-9]{8}\.xml$/);
		});

		it('handles files without extensions', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{ name: 'readme', content: Buffer.from('content 1') },
					{ name: 'readme', content: Buffer.from('content 2') },
				]),
			);

			await handler(mockScheduledEvent, mockContext);

			const putCalls = s3Mock.commandCalls(PutObjectCommand);
			const keys = putCalls.map(call => call.args[0].input.Key as string);
			const filenames = keys.map(key => key.split('/').pop());

			expect(filenames[0]).toBe('readme');
			expect(filenames[1]).toMatch(/^readme-[a-f0-9]{8}$/);
		});

		it('handles multiple collisions with same name', async () => {
			(readdir as Mock).mockResolvedValue(['batch.zip']);
			(extractZipStreaming as Mock).mockReturnValue(
				mockAsyncGenerator([
					{ name: 'txn.xml', content: Buffer.from('<txn>1</txn>') },
					{ name: 'txn.xml', content: Buffer.from('<txn>2</txn>') },
					{ name: 'txn.xml', content: Buffer.from('<txn>3</txn>') },
				]),
			);

			const result = await handler(mockScheduledEvent, mockContext);

			expect(result.totalFilesUploaded).toBe(3);

			const putCalls = s3Mock.commandCalls(PutObjectCommand);
			const keys = putCalls.map(call => call.args[0].input.Key as string);
			const filenames = keys.map(key => key.split('/').pop());

			expect(filenames[0]).toBe('txn.xml');
			expect(filenames[1]).toMatch(/^txn-[a-f0-9]{8}\.xml$/);
			expect(filenames[2]).toMatch(/^txn-[a-f0-9]{8}\.xml$/);

			const uniqueFilenames = new Set(filenames);
			expect(uniqueFilenames.size).toBe(3);
		});
	});
});
