import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { eventbridgeTrigger, wrap } from '@semantic-lambda/core';
import type { Context, ScheduledEvent } from 'aws-lambda';
import { v4 as uuid } from 'uuid';

import { extractZipStreaming } from './archive/extractor';
import { type Config, getConfig } from './config';
import { SERVICE_NAME, SERVICE_VERSION } from './constants';
import { type ContentParser, createContentParser } from './content/parser';
import { type AppError, FileSystemError, ZipError } from './errors';
import { recordOldestZipAge, recordZipProcessingResult } from './metrics/slo';
import { Result, tryAsync } from './result';
import { tryGetFileAgeMs, tryRouteFile } from './routing/file_router';
import { attrs, createSdkLogger, setAttributes } from './telemetry';
import { FilePath, joinS3Path, S3Key, S3Prefix } from './types/branded';
import type { Batch, FileToUpload } from './upload/batcher';
import { type BatchUploadResult, tryUploadBatch } from './upload/uploader';

const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);

let _s3Client: S3Client | undefined;

function getS3Client(cfg: Config): S3Client {
	if (!_s3Client) {
		_s3Client = new S3Client({
			...(cfg.s3Region && { region: cfg.s3Region }),
			...(cfg.s3EndpointUrl && {
				endpoint: cfg.s3EndpointUrl,
				forcePathStyle: true,
			}),
			logger: createSdkLogger('s3-client'),
			maxAttempts: 3,
		});
	}
	return _s3Client;
}

export function resetS3Client(): void {
	_s3Client = undefined;
}

export interface ZipSuccess {
	readonly zipPath: FilePath;
	readonly filesExtracted: number;
	readonly filesUploaded: number;
	readonly filesFiltered: number;
}

export interface ZipFailure {
	readonly zipPath: FilePath;
	readonly error: AppError;
	readonly filesExtracted: number;
	readonly filesUploaded: number;
	readonly filesFiltered: number;
}

export interface BatchResult {
	readonly zipsProcessed: number;
	readonly zipsFailed: number;
	readonly totalFilesUploaded: number;
	readonly totalFilesFailed: number;
	readonly totalFilesFiltered: number;
	readonly successes: readonly ZipSuccess[];
	readonly failures: readonly ZipFailure[];
	readonly stoppedEarly: boolean;
}

const isValidZipFile = (filename: string): boolean =>
	filename.endsWith('.zip') && !filename.startsWith('.');

interface ZipListResult {
	readonly files: readonly string[];
	readonly oldestAgeMs: number;
}

async function tryListZipFiles(
	directory: FilePath,
	minFileAgeMs: number,
): Promise<Result<ZipListResult, FileSystemError>> {
	return tracer.startActiveSpan('filesystem.list_zips', { kind: SpanKind.INTERNAL }, async span => {
		try {
			span.setAttribute('app.file.directory', directory);

			const entriesResult = await tryAsync(
				() => readdir(directory),
				cause => FileSystemError.list(directory, cause),
			).toPromise();

			if (entriesResult.isErr) {
				span.setStatus({ code: SpanStatusCode.ERROR, message: entriesResult.error.message });
				span.recordException(entriesResult.error);
				return Result.err(entriesResult.error);
			}

			const zipFiles = entriesResult.value.filter(isValidZipFile);

			if (zipFiles.length === 0) {
				span.setAttribute('app.zip.count', 0);
				span.setStatus({ code: SpanStatusCode.OK });
				return Result.ok({ files: [], oldestAgeMs: 0 });
			}

			const readyFiles: string[] = [];
			let skippedTooNew = 0;
			let oldestAgeMs = 0;

			for (const zipFile of zipFiles) {
				const zipPath = FilePath(join(directory, zipFile));
				const ageResult = await tryGetFileAgeMs(zipPath).toPromise();

				if (ageResult.isOk) {
					oldestAgeMs = Math.max(oldestAgeMs, ageResult.value);
					if (minFileAgeMs <= 0 || ageResult.value >= minFileAgeMs) {
						readyFiles.push(zipFile);
					} else {
						skippedTooNew++;
					}
				} else {
					readyFiles.push(zipFile);
				}
			}

			attrs()
				.add('app.zip.count', readyFiles.length)
				.addIf(skippedTooNew > 0, 'app.zip.skipped_too_new', skippedTooNew)
				.add('app.slo.oldest_zip_age_ms', oldestAgeMs)
				.applyTo(span);

			span.setStatus({ code: SpanStatusCode.OK });
			return Result.ok({ files: readyFiles, oldestAgeMs });
		} finally {
			span.end();
		}
	});
}

async function tryProcessZipFile(
	zipPath: FilePath,
	cfg: Config,
	parser: ContentParser,
): Promise<Result<ZipSuccess, ZipFailure>> {
	return tracer.startActiveSpan('zip.process', { kind: SpanKind.INTERNAL }, async span => {
		span.setAttribute('app.archive.path', zipPath);

		let filesExtracted = 0;
		let filteredCount = 0;
		let filesUploaded = 0;
		let filesFailed = 0;

		const usedFilenames = new Set<string>();
		let currentBatch: FileToUpload[] = [];
		let currentBatchPrefix = S3Prefix(joinS3Path(cfg.s3PrefixBase, uuid()));

		const flushBatch = async (): Promise<void> => {
			if (currentBatch.length === 0) return;

			const batch: Batch = {
				prefix: currentBatchPrefix,
				files: currentBatch,
			};

			const result: BatchUploadResult = await tryUploadBatch(
				getS3Client(cfg),
				cfg.destinationBucket,
				batch,
			);
			filesUploaded += result.successful.length;
			if (result.status === 'partial_success') {
				filesFailed += result.failed.length;
			}

			currentBatch = [];
			currentBatchPrefix = S3Prefix(joinS3Path(cfg.s3PrefixBase, uuid()));
		};

		try {
			for await (const file of extractZipStreaming(zipPath)) {
				filesExtracted++;
				const content = file.content.toString('utf-8');

				if (parser.shouldFilter(content)) {
					filteredCount++;
					continue;
				}

				let filename = parser.extractFilename(content, file.name);

				if (usedFilenames.has(filename)) {
					const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
					const base = filename.includes('.')
						? filename.slice(0, filename.lastIndexOf('.'))
						: filename;
					filename = `${base}-${uuid().slice(0, 8)}${ext}`;
				}
				usedFilenames.add(filename);

				currentBatch.push({
					key: S3Key(filename),
					content: file.content,
				});

				if (currentBatch.length >= cfg.batchSize) {
					await flushBatch();
				}
			}

			await flushBatch();

			setAttributes(span, {
				'app.files.extracted': filesExtracted,
				'app.files.filtered': filteredCount,
				'app.files.uploaded': filesUploaded,
				'app.files.failed': filesFailed,
			});

			const allSucceeded = filesFailed === 0 && filesUploaded > 0;
			const routeResult = await tryRouteFile(
				zipPath,
				allSucceeded,
				cfg.archiveDir,
				cfg.failedDir,
				cfg.deleteOnSuccess,
			).toPromise();

			if (routeResult.isErr) {
				span.addEvent('route_file_error', {
					'error.type': routeResult.error.name,
					'error.message': routeResult.error.message,
				});
			}

			if (filesFailed > 0) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: `${filesFailed} file(s) failed to upload`,
				});
				return Result.err({
					zipPath,
					error: ZipError.extraction(zipPath, new Error(`${filesFailed} file(s) failed to upload`)),
					filesExtracted,
					filesUploaded,
					filesFiltered: filteredCount,
				});
			}

			span.setStatus({ code: SpanStatusCode.OK });
			return Result.ok({
				zipPath,
				filesExtracted,
				filesUploaded,
				filesFiltered: filteredCount,
			});
		} catch (error) {
			const zipError = error instanceof ZipError ? error : ZipError.extraction(zipPath, error);

			span.setStatus({ code: SpanStatusCode.ERROR, message: zipError.message });
			span.recordException(zipError);

			const routeResult = await tryRouteFile(
				zipPath,
				false,
				cfg.archiveDir,
				cfg.failedDir,
				cfg.deleteOnSuccess,
			).toPromise();

			if (routeResult.isErr) {
				span.addEvent('route_to_failed_dir_error', {
					'error.type': routeResult.error.name,
					'error.message': routeResult.error.message,
				});
			}

			return Result.err({
				zipPath,
				error: zipError,
				filesExtracted,
				filesUploaded,
				filesFiltered: filteredCount,
			});
		} finally {
			span.end();
		}
	});
}

async function processZips(cfg: Config, context: Context): Promise<BatchResult> {
	return tracer.startActiveSpan('batch.process', { kind: SpanKind.INTERNAL }, async span => {
		try {
			setAttributes(span, {
				'app.config.source_dir': cfg.sourceDir,
				'app.config.destination_bucket': cfg.destinationBucket,
			});

			const parser = createContentParser(cfg.filenamePattern, cfg.filterPattern);

			const listResult = await tryListZipFiles(cfg.sourceDir, cfg.minFileAgeMs);

			if (listResult.isErr) {
				span.setStatus({ code: SpanStatusCode.ERROR, message: listResult.error.message });
				span.recordException(listResult.error);
				return {
					zipsProcessed: 0,
					zipsFailed: 1,
					totalFilesUploaded: 0,
					totalFilesFailed: 0,
					totalFilesFiltered: 0,
					successes: [],
					failures: [
						{
							zipPath: FilePath(cfg.sourceDir),
							error: listResult.error,
							filesExtracted: 0,
							filesUploaded: 0,
							filesFiltered: 0,
						},
					],
					stoppedEarly: false,
				};
			}

			const { files: allZipFiles, oldestAgeMs } = listResult.value;
			const zipFiles = allZipFiles.slice(0, cfg.maxFilesPerInvocation);

			recordOldestZipAge(oldestAgeMs / 1000);

			setAttributes(span, {
				'app.batch.zip_count': zipFiles.length,
				'app.batch.zips_skipped': allZipFiles.length - zipFiles.length,
			});

			if (allZipFiles.length > cfg.maxFilesPerInvocation) {
				span.addEvent('batch_size_limited', {
					total_zips: allZipFiles.length,
					processing: cfg.maxFilesPerInvocation,
				});
			}

			if (zipFiles.length === 0) {
				span.addEvent('no_zips_to_process');
				span.setStatus({ code: SpanStatusCode.OK });
				return {
					zipsProcessed: 0,
					zipsFailed: 0,
					totalFilesUploaded: 0,
					totalFilesFailed: 0,
					totalFilesFiltered: 0,
					successes: [],
					failures: [],
					stoppedEarly: false,
				};
			}

			const successes: ZipSuccess[] = [];
			const failures: ZipFailure[] = [];
			let stoppedEarly = false;

			for (const zipFile of zipFiles) {
				const remainingTime = context.getRemainingTimeInMillis();
				if (remainingTime < cfg.timeoutBufferMs) {
					span.addEvent('timeout_approaching', {
						'lambda.remaining_time_ms': remainingTime,
						'lambda.timeout_buffer_ms': cfg.timeoutBufferMs,
						'batch.zips_processed': successes.length + failures.length,
						'batch.zips_remaining': zipFiles.length - successes.length - failures.length,
					});
					stoppedEarly = true;
					break;
				}

				const zipPath = FilePath(join(cfg.sourceDir, zipFile));
				const result = await tryProcessZipFile(zipPath, cfg, parser);

				if (result.isOk) {
					successes.push(result.value);
					recordZipProcessingResult(true);
				} else {
					failures.push(result.error);
					recordZipProcessingResult(false);
				}
			}

			const totalFilesUploaded =
				successes.reduce((sum, s) => sum + s.filesUploaded, 0) +
				failures.reduce((sum, f) => sum + f.filesUploaded, 0);
			const totalFilesFiltered =
				successes.reduce((sum, s) => sum + s.filesFiltered, 0) +
				failures.reduce((sum, f) => sum + f.filesFiltered, 0);

			setAttributes(span, {
				'app.batch.zips_processed': successes.length,
				'app.batch.zips_failed': failures.length,
				'app.batch.total_files_uploaded': totalFilesUploaded,
				'app.batch.stopped_early': stoppedEarly,
			});

			if (failures.length > 0) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: `${failures.length} zip(s) failed to process`,
				});
			} else {
				span.setStatus({ code: SpanStatusCode.OK });
			}

			return {
				zipsProcessed: successes.length,
				zipsFailed: failures.length,
				totalFilesUploaded,
				totalFilesFailed: 0,
				totalFilesFiltered,
				successes,
				failures,
				stoppedEarly,
			};
		} finally {
			span.end();
		}
	});
}

export const handler = wrap(
	tracer,
	eventbridgeTrigger,
	async (_event: ScheduledEvent, context: Context): Promise<BatchResult> => {
		const cfg = getConfig();
		return processZips(cfg, context);
	},
);
