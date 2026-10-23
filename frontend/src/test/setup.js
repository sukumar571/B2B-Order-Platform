// Vitest global setup for React Testing Library.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Unmount React trees between tests to avoid cross-test bleed.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
