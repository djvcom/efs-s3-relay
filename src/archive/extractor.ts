import { buffer } from 'node:stream/consumers';

import yauzl from 'yauzl';

import { ZipError } from '../errors';
import { withSpan } from '../telemetry/with_span';
import type { FilePath } from '../types/branded';
import type { ExtractedFile } from './types';

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_ENTRY_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_SIZE = 200 * 1024 * 1024;

export interface ExtractOptions {
	readonly maxEntries?: number;
	readonly maxEntrySize?: number;
	readonly maxTotalSize?: number;
}

export async function* extractZipStreaming(
	zipPath: FilePath,
	options: ExtractOptions = {},
): AsyncGenerator<ExtractedFile, void, unknown> {
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const maxEntrySize = options.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE;

	let entryCount = 0;

	const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (err, zf) => {
			if (err ?? !zf) {
				reject(ZipError.corrupt(zipPath, err));
			} else {
				resolve(zf);
			}
		});
	});

	try {
		while (true) {
			const entry = await new Promise<yauzl.Entry | null>((resolve, reject) => {
				const onEntry = (e: yauzl.Entry) => {
					cleanup();
					resolve(e);
				};
				const onEnd = () => {
					cleanup();
					resolve(null);
				};
				const onError = (err: Error) => {
					cleanup();
					reject(ZipError.extraction(zipPath, err));
				};
				const cleanup = () => {
					zipFile.removeListener('entry', onEntry);
					zipFile.removeListener('end', onEnd);
					zipFile.removeListener('error', onError);
				};

				zipFile.once('entry', onEntry);
				zipFile.once('end', onEnd);
				zipFile.once('error', onError);
				zipFile.readEntry();
			});

			if (!entry) break;
			if (entry.fileName.endsWith('/')) continue;

			entryCount++;
			if (entryCount > maxEntries) {
				throw ZipError.tooManyEntries(zipPath, maxEntries);
			}

			if (entry.uncompressedSize > maxEntrySize) {
				throw ZipError.entryTooLarge(zipPath, entry.fileName, maxEntrySize);
			}

			const content = await new Promise<Buffer>((resolve, reject) => {
				zipFile.openReadStream(entry, (err, stream) => {
					if (err ?? !stream) {
						reject(ZipError.extraction(zipPath, err));
						return;
					}
					buffer(stream)
						.then(resolve)
						.catch(e => reject(ZipError.extraction(zipPath, e)));
				});
			});

			if (content.length > maxEntrySize) {
				throw ZipError.entryTooLarge(zipPath, entry.fileName, maxEntrySize);
			}

			yield { name: entry.fileName, content };
		}
	} finally {
		zipFile.close();
	}
}

export async function extractZip(
	zipPath: FilePath,
	options: ExtractOptions = {},
): Promise<ExtractedFile[]> {
	const maxTotalSize = options.maxTotalSize ?? DEFAULT_MAX_TOTAL_SIZE;

	return withSpan('zip-extractor', 'zip.extract', async span => {
		span.setAttribute('app.archive.path', zipPath);
		span.setAttribute('app.archive.format', 'zip');

		const files: ExtractedFile[] = [];
		let totalSize = 0;

		for await (const file of extractZipStreaming(zipPath, options)) {
			totalSize += file.content.length;
			if (totalSize > maxTotalSize) {
				throw ZipError.tooLarge(zipPath, maxTotalSize);
			}
			files.push(file);
		}

		span.setAttribute('app.archive.entry_count', files.length);
		span.setAttribute('app.archive.total_bytes', totalSize);
		return files;
	});
}
