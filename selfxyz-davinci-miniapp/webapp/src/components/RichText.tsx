import { Fragment, useMemo, type ReactNode } from 'react';

interface RichTextProps {
  html: string;
}

const ALLOWED_TARGETS = new Set(['_blank', '_self', '_parent', '_top']);

function sanitizeHref(rawHref: string | null): string | null {
  const value = String(rawHref || '').trim();
  if (!value || value.startsWith('//')) return null;

  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!schemeMatch) return value;

  const scheme = schemeMatch[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') {
    return value;
  }

  return null;
}

function sanitizeTarget(rawTarget: string | null): '_blank' | '_self' | '_parent' | '_top' | undefined {
  const value = String(rawTarget || '').trim().toLowerCase();
  if (!value || !ALLOWED_TARGETS.has(value)) return undefined;
  return value as '_blank' | '_self' | '_parent' | '_top';
}

function renderRichNode(node: ChildNode, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();
  const children = Array.from(element.childNodes).map((child, index) => renderRichNode(child, `${key}.${index}`));

  switch (tagName) {
    case 'strong':
    case 'b':
      return <strong key={key}>{children}</strong>;
    case 'em':
    case 'i':
      return <em key={key}>{children}</em>;
    case 'u':
      return <u key={key}>{children}</u>;
    case 'br':
      return <br key={key} />;
    case 'a': {
      const href = sanitizeHref(element.getAttribute('href'));
      if (!href) return <Fragment key={key}>{children}</Fragment>;

      const target = sanitizeTarget(element.getAttribute('target'));
      const rel = target === '_blank' ? 'noopener noreferrer' : undefined;

      return (
        <a key={key} href={href} target={target} rel={rel}>
          {children}
        </a>
      );
    }
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

function renderRichText(html: string): ReactNode {
  if (typeof DOMParser === 'undefined') return html;

  const parser = new DOMParser();
  const documentNode = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  return Array.from(documentNode.body.childNodes).map((node, index) => renderRichNode(node, `rich-${index}`));
}

export default function RichText({ html }: RichTextProps) {
  const content = useMemo(() => renderRichText(String(html || '')), [html]);
  return <>{content}</>;
}
