import { describe, expect, it } from 'vitest';

import { createContentParser } from '../../content/parser';

describe('createContentParser', () => {
	describe('extractFilename', () => {
		it('returns fallback when no pattern configured', () => {
			const parser = createContentParser();
			const result = parser.extractFilename('<xml>content</xml>', 'fallback.xml');
			expect(result).toBe('fallback.xml');
		});

		it('extracts filename from content using pattern', () => {
			const parser = createContentParser('<transactionId>(.*?)</transactionId>');
			const content = '<root><transactionId>TXN-12345</transactionId></root>';
			const result = parser.extractFilename(content, 'fallback.xml');
			expect(result).toBe('TXN-12345.xml');
		});

		it('returns fallback when pattern does not match', () => {
			const parser = createContentParser('<transactionId>(.*?)</transactionId>');
			const content = '<root><otherId>12345</otherId></root>';
			const result = parser.extractFilename(content, 'fallback.xml');
			expect(result).toBe('fallback.xml');
		});

		it('handles namespaced patterns', () => {
			const parser = createContentParser('<retail:transactionId>(.*?)</retail:transactionId>');
			const content =
				'<retail:root><retail:transactionId>ABC-789</retail:transactionId></retail:root>';
			const result = parser.extractFilename(content, 'fallback.xml');
			expect(result).toBe('ABC-789.xml');
		});
	});

	describe('shouldFilter', () => {
		it('returns false when no filter pattern configured', () => {
			const parser = createContentParser();
			const result = parser.shouldFilter('<xml>content</xml>');
			expect(result).toBe(false);
		});

		it('returns true when content matches filter pattern', () => {
			const parser = createContentParser(undefined, '<locationId>PERF-TEST</locationId>');
			const content = '<root><locationId>PERF-TEST</locationId></root>';
			const result = parser.shouldFilter(content);
			expect(result).toBe(true);
		});

		it('returns false when content does not match filter pattern', () => {
			const parser = createContentParser(undefined, '<locationId>PERF-TEST</locationId>');
			const content = '<root><locationId>STORE-001</locationId></root>';
			const result = parser.shouldFilter(content);
			expect(result).toBe(false);
		});

		it('works with both patterns configured', () => {
			const parser = createContentParser(
				'<transactionId>(.*?)</transactionId>',
				'<isTest>true</isTest>',
			);

			const testContent = '<root><transactionId>TXN-1</transactionId><isTest>true</isTest></root>';
			const prodContent = '<root><transactionId>TXN-2</transactionId><isTest>false</isTest></root>';

			expect(parser.shouldFilter(testContent)).toBe(true);
			expect(parser.shouldFilter(prodContent)).toBe(false);
			expect(parser.extractFilename(prodContent, 'fallback.xml')).toBe('TXN-2.xml');
		});
	});
});
