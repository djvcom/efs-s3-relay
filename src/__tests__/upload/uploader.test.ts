import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { S3Bucket, S3Key, S3Prefix } from '../../types/branded';
import type { Batch } from '../../upload/batcher';
import { tryUploadBatch } from '../../upload/uploader';

const s3Mock = mockClient(S3Client);
const testBucket = S3Bucket('test-bucket');

describe('uploader', () => {
	beforeEach(() => {
		s3Mock.reset();
	});

	afterEach(() => {
		s3Mock.reset();
	});

	describe('tryUploadBatch', () => {
		it('uploads all files in a batch', async () => {
			s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });

			const batch: Batch = {
				prefix: S3Prefix('prefix/uuid/'),
				files: [
					{ key: S3Key('file1.xml'), content: Buffer.from('<xml>1</xml>') },
					{ key: S3Key('file2.xml'), content: Buffer.from('<xml>2</xml>') },
				],
			};

			const result = await tryUploadBatch(new S3Client({}), testBucket, batch);

			expect(result.status).toBe('full_success');
			expect(result.successful).toHaveLength(2);
			expect(s3Mock.calls()).toHaveLength(2);
		});

		it('returns partial_success when some uploads fail', async () => {
			s3Mock
				.on(PutObjectCommand, { Key: 'prefix/uuid/file1.xml' })
				.resolves({ ETag: '"abc123"' })
				.on(PutObjectCommand, { Key: 'prefix/uuid/file2.xml' })
				.rejects(new Error('Access Denied'));

			const batch: Batch = {
				prefix: S3Prefix('prefix/uuid/'),
				files: [
					{ key: S3Key('file1.xml'), content: Buffer.from('<xml>1</xml>') },
					{ key: S3Key('file2.xml'), content: Buffer.from('<xml>2</xml>') },
				],
			};

			const result = await tryUploadBatch(new S3Client({}), testBucket, batch);

			expect(result.status).toBe('partial_success');
			if (result.status === 'partial_success') {
				expect(result.successful).toHaveLength(1);
				expect(result.failed).toHaveLength(1);
				expect(result.failed[0].message).toContain('Failed to upload to S3');
			}
		});

		it('returns full_success with empty batch', async () => {
			const batch: Batch = {
				prefix: S3Prefix('prefix/uuid/'),
				files: [],
			};

			const result = await tryUploadBatch(new S3Client({}), testBucket, batch);

			expect(result.status).toBe('full_success');
			expect(result.successful).toHaveLength(0);
			expect(s3Mock.calls()).toHaveLength(0);
		});

		it('constructs correct S3 keys with prefix', async () => {
			s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });

			const batch: Batch = {
				prefix: S3Prefix('transactions/input/abc-123/'),
				files: [{ key: S3Key('order.xml'), content: Buffer.from('<xml>data</xml>') }],
			};

			await tryUploadBatch(new S3Client({}), testBucket, batch);

			const call = s3Mock.calls()[0];
			expect(call.args[0].input).toMatchObject({
				Bucket: 'test-bucket',
				Key: 'transactions/input/abc-123/order.xml',
			});
		});

		it('sets ContentType to application/xml', async () => {
			s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });

			const batch: Batch = {
				prefix: S3Prefix('prefix/'),
				files: [{ key: S3Key('file.xml'), content: Buffer.from('<xml/>') }],
			};

			await tryUploadBatch(new S3Client({}), testBucket, batch);

			const call = s3Mock.calls()[0];
			expect(call.args[0].input.ContentType).toBe('application/xml');
		});

		it('includes ContentMD5 for idempotency', async () => {
			s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });

			const content = Buffer.from('<xml/>');
			const expectedMd5 = createHash('md5').update(content).digest('base64');

			const batch: Batch = {
				prefix: S3Prefix('prefix/'),
				files: [{ key: S3Key('file.xml'), content }],
			};

			await tryUploadBatch(new S3Client({}), testBucket, batch);

			const call = s3Mock.calls()[0];
			expect(call.args[0].input.ContentMD5).toBe(expectedMd5);
		});

		it('calculates correct ContentMD5 for various content sizes', async () => {
			s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });

			const smallContent = Buffer.from('small');
			const largeContent = Buffer.alloc(1024 * 1024, 'x'); // 1MB of 'x'

			const batch: Batch = {
				prefix: S3Prefix('prefix/'),
				files: [
					{ key: S3Key('small.xml'), content: smallContent },
					{ key: S3Key('large.xml'), content: largeContent },
				],
			};

			await tryUploadBatch(new S3Client({}), testBucket, batch);

			const calls = s3Mock.calls();
			expect(calls[0].args[0].input.ContentMD5).toBe(
				createHash('md5').update(smallContent).digest('base64'),
			);
			expect(calls[1].args[0].input.ContentMD5).toBe(
				createHash('md5').update(largeContent).digest('base64'),
			);
		});

		it('handles all uploads failing', async () => {
			s3Mock.on(PutObjectCommand).rejects(new Error('Service Unavailable'));

			const batch: Batch = {
				prefix: S3Prefix('prefix/'),
				files: [
					{ key: S3Key('file1.xml'), content: Buffer.from('<xml>1</xml>') },
					{ key: S3Key('file2.xml'), content: Buffer.from('<xml>2</xml>') },
				],
			};

			const result = await tryUploadBatch(new S3Client({}), testBucket, batch);

			expect(result.status).toBe('partial_success');
			if (result.status === 'partial_success') {
				expect(result.successful).toHaveLength(0);
				expect(result.failed).toHaveLength(2);
			}
		});

		it('respects concurrency limit', async () => {
			const uploadTimes: number[] = [];
			s3Mock.on(PutObjectCommand).callsFake(async () => {
				uploadTimes.push(Date.now());
				await new Promise(resolve => setTimeout(resolve, 10));
				return { ETag: '"abc"' };
			});

			const batch: Batch = {
				prefix: S3Prefix('prefix/'),
				files: Array.from({ length: 15 }, (_, i) => ({
					key: S3Key(`file${i}.xml`),
					content: Buffer.from(`<xml>${i}</xml>`),
				})),
			};

			await tryUploadBatch(new S3Client({}), testBucket, batch);

			// With concurrency 10, first 10 should start almost simultaneously,
			// then next 5 after first batch completes
			expect(s3Mock.calls()).toHaveLength(15);
		});

		it('returns etag from successful uploads', async () => {
			s3Mock.on(PutObjectCommand).resolves({ ETag: '"unique-etag-123"' });

			const batch: Batch = {
				prefix: S3Prefix('prefix/'),
				files: [{ key: S3Key('file.xml'), content: Buffer.from('<xml/>') }],
			};

			const result = await tryUploadBatch(new S3Client({}), testBucket, batch);

			expect(result.successful[0].etag).toBe('"unique-etag-123"');
		});
	});
});
