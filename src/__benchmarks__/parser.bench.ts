import { bench, describe } from 'vitest';

import { createContentParser } from '../content/parser';

const smallXml = '<transaction><id>12345</id></transaction>';
const mediumXml = `<transaction>
	<id>12345</id>
	<items>${Array.from({ length: 100 }, (_, i) => `<item>${i}</item>`).join('')}</items>
</transaction>`;
const largeXml = `<transaction>
	<id>12345</id>
	<items>${Array.from({ length: 1000 }, (_, i) => `<item><id>${i}</id><name>Item ${i}</name><description>This is item number ${i} with some additional text to make it larger</description></item>`).join('')}</items>
</transaction>`;

describe('parser performance', () => {
	const parser = createContentParser('<id>(\\d+)</id>', '<skip>');

	bench('extractFilename - small XML', () => {
		parser.extractFilename(smallXml, 'fallback.xml');
	});

	bench('extractFilename - medium XML (100 items)', () => {
		parser.extractFilename(mediumXml, 'fallback.xml');
	});

	bench('extractFilename - large XML (1000 items)', () => {
		parser.extractFilename(largeXml, 'fallback.xml');
	});

	bench('shouldFilter - no match', () => {
		parser.shouldFilter(smallXml);
	});

	bench('shouldFilter - with match', () => {
		const xmlWithSkip = '<transaction><skip>true</skip></transaction>';
		parser.shouldFilter(xmlWithSkip);
	});
});

describe('parser creation', () => {
	bench('create parser with patterns', () => {
		createContentParser('<id>(\\d+)</id>', '<filter>');
	});

	bench('create parser without patterns', () => {
		createContentParser(undefined, undefined);
	});
});
