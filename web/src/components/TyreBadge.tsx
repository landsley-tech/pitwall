import type { Compound } from '@shared/types';
import { COMPOUND_COLOUR, COMPOUND_LETTER } from '../lib/format';

export function TyreBadge({ compound, size = 20 }: { compound: Compound; size?: number }) {
  const c = COMPOUND_COLOUR[compound];
  return (
    <svg className="tyre" width={size} height={size} viewBox="0 0 20 20" aria-label={compound.toLowerCase()}>
      <circle cx="10" cy="10" r="8.5" fill="none" stroke={c} strokeWidth="3" />
      <text x="10" y="10.5" textAnchor="middle" dominantBaseline="middle" fill={c} fontSize="9" fontWeight="800">
        {COMPOUND_LETTER[compound]}
      </text>
    </svg>
  );
}
