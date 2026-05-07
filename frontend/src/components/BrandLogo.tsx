type BrandLogoProps = {
  size?: 'sm' | 'md' | 'hero';
  subtitle?: boolean;
  markOnly?: boolean;
  className?: string;
};

const sizeMap = {
  sm: { icon: 32, logo: 120 },
  md: { icon: 44, logo: 180 },
  hero: { icon: 56, logo: 240 },
};

export function BrandLogo({ size = 'md', subtitle = true, markOnly = false, className = '' }: BrandLogoProps) {
  const dimensions = sizeMap[size];

  if (markOnly) {
    return (
      <div className={`brand-logo brand-logo-${size} ${className}`.trim()}>
        <img
          src="/assets/rpc_exchange_icon.png"
          alt="RPC"
          width={dimensions.icon}
          height={dimensions.icon}
          style={{ display: 'block' }}
        />
      </div>
    );
  }

  return (
    <div className={`brand-logo brand-logo-${size} ${className}`.trim()}>
      <img
        src="/assets/logo-full.png"
        alt="RPC Exchange"
        width={dimensions.logo}
        style={{ display: 'block', height: 'auto' }}
      />
      {!subtitle && size === 'sm' ? null : null}
    </div>
  );
}
