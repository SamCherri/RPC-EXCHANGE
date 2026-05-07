type BrandLogoProps = {
  size?: 'sm' | 'md' | 'hero';
  subtitle?: boolean;
  markOnly?: boolean;
  className?: string;
};

export function BrandLogo({ size = 'md', subtitle = true, markOnly = false, className = '' }: BrandLogoProps) {
  return (
    <div className={`brand-logo brand-logo-${size} ${className}`.trim()}>
      <span className="brand-mark" aria-hidden="true">RPC</span>
      {!markOnly ? (
        <span className="brand-text-wrap">
          <strong className="brand-title">RPC Exchange</strong>
          {subtitle ? <small className="brand-subtitle">Simulação econômica RP</small> : null}
        </span>
      ) : null}
    </div>
  );
}
