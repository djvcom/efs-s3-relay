import { describe, expect, it } from 'vitest';

import { assertNever, getErrorMessage, getErrorType, toError } from '../../utils/errors';

describe('errors', () => {
	describe('getErrorMessage', () => {
		it('extracts message from Error instances', () => {
			expect(getErrorMessage(new Error('test message'))).toBe('test message');
		});

		it('converts non-Error values to strings', () => {
			expect(getErrorMessage('string error')).toBe('string error');
			expect(getErrorMessage(42)).toBe('42');
			expect(getErrorMessage(null)).toBe('null');
		});
	});

	describe('getErrorType', () => {
		it('returns error name for Error instances', () => {
			expect(getErrorType(new Error('test'))).toBe('Error');
			expect(getErrorType(new TypeError('test'))).toBe('TypeError');
			expect(getErrorType(new RangeError('test'))).toBe('RangeError');
		});

		it('returns typeof for non-Error values', () => {
			expect(getErrorType('string')).toBe('string');
			expect(getErrorType(42)).toBe('number');
			expect(getErrorType(null)).toBe('object');
			expect(getErrorType(undefined)).toBe('undefined');
		});

		it('returns name for custom Error classes', () => {
			class CustomError extends Error {
				constructor() {
					super('custom');
					this.name = 'CustomError';
				}
			}
			expect(getErrorType(new CustomError())).toBe('CustomError');
		});
	});

	describe('toError', () => {
		it('returns Error instances unchanged', () => {
			const error = new Error('original');
			expect(toError(error)).toBe(error);
		});

		it('wraps non-Error values in Error', () => {
			const result = toError('string error');
			expect(result).toBeInstanceOf(Error);
			expect(result.message).toBe('string error');
		});
	});

	describe('assertNever', () => {
		it('throws with default message for unexpected value', () => {
			const value = 'unexpected' as never;
			expect(() => assertNever(value)).toThrow('Unexpected value: "unexpected"');
		});

		it('throws with custom message when provided', () => {
			const value = 'unexpected' as never;
			expect(() => assertNever(value, 'Custom error message')).toThrow('Custom error message');
		});

		it('provides compile-time exhaustiveness checking', () => {
			type Status = 'active' | 'inactive';

			const handleStatus = (status: Status): string => {
				switch (status) {
					case 'active':
						return 'Status is active';
					case 'inactive':
						return 'Status is inactive';
					default:
						// TypeScript will error if a case is missed
						return assertNever(status);
				}
			};

			expect(handleStatus('active')).toBe('Status is active');
			expect(handleStatus('inactive')).toBe('Status is inactive');
		});
	});
});
