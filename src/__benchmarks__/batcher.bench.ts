import { bench, describe } from 'vitest';

import { S3Key, S3Prefix } from '../types/branded';
import { createBatches, type FileToUpload } from '../upload/batcher';

const createFiles = (count: number): FileToUpload[] =>
	Array.from({ length: count }, (_, i) => ({
		key: S3Key(`file-${i}.xml`),
		content: Buffer.from(`<xml>${i}</xml>`),
	}));

describe('batcher performance', () => {
	const prefix = S3Prefix('transactions/input/');

	bench('create batches - 10 files, batch size 100', () => {
		createBatches(createFiles(10), prefix, 100);
	});

	bench('create batches - 100 files, batch size 100', () => {
		createBatches(createFiles(100), prefix, 100);
	});

	bench('create batches - 1000 files, batch size 100', () => {
		createBatches(createFiles(1000), prefix, 100);
	});

	bench('create batches - 1000 files, batch size 50', () => {
		createBatches(createFiles(1000), prefix, 50);
	});

	bench('create batches - 5000 files, batch size 100', () => {
		createBatches(createFiles(5000), prefix, 100);
	});
});
