import { v4 as uuid } from 'uuid';

import { joinS3Path, type S3Key, S3Prefix, type S3Prefix as S3PrefixType } from '../types/branded';

export interface FileToUpload {
	readonly key: S3Key;
	readonly content: Buffer;
}

export interface Batch {
	readonly prefix: S3PrefixType;
	readonly files: readonly FileToUpload[];
}

export function createBatches(
	files: readonly FileToUpload[],
	prefixBase: S3PrefixType,
	batchSize: number,
): readonly Batch[] {
	const batches: Batch[] = [];

	for (let i = 0; i < files.length; i += batchSize) {
		const batchFiles = files.slice(i, i + batchSize);
		const prefix = S3Prefix(joinS3Path(prefixBase, uuid()));

		batches.push({
			prefix,
			files: batchFiles,
		});
	}

	return batches;
}
