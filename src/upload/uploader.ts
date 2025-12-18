import { createHash } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
	SEMATTRS_RPC_METHOD,
	SEMATTRS_RPC_SERVICE,
	SEMATTRS_RPC_SYSTEM,
} from '@opentelemetry/semantic-conventions';

import { SERVICE_NAME } from '../constants';
import { S3Error } from '../errors';
import { type AsyncResult, partitionResults, type Result, tryAsync } from '../result';
import { setAttributes, withSpan } from '../telemetry';
import type { S3Bucket, S3Key, S3Prefix } from '../types/branded';
import { S3Key as createS3Key, joinS3Path } from '../types/branded';
import type { Batch } from './batcher';

const UPLOAD_CONCURRENCY = 10;

export interface UploadSuccess {
	readonly key: S3Key;
	readonly etag: string | undefined;
}

export type BatchUploadResult =
	| {
			readonly status: 'full_success';
			readonly prefix: S3Prefix;
			readonly successful: readonly UploadSuccess[];
	  }
	| {
			readonly status: 'partial_success';
			readonly prefix: S3Prefix;
			readonly successful: readonly UploadSuccess[];
			readonly failed: readonly S3Error[];
	  };

function tryUploadFile(
	s3Client: S3Client,
	bucket: S3Bucket,
	key: S3Key,
	content: Buffer,
): AsyncResult<UploadSuccess, S3Error> {
	const contentMd5 = createHash('md5').update(content).digest('base64');

	const command = new PutObjectCommand({
		Bucket: bucket,
		Key: key,
		Body: content,
		ContentType: 'application/xml',
		ContentMD5: contentMd5,
	});

	return tryAsync(
		async () => {
			const result = await s3Client.send(command);
			return { key, etag: result.ETag };
		},
		cause => S3Error.put(bucket, key, cause),
	);
}

async function uploadFilesInChunks(
	s3Client: S3Client,
	bucket: S3Bucket,
	files: readonly { key: S3Key; content: Buffer }[],
	concurrency: number,
): Promise<readonly Result<UploadSuccess, S3Error>[]> {
	const results: Result<UploadSuccess, S3Error>[] = [];

	for (let i = 0; i < files.length; i += concurrency) {
		const chunk = files.slice(i, i + concurrency);
		const chunkResults = await Promise.all(
			chunk.map(file => tryUploadFile(s3Client, bucket, file.key, file.content).toPromise()),
		);
		results.push(...chunkResults);
	}

	return results;
}

export async function tryUploadBatch(
	s3Client: S3Client,
	bucket: S3Bucket,
	batch: Batch,
): Promise<BatchUploadResult> {
	return withSpan(
		SERVICE_NAME,
		's3.upload_batch',
		async span => {
			setAttributes(span, {
				[SEMATTRS_RPC_SYSTEM]: 'aws-api',
				[SEMATTRS_RPC_SERVICE]: 'S3',
				[SEMATTRS_RPC_METHOD]: 'PutObject',
				'aws.s3.bucket': bucket,
				'aws.s3.prefix': batch.prefix,
				'app.batch.file_count': batch.files.length,
			});

			const filesToUpload = batch.files.map(file => ({
				key: createS3Key(joinS3Path(batch.prefix, file.key)),
				content: file.content,
			}));

			const results = await uploadFilesInChunks(
				s3Client,
				bucket,
				filesToUpload,
				UPLOAD_CONCURRENCY,
			);
			const { successes, failures } = partitionResults(results);

			for (const error of failures) {
				span.addEvent('file_upload_failed', {
					'aws.s3.key': error.key ?? 'unknown',
					'error.message': error.message,
				});
			}

			setAttributes(span, {
				'app.batch.successful': successes.length,
				'app.batch.failed': failures.length,
			});

			if (failures.length > 0) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: `${failures.length} file(s) failed to upload`,
				});
				return {
					status: 'partial_success' as const,
					prefix: batch.prefix,
					successful: successes,
					failed: failures,
				};
			}

			return {
				status: 'full_success' as const,
				prefix: batch.prefix,
				successful: successes,
			};
		},
		{ kind: SpanKind.CLIENT },
	);
}
