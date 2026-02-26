import { useEffect, type ReactNode } from 'react';

interface PopupModalProps {
  id: string;
  open: boolean;
  title: string;
  children: ReactNode;
  onClose?: () => void;
  className?: string;
  cardClassName?: string;
  bodyClassName?: string;
  titleId?: string;
  descriptionId?: string;
  closeLabel?: string;
  closeButtonId?: string;
  eyebrow?: string;
  role?: 'dialog' | 'alertdialog';
  backdropClosable?: boolean;
}

function joinClasses(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export default function PopupModal({
  id,
  open,
  title,
  children,
  onClose,
  className,
  cardClassName,
  bodyClassName,
  titleId,
  descriptionId,
  closeLabel = 'Close popup',
  closeButtonId,
  eyebrow,
  role = 'dialog',
  backdropClosable,
}: PopupModalProps) {
  const canClose = typeof onClose === 'function';
  const allowBackdropClose = backdropClosable ?? canClose;
  const resolvedTitleId = titleId || `${id}Title`;

  useEffect(() => {
    if (!open || !canClose) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [canClose, onClose, open]);

  return (
    <div
      id={id}
      className={joinClasses('app-popup', className)}
      role={role}
      aria-modal="true"
      aria-labelledby={resolvedTitleId}
      aria-describedby={descriptionId}
      hidden={!open}
    >
      <button
        type="button"
        className="app-popup-backdrop"
        aria-label={allowBackdropClose ? closeLabel : 'Modal backdrop'}
        aria-hidden={!allowBackdropClose}
        disabled={!allowBackdropClose}
        tabIndex={allowBackdropClose ? 0 : -1}
        onClick={allowBackdropClose ? onClose : undefined}
      />
      <article className={joinClasses('app-popup-card', cardClassName)}>
        <header className="app-popup-head">
          <div className="app-popup-head-copy">
            {eyebrow ? <p className="eyebrow popup-eyebrow">{eyebrow}</p> : null}
            <h2 id={resolvedTitleId} className="app-popup-title">
              {title}
            </h2>
          </div>
          <button
            id={closeButtonId}
            type="button"
            className="app-popup-close"
            aria-label={closeLabel}
            disabled={!canClose}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className={joinClasses('app-popup-body', bodyClassName)}>{children}</div>
      </article>
    </div>
  );
}
