import { mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CreateBucketCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	S3Client,
} from '@aws-sdk/client-s3';
import type { Context, ScheduledEvent } from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetConfig } from '../src/config';
import { resetS3Client } from '../src/index';
import {
	isContainerRuntimeAvailable,
	type MinioConfig,
	startMinioContainer,
	stopMinioContainer,
} from './helpers/minio_container';
import {
	calculateExpectedOutcomes,
	generateTestBatch,
	generateTestZip,
	type GeneratedZip,
} from './helpers/test_data_generator';

const TEST_BUCKET = 'test-transactions';
const S3_PREFIX = 'uploads';

let minioConfig: MinioConfig;
let s3Client: S3Client;
let testRootDir: string;

function createTestContext(remainingTimeMs = 300_000): Context {
	return {
		callbackWaitsForEmptyEventLoop: false,
		functionName: 'integration-test',
		functionVersion: '1',
		invokedFunctionArn: 'arn:aws:lambda:eu-west-1:123456789:function:integration-test',
		memoryLimitInMB: '512',
		awsRequestId: `test-${Date.now()}`,
		logGroupName: '/aws/lambda/integration-test',
		logStreamName: '2024/01/01/[$LATEST]abc123',
		getRemainingTimeInMillis: () => remainingTimeMs,
		done: () => {},
		fail: () => {},
		succeed: () => {},
	};
}

function createScheduledEvent(): ScheduledEvent {
	return {
		version: '0',
		id: 'test-event-id',
		'detail-type': 'Scheduled Event',
		source: 'aws.events',
		account: '123456789',
		time: new Date().toISOString(),
		region: 'eu-west-1',
		resources: ['arn:aws:events:eu-west-1:123456789:rule/test-rule'],
		detail: {},
	};
}

async function createTestDirectories(): Promise<{
	sourceDir: string;
	archiveDir: string;
	failedDir: string;
}> {
	const baseDir = join(testRootDir, `run-${Date.now()}`);
	const sourceDir = join(baseDir, 'input');
	const archiveDir = join(baseDir, 'archived');
	const failedDir = join(baseDir, 'failed');

	await mkdir(sourceDir, { recursive: true });
	await mkdir(archiveDir, { recursive: true });
	await mkdir(failedDir, { recursive: true });

	return { sourceDir, archiveDir, failedDir };
}

async function listS3Objects(prefix?: string): Promise<string[]> {
	const response = await s3Client.send(
		new ListObjectsV2Command({
			Bucket: TEST_BUCKET,
			Prefix: prefix,
		}),
	);

	return (response.Contents ?? []).map((obj) => obj.Key!).filter(Boolean);
}

async function getS3ObjectContent(key: string): Promise<string> {
	const response = await s3Client.send(
		new GetObjectCommand({
			Bucket: TEST_BUCKET,
			Key: key,
		}),
	);

	return response.Body!.transformToString();
}

async function clearS3Bucket(): Promise<void> {
	const objects = await listS3Objects();
	if (objects.length === 0) return;

	await s3Client.send(
		new DeleteObjectsCommand({
			Bucket: TEST_BUCKET,
			Delete: {
				Objects: objects.map((key) => ({ Key: key })),
			},
		}),
	);
}

async function configureEnvironment(
	sourceDir: string,
	archiveDir: string,
	failedDir: string,
	filterPattern?: string,
): Promise<void> {
	process.env['APP_SOURCE_DIR'] = sourceDir;
	process.env['APP_ARCHIVE_DIR'] = archiveDir;
	process.env['APP_FAILED_DIR'] = failedDir;
	process.env['APP_DESTINATION_BUCKET'] = TEST_BUCKET;
	process.env['APP_S3_PREFIX_BASE'] = S3_PREFIX;
	process.env['APP_BATCH_SIZE'] = '10';
	process.env['APP_MAX_FILES_PER_INVOCATION'] = '100';
	process.env['APP_TIMEOUT_BUFFER_MS'] = '5000';
	process.env['APP_MIN_FILE_AGE_MS'] = '0';
	process.env['APP_DELETE_ON_SUCCESS'] = 'false';
	process.env['APP_S3_REGION'] = minioConfig.region;
	process.env['APP_S3_ENDPOINT_URL'] = minioConfig.endpoint;
	// AWS credentials for SDK (still needed by AWS SDK)
	process.env['AWS_ACCESS_KEY_ID'] = minioConfig.accessKeyId;
	process.env['AWS_SECRET_ACCESS_KEY'] = minioConfig.secretAccessKey;

	if (filterPattern) {
		process.env['APP_FILTER_PATTERN'] = filterPattern;
	} else {
		delete process.env['APP_FILTER_PATTERN'];
	}

	// Reset both config and S3 client to pick up new settings
	resetConfig();
	resetS3Client();
}

const canRunIntegrationTests = isContainerRuntimeAvailable();

describe.skipIf(!canRunIntegrationTests)('Handler Integration Tests', () => {
	beforeAll(async () => {
		// Start MinIO container
		minioConfig = await startMinioContainer();

		// Create S3 client for test assertions
		s3Client = new S3Client({
			endpoint: minioConfig.endpoint,
			region: minioConfig.region,
			credentials: {
				accessKeyId: minioConfig.accessKeyId,
				secretAccessKey: minioConfig.secretAccessKey,
			},
			forcePathStyle: true,
		});

		// Create test bucket
		await s3Client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));

		// Create temp directory for test files
		testRootDir = join(tmpdir(), 'lambda-s3-integration-tests');
		await mkdir(testRootDir, { recursive: true });
	});

	afterAll(async () => {
		await stopMinioContainer();

		// Cleanup temp directory
		try {
			await rm(testRootDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	beforeEach(async () => {
		resetConfig();
		await clearS3Bucket();
	});

	describe('successful processing', () => {
		it('processes a single zip file and uploads all files to S3', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();
			await configureEnvironment(sourceDir, archiveDir, failedDir);

			// Generate test data
			const zip = await generateTestZip({
				outputDir: sourceDir,
				zipName: 'batch-001.zip',
				fileCount: 5,
				seed: 42,
			});

			const expected = calculateExpectedOutcomes([zip]);

			// Import handler fresh to pick up new env vars
			const { handler } = await import('../src/index');
			const result = await handler(createScheduledEvent(), createTestContext());

			// Verify handler result
			expect(result.zipsProcessed).toBe(1);
			expect(result.zipsFailed).toBe(0);
			expect(result.totalFilesUploaded).toBe(expected.expectedUploaded);
			expect(result.totalFilesFiltered).toBe(0);
			expect(result.stoppedEarly).toBe(false);

			// Verify S3 contents
			const s3Objects = await listS3Objects(S3_PREFIX);
			expect(s3Objects).toHaveLength(expected.expectedUploaded);

			// Verify zip was archived
			const archivedFiles = await readdir(archiveDir);
			expect(archivedFiles).toContain('batch-001.zip');

			// Verify source is empty
			const sourceFiles = await readdir(sourceDir);
			expect(sourceFiles).toHaveLength(0);
		});

		it('processes multiple zip files in sequence', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();
			await configureEnvironment(sourceDir, archiveDir, failedDir);

			// Generate multiple test zips
			const zips = await generateTestBatch({
				outputDir: sourceDir,
				zipCount: 3,
				filesPerZip: 4,
				baseSeed: 100,
			});

			const expected = calculateExpectedOutcomes(zips);

			const { handler } = await import('../src/index');
			const result = await handler(createScheduledEvent(), createTestContext());

			expect(result.zipsProcessed).toBe(3);
			expect(result.zipsFailed).toBe(0);
			expect(result.totalFilesUploaded).toBe(expected.expectedUploaded);

			// All zips should be archived
			const archivedFiles = await readdir(archiveDir);
			expect(archivedFiles).toHaveLength(3);
			expect(archivedFiles.sort()).toEqual(['batch-000.zip', 'batch-001.zip', 'batch-002.zip']);
		});

		it('verifies uploaded file content matches source', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();
			await configureEnvironment(sourceDir, archiveDir, failedDir);

			const zip = await generateTestZip({
				outputDir: sourceDir,
				zipName: 'verify-content.zip',
				fileCount: 2,
				seed: 200,
			});

			const { handler } = await import('../src/index');
			await handler(createScheduledEvent(), createTestContext());

			// Get all uploaded objects
			const s3Objects = await listS3Objects(S3_PREFIX);

			// Verify each file's content
			for (const key of s3Objects) {
				const s3Content = await getS3ObjectContent(key);
				const filename = key.split('/').pop()!;
				const originalFile = zip.files.find((f) => f.filename === filename);

				expect(originalFile).toBeDefined();
				expect(s3Content).toBe(originalFile!.content);
			}
		});
	});

	describe('content filtering', () => {
		it('filters files matching the filter pattern', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();

			// Configure with filter pattern to exclude test transactions
			await configureEnvironment(sourceDir, archiveDir, failedDir, '<IsTest>true</IsTest>');

			// Generate zips with 50% test files
			const zips = await generateTestBatch({
				outputDir: sourceDir,
				zipCount: 2,
				filesPerZip: 10,
				testFileRatio: 0.5,
				baseSeed: 300,
			});

			const expected = calculateExpectedOutcomes(zips);

			const { handler } = await import('../src/index');
			const result = await handler(createScheduledEvent(), createTestContext());

			expect(result.zipsProcessed).toBe(2);
			expect(result.totalFilesFiltered).toBe(expected.expectedFiltered);
			expect(result.totalFilesUploaded).toBe(expected.expectedUploaded);

			// Verify correct number in S3
			const s3Objects = await listS3Objects(S3_PREFIX);
			expect(s3Objects).toHaveLength(expected.expectedUploaded);
		});

		it('uploads all files when no filter pattern configured', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();
			await configureEnvironment(sourceDir, archiveDir, failedDir);

			// Generate zips with test files but no filter
			const zips = await generateTestBatch({
				outputDir: sourceDir,
				zipCount: 1,
				filesPerZip: 5,
				testFileRatio: 0.4,
				baseSeed: 400,
			});

			const expected = calculateExpectedOutcomes(zips);

			const { handler } = await import('../src/index');
			const result = await handler(createScheduledEvent(), createTestContext());

			// All files should be uploaded (no filtering)
			expect(result.totalFilesFiltered).toBe(0);
			expect(result.totalFilesUploaded).toBe(expected.totalFiles);
		});
	});

	describe('file routing', () => {
		it('archives successfully processed zip files', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();
			await configureEnvironment(sourceDir, archiveDir, failedDir);

			await generateTestZip({
				outputDir: sourceDir,
				zipName: 'to-archive.zip',
				fileCount: 3,
				seed: 500,
			});

			const { handler } = await import('../src/index');
			await handler(createScheduledEvent(), createTestContext());

			const archivedFiles = await readdir(archiveDir);
			const failedFiles = await readdir(failedDir);
			const sourceFiles = await readdir(sourceDir);

			expect(archivedFiles).toContain('to-archive.zip');
			expect(failedFiles).toHaveLength(0);
			expect(sourceFiles).toHaveLength(0);
		});
	});

	describe('batch processing', () => {
		it('respects maxFilesPerInvocation limit', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();

			// Set a low limit
			await configureEnvironment(sourceDir, archiveDir, failedDir);
			process.env['APP_MAX_FILES_PER_INVOCATION'] = '2';
			resetConfig();

			// Generate more zips than the limit
			await generateTestBatch({
				outputDir: sourceDir,
				zipCount: 5,
				filesPerZip: 2,
				baseSeed: 600,
			});

			const { handler } = await import('../src/index');
			const result = await handler(createScheduledEvent(), createTestContext());

			// Should only process 2 zips
			expect(result.results).toHaveLength(2);

			// Remaining zips should still be in source
			const sourceFiles = await readdir(sourceDir);
			expect(sourceFiles).toHaveLength(3);

			// Processed zips should be archived
			const archivedFiles = await readdir(archiveDir);
			expect(archivedFiles).toHaveLength(2);
		});

		it('groups files into batches for S3 upload', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();
			await configureEnvironment(sourceDir, archiveDir, failedDir);

			// Set small batch size
			process.env['APP_BATCH_SIZE'] = '3';
			resetConfig();

			// Generate zip with more files than batch size
			await generateTestZip({
				outputDir: sourceDir,
				zipName: 'large-batch.zip',
				fileCount: 10,
				seed: 700,
			});

			const { handler } = await import('../src/index');
			const result = await handler(createScheduledEvent(), createTestContext());

			// All 10 files should be uploaded across multiple batches
			expect(result.totalFilesUploaded).toBe(10);

			const s3Objects = await listS3Objects(S3_PREFIX);
			expect(s3Objects).toHaveLength(10);
		});
	});

	describe('S3 key structure', () => {
		it('uploads files with correct prefix structure', async () => {
			const { sourceDir, archiveDir, failedDir } = await createTestDirectories();
			await configureEnvironment(sourceDir, archiveDir, failedDir);

			await generateTestZip({
				outputDir: sourceDir,
				zipName: 'prefix-test.zip',
				fileCount: 2,
				seed: 800,
			});

			const { handler } = await import('../src/index');
			await handler(createScheduledEvent(), createTestContext());

			const s3Objects = await listS3Objects();

			// All keys should start with the configured prefix
			for (const key of s3Objects) {
				expect(key.startsWith(`${S3_PREFIX}/`)).toBe(true);
			}

			// Keys should have UUID subdirectory
			// Format: uploads/{uuid}/{filename}.xml
			const keyParts = s3Objects[0]!.split('/');
			expect(keyParts).toHaveLength(3);
			expect(keyParts[0]).toBe(S3_PREFIX);
			expect(keyParts[1]).toMatch(/^[0-9a-f-]{36}$/); // UUID format
			expect(keyParts[2]).toMatch(/^TXN-[A-Z0-9]+\.xml$/);
		});
	});
});
