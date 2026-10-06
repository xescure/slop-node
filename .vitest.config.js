import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts', 'utils/**/*.test.ts'],
		exclude: ['utils/lint-fixtures/**']
	}
});
