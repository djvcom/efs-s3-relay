import { describe, expect, it } from 'vitest';

import {
	FilePath,
	isFilePath,
	isS3Bucket,
	isS3Key,
	joinS3Path,
	S3_BUCKET_MAX_LENGTH,
	S3_BUCKET_MIN_LENGTH,
	S3_KEY_MAX_LENGTH,
	S3Bucket,
	S3Key,
	S3Prefix,
	validateS3Bucket,
} from '../../types/branded';

describe('S3Bucket', () => {
	describe('valid bucket names', () => {
		it('accepts standard bucket names', () => {
			expect(() => S3Bucket('my-bucket')).not.toThrow();
			expect(() => S3Bucket('my.bucket.name')).not.toThrow();
			expect(() => S3Bucket('bucket123')).not.toThrow();
			expect(() => S3Bucket('123bucket')).not.toThrow();
		});

		it('accepts minimum length bucket name', () => {
			expect(() => S3Bucket('abc')).not.toThrow();
			expect(() => S3Bucket('a1b')).not.toThrow();
		});

		it('rejects single character bucket name (below minimum length)', () => {
			expect(() => S3Bucket('a')).toThrow();
		});

		it('accepts maximum length bucket name', () => {
			expect(() => S3Bucket('a'.repeat(63))).not.toThrow();
		});

		it('returns the value as S3Bucket type', () => {
			const bucket = S3Bucket('my-bucket');
			expect(bucket).toBe('my-bucket');
		});
	});

	describe('length validation', () => {
		it('rejects empty bucket name', () => {
			expect(() => S3Bucket('')).toThrow('Invalid S3 bucket name');
		});

		it('rejects bucket name shorter than minimum', () => {
			expect(() => S3Bucket('ab')).toThrow(
				`Invalid S3 bucket name: must be ${S3_BUCKET_MIN_LENGTH}-${S3_BUCKET_MAX_LENGTH} characters`,
			);
		});

		it('rejects bucket name longer than maximum', () => {
			expect(() => S3Bucket('a'.repeat(64))).toThrow(
				`Invalid S3 bucket name: must be ${S3_BUCKET_MIN_LENGTH}-${S3_BUCKET_MAX_LENGTH} characters`,
			);
		});
	});

	describe('character validation', () => {
		it('rejects uppercase letters', () => {
			expect(() => S3Bucket('MyBucket')).toThrow('must contain only lowercase letters');
		});

		it('rejects underscores', () => {
			expect(() => S3Bucket('my_bucket')).toThrow('must contain only lowercase letters');
		});

		it('rejects spaces', () => {
			expect(() => S3Bucket('my bucket')).toThrow('must contain only lowercase letters');
		});

		it('rejects special characters', () => {
			expect(() => S3Bucket('my@bucket')).toThrow('must contain only lowercase letters');
			expect(() => S3Bucket('my!bucket')).toThrow('must contain only lowercase letters');
		});
	});

	describe('start/end validation', () => {
		it('rejects bucket starting with hyphen', () => {
			expect(() => S3Bucket('-my-bucket')).toThrow('must start and end with a letter or number');
		});

		it('rejects bucket ending with hyphen', () => {
			expect(() => S3Bucket('my-bucket-')).toThrow('must start and end with a letter or number');
		});

		it('rejects bucket starting with period', () => {
			expect(() => S3Bucket('.my-bucket')).toThrow('must start and end with a letter or number');
		});

		it('rejects bucket ending with period', () => {
			expect(() => S3Bucket('my-bucket.')).toThrow('must start and end with a letter or number');
		});
	});

	describe('consecutive periods', () => {
		it('rejects consecutive periods', () => {
			expect(() => S3Bucket('my..bucket')).toThrow('cannot contain consecutive periods');
		});

		it('allows single periods between segments', () => {
			expect(() => S3Bucket('my.bucket.name')).not.toThrow();
		});
	});

	describe('IP address format', () => {
		it('rejects IP address format', () => {
			expect(() => S3Bucket('192.168.1.1')).toThrow('cannot be formatted as an IP address');
			expect(() => S3Bucket('10.0.0.1')).toThrow('cannot be formatted as an IP address');
		});

		it('allows bucket names that look similar but are not IP addresses', () => {
			expect(() => S3Bucket('192.168.1.bucket')).not.toThrow();
			expect(() => S3Bucket('bucket.192.168.1')).not.toThrow();
		});
	});

	describe('reserved prefixes', () => {
		it('rejects xn-- prefix (internationalised domain names)', () => {
			expect(() => S3Bucket('xn--bucket')).toThrow("cannot start with reserved prefix 'xn--'");
		});

		it('rejects sthree- prefix', () => {
			expect(() => S3Bucket('sthree-bucket')).toThrow(
				"cannot start with reserved prefix 'sthree-'",
			);
		});

		it('rejects amzn-s3-demo- prefix', () => {
			expect(() => S3Bucket('amzn-s3-demo-bucket')).toThrow(
				"cannot start with reserved prefix 'amzn-s3-demo-'",
			);
		});
	});

	describe('reserved suffixes', () => {
		it('rejects -s3alias suffix', () => {
			expect(() => S3Bucket('bucket-s3alias')).toThrow(
				"cannot end with reserved suffix '-s3alias'",
			);
		});

		it('rejects --ol-s3 suffix (Object Lambda)', () => {
			expect(() => S3Bucket('bucket--ol-s3')).toThrow("cannot end with reserved suffix '--ol-s3'");
		});

		it('rejects .mrap suffix (Multi-Region Access Points)', () => {
			expect(() => S3Bucket('bucket.mrap')).toThrow("cannot end with reserved suffix '.mrap'");
		});

		it('rejects --x-s3 suffix', () => {
			expect(() => S3Bucket('bucket--x-s3')).toThrow("cannot end with reserved suffix '--x-s3'");
		});
	});
});

describe('validateS3Bucket', () => {
	it('returns null for valid bucket names', () => {
		expect(validateS3Bucket('my-bucket')).toBeNull();
		expect(validateS3Bucket('bucket.with.dots')).toBeNull();
	});

	it('returns INVALID_LENGTH for too short/long names', () => {
		expect(validateS3Bucket('ab')).toEqual({ code: 'INVALID_LENGTH', length: 2 });
		expect(validateS3Bucket('a'.repeat(64))).toEqual({ code: 'INVALID_LENGTH', length: 64 });
	});

	it('returns INVALID_CHARACTERS for invalid chars', () => {
		expect(validateS3Bucket('MyBucket')).toEqual({ code: 'INVALID_CHARACTERS' });
	});

	it('returns INVALID_START_END for invalid start/end', () => {
		expect(validateS3Bucket('-bucket')).toEqual({ code: 'INVALID_START_END' });
	});

	it('returns CONSECUTIVE_PERIODS for double dots', () => {
		expect(validateS3Bucket('my..bucket')).toEqual({ code: 'CONSECUTIVE_PERIODS' });
	});

	it('returns IP_ADDRESS_FORMAT for IP addresses', () => {
		expect(validateS3Bucket('192.168.1.1')).toEqual({ code: 'IP_ADDRESS_FORMAT' });
	});

	it('returns RESERVED_PREFIX for reserved prefixes', () => {
		expect(validateS3Bucket('xn--bucket')).toEqual({ code: 'RESERVED_PREFIX', prefix: 'xn--' });
	});

	it('returns RESERVED_SUFFIX for reserved suffixes', () => {
		expect(validateS3Bucket('bucket-s3alias')).toEqual({
			code: 'RESERVED_SUFFIX',
			suffix: '-s3alias',
		});
	});
});

describe('S3Key', () => {
	it('accepts valid keys', () => {
		expect(() => S3Key('file.xml')).not.toThrow();
		expect(() => S3Key('path/to/file.xml')).not.toThrow();
		expect(() => S3Key('a'.repeat(1024))).not.toThrow();
	});

	it('rejects empty key', () => {
		expect(() => S3Key('')).toThrow('S3 key cannot be empty');
	});

	it('rejects key longer than maximum', () => {
		expect(() => S3Key('a'.repeat(1025))).toThrow(
			`S3 key too long: max ${S3_KEY_MAX_LENGTH} characters`,
		);
	});
});

describe('S3Prefix', () => {
	it('normalises prefix with trailing slash', () => {
		expect(S3Prefix('prefix')).toBe('prefix/');
		expect(S3Prefix('path/to/prefix')).toBe('path/to/prefix/');
	});

	it('handles empty prefix', () => {
		expect(S3Prefix('')).toBe('');
	});

	it('removes leading slashes', () => {
		expect(S3Prefix('/prefix')).toBe('prefix/');
		expect(S3Prefix('///prefix')).toBe('prefix/');
	});

	it('removes trailing slashes before normalising', () => {
		expect(S3Prefix('prefix/')).toBe('prefix/');
		expect(S3Prefix('prefix///')).toBe('prefix/');
	});

	it('handles prefix with only slashes', () => {
		expect(S3Prefix('/')).toBe('');
		expect(S3Prefix('///')).toBe('');
	});
});

describe('FilePath', () => {
	it('accepts valid file paths', () => {
		expect(() => FilePath('/home/user/file.txt')).not.toThrow();
		expect(() => FilePath('./relative/path')).not.toThrow();
	});

	it('rejects empty path', () => {
		expect(() => FilePath('')).toThrow('File path cannot be empty');
	});
});

describe('joinS3Path', () => {
	it('joins path segments with slashes', () => {
		expect(joinS3Path('a', 'b', 'c')).toBe('a/b/c');
	});

	it('filters empty segments', () => {
		expect(joinS3Path('a', '', 'b')).toBe('a/b');
		expect(joinS3Path('', 'a', '')).toBe('a');
	});

	it('strips leading and trailing slashes from segments', () => {
		expect(joinS3Path('/a/', '/b/', '/c/')).toBe('a/b/c');
		expect(joinS3Path('prefix/', 'uuid')).toBe('prefix/uuid');
	});

	it('handles single segment', () => {
		expect(joinS3Path('single')).toBe('single');
	});

	it('handles all empty segments', () => {
		expect(joinS3Path('', '', '')).toBe('');
	});
});

describe('type guards', () => {
	describe('isS3Bucket', () => {
		it('returns true for valid bucket names', () => {
			expect(isS3Bucket('my-bucket')).toBe(true);
			expect(isS3Bucket('abc')).toBe(true);
			expect(isS3Bucket('bucket.with.dots')).toBe(true);
		});

		it('returns false for invalid length', () => {
			expect(isS3Bucket('')).toBe(false);
			expect(isS3Bucket('ab')).toBe(false);
			expect(isS3Bucket('a'.repeat(64))).toBe(false);
		});

		it('returns false for invalid characters', () => {
			expect(isS3Bucket('MyBucket')).toBe(false);
			expect(isS3Bucket('my_bucket')).toBe(false);
		});

		it('returns false for reserved prefixes/suffixes', () => {
			expect(isS3Bucket('xn--bucket')).toBe(false);
			expect(isS3Bucket('bucket-s3alias')).toBe(false);
		});

		it('returns false for non-string values', () => {
			expect(isS3Bucket(123)).toBe(false);
			expect(isS3Bucket(null)).toBe(false);
		});
	});

	describe('isS3Key', () => {
		it('returns true for valid keys', () => {
			expect(isS3Key('file.xml')).toBe(true);
			expect(isS3Key('a')).toBe(true);
		});

		it('returns false for invalid values', () => {
			expect(isS3Key('')).toBe(false);
			expect(isS3Key('a'.repeat(1025))).toBe(false);
			expect(isS3Key(123)).toBe(false);
		});
	});

	describe('isFilePath', () => {
		it('returns true for valid paths', () => {
			expect(isFilePath('/path/to/file')).toBe(true);
			expect(isFilePath('relative')).toBe(true);
		});

		it('returns false for invalid values', () => {
			expect(isFilePath('')).toBe(false);
			expect(isFilePath(123)).toBe(false);
		});
	});
});
