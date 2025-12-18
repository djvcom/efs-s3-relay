import type { Span } from '@opentelemetry/api';

export type AttributeValue = string | number | boolean;
export type AttributeMap = Record<string, AttributeValue>;

export function setAttributes(span: Span, attributes: AttributeMap): void {
	for (const [key, value] of Object.entries(attributes)) {
		span.setAttribute(key, value);
	}
}

export class AttributeBuilder {
	private readonly attributes: AttributeMap = {};

	add(key: string, value: AttributeValue): this {
		this.attributes[key] = value;
		return this;
	}

	addIf(condition: boolean, key: string, value: AttributeValue): this {
		if (condition) {
			this.attributes[key] = value;
		}
		return this;
	}

	addIfDefined<T extends AttributeValue>(key: string, value: T | undefined | null): this {
		if (value !== undefined && value !== null) {
			this.attributes[key] = value;
		}
		return this;
	}

	build(): AttributeMap {
		return { ...this.attributes };
	}

	applyTo(span: Span): void {
		setAttributes(span, this.attributes);
	}
}

export function attrs(): AttributeBuilder {
	return new AttributeBuilder();
}
