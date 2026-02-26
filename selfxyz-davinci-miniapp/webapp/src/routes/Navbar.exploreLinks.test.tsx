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

describe('navbar explore links', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows Explore link in create navbar', () => {
    render(<CreateRoute />);

    const link = screen.getByRole('link', { name: 'Explore' });
    expect(link).toHaveAttribute('href', '/explore');
  });

  it('shows Explore link in vote navbar', () => {
    render(
      <MemoryRouter initialEntries={['/vote']}>
        <Routes>
          <Route path="/vote" element={<VoteRoute />} />
        </Routes>
      </MemoryRouter>
    );

    const link = screen.getByRole('link', { name: 'Explore' });
    expect(link).toHaveAttribute('href', '/explore');
  });
});
