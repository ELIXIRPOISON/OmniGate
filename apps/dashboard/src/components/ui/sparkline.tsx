import * as React from 'react';

/**
 * A sparkline is a shape, not a chart: no axes, no labels, no tooltip. It sits beside a number that
 * already states the value, so it only has to show the trend.
 */
export function Sparkline({
  values,
  className,
  stroke = 'var(--color-series-1)',
  height = 28,
  ariaLabel,
}: {
  values: number[];
  className?: string;
  stroke?: string;
  height?: number;
  ariaLabel?: string;
}) {
  const id = React.useId();
  if (values.length < 2) return <div style={{ height }} className={className} aria-hidden />;

  const width = 100;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => [i * step, height - ((v - min) / span) * (height - 4) - 2]);
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
