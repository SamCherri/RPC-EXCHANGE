import { HTMLAttributes } from 'react';

type PremiumCardProps = HTMLAttributes<HTMLElement> & {
  as?: 'section' | 'article' | 'div';
  variant?: 'default' | 'elevated' | 'warning' | 'success' | 'danger';
};

export function PremiumCard({ as = 'article', variant = 'default', className = '', children, ...props }: PremiumCardProps) {
  const Comp = as;
  return <Comp className={`premium-card premium-card-${variant} ${className}`.trim()} {...props}>{children}</Comp>;
}
