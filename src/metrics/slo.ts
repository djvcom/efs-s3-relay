import { metrics } from '@opentelemetry/api';

import { SERVICE_NAME, SERVICE_VERSION } from '../constants';

const meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);

export const zipsTotal = meter.createCounter('slo.zips.total', {
	description: 'Total zip files attempted for processing',
	unit: '{zip}',
});

export const zipsSuccess = meter.createCounter('slo.zips.success', {
	description: 'Zip files successfully processed',
	unit: '{zip}',
});

let oldestZipAgeSeconds = 0;

const freshnessGauge = meter.createObservableGauge('slo.freshness.oldest_zip_age', {
	description: 'Age of oldest unprocessed zip file in seconds',
	unit: 's',
});

freshnessGauge.addCallback(result => {
	result.observe(oldestZipAgeSeconds);
});

export function recordOldestZipAge(ageSeconds: number): void {
	oldestZipAgeSeconds = ageSeconds;
}

export function recordZipProcessingResult(success: boolean): void {
	zipsTotal.add(1);
	if (success) {
		zipsSuccess.add(1);
	}
}
