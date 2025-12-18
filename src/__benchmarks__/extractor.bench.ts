import { dirname, join } from 'node:path';
import { bench, describe } from 'vitest';

import { extractZip } from '../archive/extractor';
import { FilePath } from '../types/branded';

const fixturesDir = join(dirname(new URL(import.meta.url).pathname), '../__tests__/fixtures/zips');

describe('extractZip performance', () => {
	bench('extract single file zip', async () => {
		const zipPath = FilePath(join(fixturesDir, 'valid-single.zip'));
		await extractZip(zipPath);
	});

	bench('extract multiple files zip', async () => {
		const zipPath = FilePath(join(fixturesDir, 'valid-multiple.zip'));
		await extractZip(zipPath);
	});

	bench('extract zip with directories', async () => {
		const zipPath = FilePath(join(fixturesDir, 'with-directories.zip'));
		await extractZip(zipPath);
	});
});
