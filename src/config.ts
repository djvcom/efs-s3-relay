import { ConfigBuilder, EnvironmentVariableSource, ObjectSource } from '@layerfig/config';
import { z } from 'zod';

import { FilePath, S3Bucket, S3Prefix } from './types/branded';

const regexPatternSchema = z.string().superRefine((pattern, ctx) => {
	try {
		new RegExp(pattern);
	} catch (error) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Invalid regex: ${error instanceof Error ? error.message : 'unknown error'}`,
		});
	}
});

const booleanFromEnv = z.preprocess(val => {
	if (typeof val === 'boolean') return val;
	if (val === 'true' || val === '1') return true;
	if (val === 'false' || val === '0') return false;
	return val;
}, z.boolean());

const rawConfigSchema = z
	.object({
		SOURCE_DIR: z.string().min(1),
		ARCHIVE_DIR: z.string().min(1),
		FAILED_DIR: z.string().min(1),
		DESTINATION_BUCKET: z.string().min(3).max(63),
		S3_PREFIX_BASE: z.string(),
		S3_ENDPOINT_URL: z.url().optional(),
		S3_REGION: z.string().min(1).optional(),
		BATCH_SIZE: z.coerce.number().int().positive().max(1000),
		MAX_FILES_PER_INVOCATION: z.coerce.number().int().positive(),
		TIMEOUT_BUFFER_MS: z.coerce.number().int().positive().min(5000),
		MIN_FILE_AGE_MS: z.coerce.number().int().nonnegative().optional(),
		FILENAME_PATTERN: regexPatternSchema.optional(),
		FILTER_PATTERN: regexPatternSchema.optional(),
		DELETE_ON_SUCCESS: booleanFromEnv,
	})
	.strict();

const configSchema = rawConfigSchema.transform(raw => ({
	sourceDir: FilePath(raw.SOURCE_DIR),
	archiveDir: FilePath(raw.ARCHIVE_DIR),
	failedDir: FilePath(raw.FAILED_DIR),
	destinationBucket: S3Bucket(raw.DESTINATION_BUCKET),
	s3PrefixBase: S3Prefix(raw.S3_PREFIX_BASE),
	s3EndpointUrl: raw.S3_ENDPOINT_URL,
	s3Region: raw.S3_REGION,
	batchSize: raw.BATCH_SIZE,
	maxFilesPerInvocation: raw.MAX_FILES_PER_INVOCATION,
	timeoutBufferMs: raw.TIMEOUT_BUFFER_MS,
	minFileAgeMs: raw.MIN_FILE_AGE_MS ?? 0,
	filenamePattern: raw.FILENAME_PATTERN,
	filterPattern: raw.FILTER_PATTERN,
	deleteOnSuccess: raw.DELETE_ON_SUCCESS,
}));

export type Config = z.infer<typeof configSchema>;

const defaults = {
	S3_PREFIX_BASE: '',
	BATCH_SIZE: 100,
	MAX_FILES_PER_INVOCATION: 1000,
	TIMEOUT_BUFFER_MS: 60_000,
	MIN_FILE_AGE_MS: 30_000,
	DELETE_ON_SUCCESS: false,
} satisfies Partial<z.input<typeof rawConfigSchema>>;

function buildConfig(): Config {
	try {
		const config = new ConfigBuilder({
			validate: merged => configSchema.parse(merged),
		})
			.addSource(new ObjectSource(defaults))
			.addSource(new EnvironmentVariableSource())
			.build();

		return Object.freeze(config);
	} catch (error) {
		if (error instanceof z.ZodError) {
			const issues = error.issues
				.map(issue => `APP_${issue.path.join('.')}: ${issue.message}`)
				.join('; ');
			throw new Error(`Configuration validation failed: ${issues}`);
		}
		throw error;
	}
}

let _config: Config | undefined;

export function getConfig(): Config {
	if (!_config) {
		_config = buildConfig();
	}
	return _config;
}

export function resetConfig(): void {
	_config = undefined;
}
