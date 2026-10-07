import { describe } from 'vitest';
import { defineBufferCases } from './suite/buffers.js';
import { defineCounterCases } from './suite/counters.js';
import { defineEntryCases } from './suite/entries.js';
import { defineExpiryCases } from './suite/expiry.js';
import { providersUnderTest } from './suite/providers.js';

describe.each(providersUnderTest)('$name key-value store', function(provider) {
	defineEntryCases(provider);
	defineExpiryCases(provider);
	defineCounterCases(provider);
	defineBufferCases(provider);
});
