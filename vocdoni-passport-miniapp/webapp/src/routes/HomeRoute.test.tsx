import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomeRoute from './HomeRoute';

describe('HomeRoute', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
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
    const createDemoTab = screen.getByRole('button', { name: 'Create a voting process' });
    const voteDemoTab = screen.getByRole('button', { name: 'Vote in a process' });
    const createDemo = screen.getByLabelText('Create a voting process demo video') as HTMLVideoElement;

    expect(createLink).toHaveAttribute('href', '/create');
    expect(exploreLink).toHaveAttribute('href', '/explore');

    expect(screen.getByRole('link', { name: 'Create' })).toHaveAttribute('href', '/create');
    expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
    expect(screen.getByLabelText('Product demo slideshow')).toBeInTheDocument();
    expect(createDemoTab).toHaveAttribute('aria-pressed', 'true');
    expect(voteDemoTab).toHaveAttribute('aria-pressed', 'false');
    expect(createDemo).toHaveAttribute(
      'src',
      'https://davinci-assets.fra1.cdn.digitaloceanspaces.com/demo-create-ask-the-world.mp4'
    );
    expect(createDemo.controls).toBe(false);
    expect(createDemo.loop).toBe(true);
    expect(createDemo.muted).toBe(true);

    fireEvent.click(voteDemoTab);

    expect(voteDemoTab).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Vote in a process demo video')).toHaveAttribute(
      'src',
      'https://davinci-assets.fra1.cdn.digitaloceanspaces.com/demo-vote-ask-the-world.mp4'
    );
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
