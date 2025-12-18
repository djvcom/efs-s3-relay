export interface ContentParser {
	extractFilename(content: string, fallbackName: string): string;
	shouldFilter(content: string): boolean;
}

export function createContentParser(
	filenamePattern?: string,
	filterPattern?: string,
): ContentParser {
	const filenameRegex = filenamePattern ? new RegExp(filenamePattern) : undefined;
	const filterRegex = filterPattern ? new RegExp(filterPattern) : undefined;

	return {
		extractFilename(content: string, fallbackName: string): string {
			if (!filenameRegex) {
				return fallbackName;
			}

			const match = filenameRegex.exec(content);
			if (match?.[1]) {
				return `${match[1]}.xml`;
			}

			return fallbackName;
		},

		shouldFilter(content: string): boolean {
			if (!filterRegex) {
				return false;
			}

			return filterRegex.test(content);
		},
	};
}
