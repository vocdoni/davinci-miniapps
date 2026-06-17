import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CreateRoute from './CreateRoute';
import VoteRoute from './VoteRoute';

vi.mock('@vocdoni/davinci-sdk', () => ({
  ProcessStatus: {
    READY: 0,
    ENDED: 1,
    CANCELED: 2,
    PAUSED: 3,
    RESULTS: 4,
  },
  OnchainCensus: class MockOnchainCensus {},
  DavinciSDK: class MockDavinciSDK {},
}));

vi.mock('@selfxyz/qrcode', () => ({
  SelfAppBuilder: class MockSelfAppBuilder {
    addQRcode() {
      return this;
    }
    build() {
      return {};
    }
  },
  SelfQRcodeWrapper: () => null,
}));

describe('navbar menu links', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows Create and Explore links in create navbar', () => {
    window.history.pushState({}, '', '/create');
    render(<CreateRoute />);

    const createLink = screen.getByRole('link', { name: 'Create' });
    const exploreLink = screen.getByRole('link', { name: 'Explore' });

    expect(createLink).toHaveAttribute('href', '/create');
    expect(createLink).toHaveAttribute('aria-current', 'page');
    expect(createLink.querySelector('.iconoir-plus')).not.toBeNull();

    expect(exploreLink).toHaveAttribute('href', '/explore');
    expect(exploreLink.querySelector('.iconoir-search')).not.toBeNull();
  });

  it('shows Create and Explore links in vote navbar', () => {
    window.history.pushState({}, '', '/vote');
    render(
      <MemoryRouter initialEntries={['/vote']}>
        <Routes>
          <Route path="/vote" element={<VoteRoute />} />
        </Routes>
      </MemoryRouter>
    );

    const createLink = screen.getByRole('link', { name: 'Create' });
    const exploreLink = screen.getByRole('link', { name: 'Explore' });

    expect(createLink).toHaveAttribute('href', '/create');
    expect(createLink.querySelector('.iconoir-plus')).not.toBeNull();

    expect(exploreLink).toHaveAttribute('href', '/explore');
    expect(exploreLink.querySelector('.iconoir-search')).not.toBeNull();
  });
});
