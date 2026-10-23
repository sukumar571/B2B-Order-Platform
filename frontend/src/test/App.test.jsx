import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App.jsx';

function mockFetchSuccess(body) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

describe('App landing page health check', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows loading, then the success state once the API responds', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchSuccess({ status: 'ok', uptimeSeconds: 42, timestamp: new Date().toISOString() })
    );

    render(<App />);

    // Initial loading state is visible before the promise settles.
    expect(screen.getByText(/Checking API connection/i)).toBeInTheDocument();

    // Then it flips to success with data from the backend.
    const title = await screen.findByText(/API connected/i);
    expect(title).toBeInTheDocument();
    expect(screen.getByText('42s')).toBeInTheDocument();
  });

  it('shows the failure state and a retry control when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

    render(<App />);

    const heading = await screen.findByText(/Cannot reach the API/i);
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
