/** 선 아이콘 (장식용은 aria-hidden) */
const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const Spark = (p: { size?: number }) => (
  <svg {...base} width={p.size ?? 20} height={p.size ?? 20}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8" />
  </svg>
);
export const ListIcon = () => (
  <svg {...base}>
    <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </svg>
);
export const Plus = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const Minus = () => (
  <svg {...base}>
    <path d="M5 12h14" />
  </svg>
);
export const Close = (p: { size?: number }) => (
  <svg {...base} width={p.size ?? 20} height={p.size ?? 20} strokeWidth={2}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const Back = () => (
  <svg {...base}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
export const Send = () => (
  <svg {...base} strokeWidth={2}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
export const Clip = () => (
  <svg {...base}>
    <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
  </svg>
);
export const Check = (p: { size?: number }) => (
  <svg {...base} width={p.size ?? 12} height={p.size ?? 12} strokeWidth={3}>
    <path d="M5 12l5 5L20 7" />
  </svg>
);
export const Alert = (p: { size?: number }) => (
  <svg {...base} width={p.size ?? 14} height={p.size ?? 14} strokeWidth={2.2}>
    <path d="M12 8v5M12 16.5h.01" />
  </svg>
);
export const ChatBubble = () => (
  <svg {...base} width={24} height={24}>
    <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z" />
  </svg>
);
export const File = () => (
  <svg {...base}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
);
export const Download = () => (
  <svg {...base} width={18} height={18}>
    <path d="M12 4v12M6 10l6 6 6-6M5 20h14" />
  </svg>
);
export const Search = () => (
  <svg {...base} width={18} height={18}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);
export const Shield = () => (
  <svg {...base} width={18} height={18}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
  </svg>
);
export const Refresh = () => (
  <svg {...base} width={18} height={18}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
