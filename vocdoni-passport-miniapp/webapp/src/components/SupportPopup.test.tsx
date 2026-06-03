import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SupportPopup from './SupportPopup';

describe('SupportPopup', () => {
  it('renders support links and dismisses when closed', () => {
    const onDismiss = vi.fn();

    render(<SupportPopup open onDismiss={onDismiss} />);

    expect(screen.getByRole('dialog', { name: 'Need help?' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Discord' })).toHaveAttribute('href', 'https://chat.vocdoni.io');
    expect(screen.getByRole('link', { name: 'Telegram' })).toHaveAttribute('href', 'https://t.me/vocdoni_community');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss support popup' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('stays hidden when closed', () => {
    const onDismiss = vi.fn();

    const { container } = render(<SupportPopup open={false} onDismiss={onDismiss} />);

    expect(container.firstChild).not.toBeVisible();
  });
});
