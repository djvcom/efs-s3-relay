import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getConfig, resetConfig } from '../../config';

describe('config', () => {
	beforeEach(() => {
		resetConfig();
	});

	afterEach(() => {
		resetConfig();
	});

	describe('getConfig', () => {
		it('returns frozen config object', () => {
			const config = getConfig();
			expect(Object.isFrozen(config)).toBe(true);
		});

		it('returns same instance on multiple calls', () => {
			const config1 = getConfig();
			const config2 = getConfig();
			expect(config1).toBe(config2);
		});

		it('loads config from environment variables', () => {
			const config = getConfig();
			expect(config.sourceDir).toBe('/input');
			expect(config.archiveDir).toBe('/archived');
			expect(config.failedDir).toBe('/failed');
			expect(config.destinationBucket).toBe('test-bucket');
		});

		it('applies default values', () => {
			const config = getConfig();
			expect(config.batchSize).toBe(100);
			expect(config.maxFilesPerInvocation).toBe(1000);
			expect(config.timeoutBufferMs).toBe(30_000);
			expect(config.deleteOnSuccess).toBe(false);
		});

		it('parses numeric values correctly', () => {
			const config = getConfig();
			expect(typeof config.batchSize).toBe('number');
			expect(typeof config.maxFilesPerInvocation).toBe('number');
			expect(typeof config.timeoutBufferMs).toBe('number');
		});
	});

	describe('resetConfig', () => {
		it('clears cached config', () => {
			const config1 = getConfig();
			resetConfig();
			const config2 = getConfig();
			expect(config1).not.toBe(config2);
		});
	});

	describe('validation', () => {
		it('throws on invalid regex pattern', () => {
			const originalPattern = process.env['APP_FILENAME_PATTERN'];
			process.env['APP_FILENAME_PATTERN'] = '[unclosed';
			resetConfig();

			expect(() => getConfig()).toThrow('Configuration validation failed');
			expect(() => getConfig()).toThrow('Invalid regex');

			process.env['APP_FILENAME_PATTERN'] = originalPattern;
		});

		it('validates minimum timeout buffer', () => {
			const original = process.env['APP_TIMEOUT_BUFFER_MS'];
			process.env['APP_TIMEOUT_BUFFER_MS'] = '1000';
			resetConfig();

			expect(() => getConfig()).toThrow('Configuration validation failed');

			process.env['APP_TIMEOUT_BUFFER_MS'] = original;
		});

		it('validates maximum batch size', () => {
			const original = process.env['APP_BATCH_SIZE'];
			process.env['APP_BATCH_SIZE'] = '2000';
			resetConfig();

			expect(() => getConfig()).toThrow('Configuration validation failed');

			process.env['APP_BATCH_SIZE'] = original;
		});

		it('parses boolean DELETE_ON_SUCCESS correctly', () => {
			const original = process.env['APP_DELETE_ON_SUCCESS'];

			for (const [input, expected] of [
				['true', true],
				['false', false],
				['1', true],
				['0', false],
			] as const) {
				process.env['APP_DELETE_ON_SUCCESS'] = input;
				resetConfig();
				expect(getConfig().deleteOnSuccess).toBe(expected);
			}

			process.env['APP_DELETE_ON_SUCCESS'] = original;
		});

		it('includes field name in error message', () => {
			const original = process.env['APP_BATCH_SIZE'];
			process.env['APP_BATCH_SIZE'] = 'not-a-number';
			resetConfig();

			expect(() => getConfig()).toThrow('APP_BATCH_SIZE');

			process.env['APP_BATCH_SIZE'] = original;
		});
	});
});
