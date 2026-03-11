import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import RichText from './RichText';

describe('RichText', () => {
  it('renders the supported inline tags', () => {
    const { container } = render(
      <div>
        <RichText html={'Hello <strong>world</strong><br /><em>again</em> <u>today</u>.'} />
      </div>
    );

    expect(container.querySelector('strong')).toHaveTextContent('world');
    expect(container.querySelector('em')).toHaveTextContent('again');
    expect(container.querySelector('u')).toHaveTextContent('today');
    expect(container.querySelector('br')).not.toBeNull();
    expect(container).toHaveTextContent('Hello worldagain today.');
  });

  it('renders safe links and hardens target blank links', () => {
    render(
      <div>
        <RichText html={'Read the <a href="https://example.com/docs" target="_blank">docs</a>.'} />
      </div>
    );

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('drops unsafe links but preserves their text', () => {
    render(
      <div>
        <RichText html={'Do not <a href="javascript:alert(1)">click me</a>.'} />
      </div>
    );

    expect(screen.queryByRole('link', { name: 'click me' })).not.toBeInTheDocument();
    expect(screen.getByText(/do not click me\./i)).toBeInTheDocument();
  });
});
