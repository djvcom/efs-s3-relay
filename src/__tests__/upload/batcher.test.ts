import { describe, expect, it } from 'vitest';

import { S3Key, S3Prefix } from '../../types/branded';
import { createBatches, type FileToUpload } from '../../upload/batcher';

describe('createBatches', () => {
	const createFiles = (count: number): FileToUpload[] =>
		Array.from({ length: count }, (_, i) => ({
			key: S3Key(`file-${i}.xml`),
			content: Buffer.from(`content-${i}`),
		}));

	it('creates single batch for files under batch size', () => {
		const files = createFiles(5);
		const batches = createBatches(files, S3Prefix('prefix'), 100);

		expect(batches).toHaveLength(1);
		expect(batches[0]?.files).toHaveLength(5);
		expect(batches[0]?.prefix).toMatch(/^prefix\/[0-9a-f-]{36}\/$/);
	});

	it('creates multiple batches when files exceed batch size', () => {
		const files = createFiles(250);
		const batches = createBatches(files, S3Prefix('prefix'), 100);

		expect(batches).toHaveLength(3);
		expect(batches[0]?.files).toHaveLength(100);
		expect(batches[1]?.files).toHaveLength(100);
		expect(batches[2]?.files).toHaveLength(50);
	});

	it('creates unique prefix for each batch', () => {
		const files = createFiles(200);
		const batches = createBatches(files, S3Prefix('prefix'), 100);

		const prefixes = batches.map(b => b.prefix);
		const uniquePrefixes = new Set(prefixes);

		expect(uniquePrefixes.size).toBe(2);
	});

	it('handles empty prefix base', () => {
		const files = createFiles(5);
		const batches = createBatches(files, S3Prefix(''), 100);

		expect(batches[0]?.prefix).toMatch(/^[0-9a-f-]{36}\/$/);
	});

	it('handles empty file list', () => {
		const batches = createBatches([], S3Prefix('prefix'), 100);
		expect(batches).toHaveLength(0);
	});

	it('preserves file content in batches', () => {
		const files = createFiles(3);
		const batches = createBatches(files, S3Prefix('prefix'), 100);

		expect(batches[0]?.files[0]?.key).toBe('file-0.xml');
		expect(batches[0]?.files[0]?.content.toString()).toBe('content-0');
	});
});
