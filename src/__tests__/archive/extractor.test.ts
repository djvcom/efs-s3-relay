import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractZip, extractZipStreaming } from '../../archive/extractor';
import { FilePath } from '../../types/branded';
import { getExporter, setupOtelTesting, shutdownOtelTesting } from '../telemetry/otel_helpers';

const fixturesDir = join(import.meta.dirname, '../fixtures/zips');

describe('extractor', () => {
	beforeAll(() => {
		setupOtelTesting();
	});

	afterAll(async () => {
		await shutdownOtelTesting();
	});

	describe('extractZip', () => {
		it('extracts single file from zip', async () => {
			const zipPath = FilePath(join(fixturesDir, 'valid-single.zip'));

			const files = await extractZip(zipPath);

			expect(files).toHaveLength(1);
			expect(files[0].name).toBe('txn.xml');
			expect(files[0].content.toString()).toBe('<transaction>1</transaction>');
		});

		it('extracts multiple files from zip', async () => {
			const zipPath = FilePath(join(fixturesDir, 'valid-multiple.zip'));

			const files = await extractZip(zipPath);

			expect(files).toHaveLength(3);
			expect(files.map(f => f.name).sort()).toEqual(['txn-1.xml', 'txn-2.xml', 'txn-3.xml']);
		});

		it('extracts files from nested directories', async () => {
			const zipPath = FilePath(join(fixturesDir, 'with-directories.zip'));

			const files = await extractZip(zipPath);

			expect(files).toHaveLength(2);
			const names = files.map(f => f.name).sort();
			expect(names).toContain('folder/nested.xml');
			expect(names).toContain('root.xml');
		});

		it('skips directory entries', async () => {
			const zipPath = FilePath(join(fixturesDir, 'with-directories.zip'));

			const files = await extractZip(zipPath);

			const directoryEntries = files.filter(f => f.name.endsWith('/'));
			expect(directoryEntries).toHaveLength(0);
		});

		it('returns empty array for empty zip', async () => {
			const zipPath = FilePath(join(fixturesDir, 'empty.zip'));

			const files = await extractZip(zipPath);

			expect(files).toEqual([]);
		});

		it('throws error for corrupt zip', async () => {
			const zipPath = FilePath(join(fixturesDir, 'corrupt.zip'));

			await expect(extractZip(zipPath)).rejects.toThrow();
		});

		it('throws error for non-existent file', async () => {
			const zipPath = FilePath(join(fixturesDir, 'does-not-exist.zip'));

			await expect(extractZip(zipPath)).rejects.toThrow('Corrupt or invalid zip file');
		});

		it('preserves binary content correctly', async () => {
			const zipPath = FilePath(join(fixturesDir, 'valid-single.zip'));

			const files = await extractZip(zipPath);

			expect(Buffer.isBuffer(files[0].content)).toBe(true);
		});

		describe('OTel spans', () => {
			it('creates span with correct attributes', async () => {
				getExporter().reset();
				const zipPath = FilePath(join(fixturesDir, 'valid-single.zip'));

				await extractZip(zipPath);

				const spans = getExporter().getFinishedSpans();
				const extractSpan = spans.find(s => s.name === 'zip.extract');

				expect(extractSpan).toBeDefined();
				expect(extractSpan?.attributes['app.archive.path']).toBe(zipPath);
				expect(extractSpan?.attributes['app.archive.format']).toBe('zip');
				expect(extractSpan?.attributes['app.archive.entry_count']).toBe(1);
			});

			it('records entry count for multiple files', async () => {
				getExporter().reset();
				const zipPath = FilePath(join(fixturesDir, 'valid-multiple.zip'));

				await extractZip(zipPath);

				const spans = getExporter().getFinishedSpans();
				const extractSpan = spans.find(s => s.name === 'zip.extract');

				expect(extractSpan?.attributes['app.archive.entry_count']).toBe(3);
			});

			it('records error on corrupt zip', async () => {
				getExporter().reset();
				const zipPath = FilePath(join(fixturesDir, 'corrupt.zip'));

				await expect(extractZip(zipPath)).rejects.toThrow();

				const spans = getExporter().getFinishedSpans();
				const extractSpan = spans.find(s => s.name === 'zip.extract');

				expect(extractSpan).toBeDefined();
				expect(extractSpan?.status.code).toBe(2); // SpanStatusCode.ERROR
			});
		});

		describe('zip bomb protection', () => {
			it('throws when entry count exceeds maxEntries', async () => {
				const zipPath = FilePath(join(fixturesDir, 'valid-multiple.zip'));

				// Zip has 3 files, set limit to 2
				await expect(extractZip(zipPath, { maxEntries: 2 })).rejects.toThrow(
					'Zip file exceeds entry limit of 2',
				);
			});

			it('throws when entry size exceeds maxEntrySize', async () => {
				const zipPath = FilePath(join(fixturesDir, 'valid-single.zip'));

				// File content is ~30 bytes, set limit lower
				await expect(extractZip(zipPath, { maxEntrySize: 10 })).rejects.toThrow(
					'Entry txn.xml exceeds size limit of 10 bytes',
				);
			});

			it('throws when total size exceeds maxTotalSize', async () => {
				const zipPath = FilePath(join(fixturesDir, 'valid-multiple.zip'));

				// Total content is ~90 bytes, set limit lower
				await expect(extractZip(zipPath, { maxTotalSize: 50 })).rejects.toThrow(
					'Zip file exceeds size limit of 50 bytes',
				);
			});

			it('respects custom limits in streaming mode', async () => {
				const zipPath = FilePath(join(fixturesDir, 'valid-multiple.zip'));

				const consume = async () => {
					const files = [];
					for await (const file of extractZipStreaming(zipPath, { maxEntries: 1 })) {
						files.push(file);
					}
					return files;
				};

				await expect(consume()).rejects.toThrow('Zip file exceeds entry limit of 1');
			});
		});
	});
});
