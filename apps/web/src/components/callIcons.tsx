/** Inline SVG icons for the call UI. Stroke-based and colored via `currentColor`, so they
 *  follow the design tokens through Tailwind text utilities. */

interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-5 w-5'}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function PhoneIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </Svg>
  );
}

export function PhoneHangupIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 14.5c5-4.5 13-4.5 18 0l-1.7 2.6a1 1 0 0 1-1.3.4l-2.6-1.2a1 1 0 0 1-.6-.9V13a12 12 0 0 0-5.6 0v2.4a1 1 0 0 1-.6.9l-2.6 1.2a1 1 0 0 1-1.3-.4z" />
    </Svg>
  );
}

export function VideoIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10.5 5-3v9l-5-3" />
    </Svg>
  );
}

export function VideoOffIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M16 10.5 21 7.5v9l-5-3" />
      <path d="M7 6h7a2 2 0 0 1 2 2v7M3 8v8a2 2 0 0 0 2 2h9" />
      <path d="m3 3 18 18" />
    </Svg>
  );
}

export function MicIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </Svg>
  );
}

export function MicOffIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3" />
      <path d="M5 11a7 7 0 0 0 11 5.7M19 11a7 7 0 0 1-.6 2.8M12 18v3" />
      <path d="m3 3 18 18" />
    </Svg>
  );
}

export function SwitchCameraIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <path d="M9.5 13.5a3 3 0 0 1 5-1.5M14.5 14.5a3 3 0 0 1-5 1.5M14.8 11.6V12.6h-1M9.2 16.4V15.4h1" />
    </Svg>
  );
}
