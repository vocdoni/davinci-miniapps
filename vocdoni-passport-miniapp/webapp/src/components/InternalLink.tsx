import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';

interface InternalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  children: ReactNode;
}

export default function InternalLink({ to, children, ...props }: InternalLinkProps) {
  const inRouter = useInRouterContext();

  if (inRouter) {
    return (
      <Link to={to} {...props}>
        {children}
      </Link>
    );
  }

  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}
