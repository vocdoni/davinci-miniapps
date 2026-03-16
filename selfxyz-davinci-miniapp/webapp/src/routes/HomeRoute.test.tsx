import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomeRoute from './HomeRoute';

describe('HomeRoute', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders the landing page with create and explore entry points', () => {
    render(<HomeRoute />);

    expect(screen.getByRole('heading', { name: 'Ask a question. Let the world answer.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What powers Ask the World' })).toBeInTheDocument();

    const createLink = screen.getByRole('link', { name: 'Start creating' });
    const exploreLink = screen.getByRole('link', { name: 'Explore live votes' });

    expect(createLink).toHaveAttribute('href', '/create');
    expect(exploreLink).toHaveAttribute('href', '/explore');

    expect(screen.getByRole('link', { name: 'Create' })).toHaveAttribute('href', '/create');
    expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
    expect(screen.queryByLabelText('Product demo slideshow')).not.toBeInTheDocument();
  });

  it('rotates the visible protocol description through the list', async () => {
    vi.useFakeTimers();
    render(<HomeRoute />);

    expect(screen.getByText(/Every vote is verified mathematically from cast to tally/i)).toBeInTheDocument();
    expect(screen.queryByText(/It adapts to different governance rules and identity systems/i)).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(3400);

    expect(screen.getByText(/It adapts to different governance rules and identity systems/i)).toBeInTheDocument();
    expect(screen.queryByText(/Every vote is verified mathematically from cast to tally/i)).not.toBeInTheDocument();
  });
});
