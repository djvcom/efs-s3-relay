declare const brand: unique symbol;

type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type S3Bucket = Brand<string, 'S3Bucket'>;
export type S3Key = Brand<string, 'S3Key'>;
export type S3Prefix = Brand<string, 'S3Prefix'>;
export type FilePath = Brand<string, 'FilePath'>;

export const S3_BUCKET_MIN_LENGTH = 3;
export const S3_BUCKET_MAX_LENGTH = 63;
export const S3_KEY_MAX_LENGTH = 1024;

const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$|^[a-z0-9]$/;
const IP_ADDRESS_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const CONSECUTIVE_PERIODS = /\.\./;

const RESERVED_PREFIXES = ['xn--', 'sthree-', 'sthree-configurator', 'amzn-s3-demo-'] as const;
const RESERVED_SUFFIXES = ['-s3alias', '--ol-s3', '.mrap', '--x-s3'] as const;

export type S3BucketValidationError =
	| { readonly code: 'INVALID_LENGTH'; readonly length: number }
	| { readonly code: 'INVALID_CHARACTERS' }
	| { readonly code: 'INVALID_START_END' }
	| { readonly code: 'CONSECUTIVE_PERIODS' }
	| { readonly code: 'IP_ADDRESS_FORMAT' }
	| { readonly code: 'RESERVED_PREFIX'; readonly prefix: string }
	| { readonly code: 'RESERVED_SUFFIX'; readonly suffix: string };

/**
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
 */
export function validateS3Bucket(value: string): S3BucketValidationError | null {
	if (!value || value.length < S3_BUCKET_MIN_LENGTH || value.length > S3_BUCKET_MAX_LENGTH) {
		return { code: 'INVALID_LENGTH', length: value?.length ?? 0 };
	}

	if (!/^[a-z0-9.-]+$/.test(value)) {
		return { code: 'INVALID_CHARACTERS' };
	}

	if (!S3_BUCKET_PATTERN.test(value)) {
		return { code: 'INVALID_START_END' };
	}

	if (CONSECUTIVE_PERIODS.test(value)) {
		return { code: 'CONSECUTIVE_PERIODS' };
	}

	if (IP_ADDRESS_PATTERN.test(value)) {
		return { code: 'IP_ADDRESS_FORMAT' };
	}

	for (const prefix of RESERVED_PREFIXES) {
		if (value.startsWith(prefix)) {
			return { code: 'RESERVED_PREFIX', prefix };
		}
	}

	for (const suffix of RESERVED_SUFFIXES) {
		if (value.endsWith(suffix)) {
			return { code: 'RESERVED_SUFFIX', suffix };
		}
	}

	return null;
}

function formatS3BucketError(error: S3BucketValidationError): string {
	switch (error.code) {
		case 'INVALID_LENGTH':
			return `Invalid S3 bucket name: must be ${S3_BUCKET_MIN_LENGTH}-${S3_BUCKET_MAX_LENGTH} characters (got ${error.length})`;
		case 'INVALID_CHARACTERS':
			return 'Invalid S3 bucket name: must contain only lowercase letters, numbers, hyphens, and periods';
		case 'INVALID_START_END':
			return 'Invalid S3 bucket name: must start and end with a letter or number';
		case 'CONSECUTIVE_PERIODS':
			return 'Invalid S3 bucket name: cannot contain consecutive periods';
		case 'IP_ADDRESS_FORMAT':
			return 'Invalid S3 bucket name: cannot be formatted as an IP address';
		case 'RESERVED_PREFIX':
			return `Invalid S3 bucket name: cannot start with reserved prefix '${error.prefix}'`;
		case 'RESERVED_SUFFIX':
			return `Invalid S3 bucket name: cannot end with reserved suffix '${error.suffix}'`;
		default: {
			const _exhaustive: never = error;
			return _exhaustive;
		}
	}
}

export const S3Bucket = (value: string): S3Bucket => {
	const error = validateS3Bucket(value);
	if (error) {
		throw new Error(formatS3BucketError(error));
	}
	return value as S3Bucket;
};

export const S3Key = (value: string): S3Key => {
	if (!value) {
		throw new Error('S3 key cannot be empty');
	}
	if (value.length > S3_KEY_MAX_LENGTH) {
		throw new Error(`S3 key too long: max ${S3_KEY_MAX_LENGTH} characters (got ${value.length})`);
	}
	return value as S3Key;
};

export const S3Prefix = (value: string): S3Prefix => {
	const normalised = value.replace(/^\/+/, '').replace(/\/+$/, '');
	return (normalised ? `${normalised}/` : '') as S3Prefix;
};

export const FilePath = (value: string): FilePath => {
	if (!value) {
		throw new Error('File path cannot be empty');
	}
	return value as FilePath;
};

export function joinS3Path(...parts: string[]): string {
	return parts
		.filter(Boolean)
		.map(part => part.replace(/^\/+|\/+$/g, ''))
		.filter(Boolean)
		.join('/');
}

export function isS3Bucket(value: unknown): value is S3Bucket {
	return typeof value === 'string' && validateS3Bucket(value) === null;
}

export function isS3Key(value: unknown): value is S3Key {
	return typeof value === 'string' && value.length > 0 && value.length <= S3_KEY_MAX_LENGTH;
}

export function isFilePath(value: unknown): value is FilePath {
	return typeof value === 'string' && value.length > 0;
}
