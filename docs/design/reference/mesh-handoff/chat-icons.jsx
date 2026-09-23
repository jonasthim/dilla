// Inline SVG icons for the chat app. All take a single `size` prop.

const Icon = {
  Help: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 6c0-1.1.9-2 2-2s2 .9 2 2-2 1.5-2 3M8 12.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  Hash: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M5.5 1.5L4 14.5M11.5 1.5L10 14.5M2 5h12M1.5 11h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Speaker: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M9 2.5L4.5 6H2v4h2.5L9 13.5V2.5z" fill="currentColor" />
      <path d="M11.5 5c1 1 1 5 0 6M13.5 3.5c1.7 1.7 1.7 7.3 0 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </svg>
  ),
  Lock: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.5V4a2 2 0 014 0v1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
  Shield: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path d="M6 1l4 1.5v3c0 2.5-1.8 4.5-4 5-2.2-.5-4-2.5-4-5v-3L6 1z" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M4.5 6l1 1 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Cog: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M9.4 1.4l.25 1.5c.5.15.95.35 1.4.6l1.25-.85 1.55 1.55-.85 1.25c.25.45.45.9.6 1.4l1.5.25v2.2l-1.5.25c-.15.5-.35.95-.6 1.4l.85 1.25-1.55 1.55-1.25-.85c-.45.25-.9.45-1.4.6l-.25 1.5H6.6l-.25-1.5c-.5-.15-.95-.35-1.4-.6l-1.25.85-1.55-1.55.85-1.25c-.25-.45-.45-.9-.6-1.4l-1.5-.25v-2.2l1.5-.25c.15-.5.35-.95.6-1.4L2.15 4.45 3.7 2.9l1.25.85c.45-.25.9-.45 1.4-.6l.25-1.5h2.8zM8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/>
    </svg>
  ),
  Mic: ({ size = 14, off }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="6" y="1.5" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 8a4.5 4.5 0 009 0M8 12.5V15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {off && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" style={{stroke: 'var(--vctrl-bg, var(--bg-2))'}} strokeWidth="3.5" strokeLinecap="round" />}
      {off && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  ),
  Headphones: ({ size = 14, off }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M2 10V8a6 6 0 0112 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="2" y="9.5" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="9.5" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      {off && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" style={{stroke: 'var(--vctrl-bg, var(--bg-2))'}} strokeWidth="3.5" strokeLinecap="round" />}
      {off && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  ),
  Video: ({ size = 14, off }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="4" width="9" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 7l4-2v6l-4-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      {off && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" style={{stroke: 'var(--vctrl-bg, var(--bg-2))'}} strokeWidth="3.5" strokeLinecap="round" />}
      {off && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  ),
  Screen: ({ size = 14, off }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 14h6M8 11.5V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {off && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" style={{stroke: 'var(--vctrl-bg, var(--bg-2))'}} strokeWidth="3.5" strokeLinecap="round" />}
      {off && <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  ),
  Search: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Plus: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  People: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 13c.5-2 2.4-3 4.5-3s4 1 4.5 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="11.5" cy="5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
      <path d="M11.5 8.5c1.5 0 2.7.7 3 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  Chat: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M2 4a2 2 0 012-2h8a2 2 0 012 2v5a2 2 0 01-2 2H7l-3 3V11H4a2 2 0 01-2-2V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  ),
  Send: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M1.5 8L14.5 2L10 14.5L7.5 9L1.5 8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  ),
  Emoji: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="6.5" r="0.7" fill="currentColor" />
      <circle cx="10" cy="6.5" r="0.7" fill="currentColor" />
      <path d="M5.5 10c.7.8 1.5 1.2 2.5 1.2S9.8 10.8 10.5 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  Attach: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M11.5 6.5l-5 5a2.5 2.5 0 01-3.5-3.5l6-6a3 3 0 014.2 4.2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  Thread: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 3v4a2 2 0 002 2h7M3 3l-1 1.5M3 3l1 1.5M12 9l-1.5-1.5M12 9l-1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v1a2 2 0 002 2h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Pin: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path d="M7 1l4 4-2 .5-2.5 3 1 2.5-2 1L3 9.5l-2.5 1.5 1.5-2.5L1 6.5l2.5-1L6.5 3 7 1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  ),
  Reply: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path d="M5 2.5L1.5 6L5 9.5M2 6h6a3 3 0 013 3v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Bars: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M2 12V8M6 12V5M10 12V9M14 12V3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Lightning: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path d="M7 1L2.5 7H6L5 11L9.5 5H6L7 1z" fill="currentColor" />
    </svg>
  ),
};

window.Icon = Icon;
