const PATHS = {
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
  house: "M3 10.5 12 3l9 7.5M5 9v11h14V9M10 20v-6h4v6",
  battery: "M7 4h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM10 2h4",
  grid: "M8 22 12 2l4 20M6 8h12M5 14h14M9.5 14 16 22M14.5 14 8 22",
  inverter: "M4 4h16v16H4zM8 15c1.5-4 2.5-4 4 0s2.5 4 4 0",
  alert: "M12 3 2 21h20L12 3zM12 10v5M12 18h.01",
  check: "M5 12.5 10 17 19 7",
  off: "M12 2v10M6.3 6.3a8 8 0 1 0 11.4 0",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  cloud: "M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18z",
  cloudSun:
    "M8 2v1.5M2.5 7.5H4M4.1 3.6l1 1M11.9 3.6l-1 1M4.8 10.6a3.5 3.5 0 1 1 6.3-4.1M9 20h8a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 8.2 12.3 3.9 3.9 0 0 0 9 20z",
  rain: "M7 15h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 6.5 4.25 4.25 0 0 0 7 15zM8 18l-1 3M12 18l-1 3M16 18l-1 3",
  snow: "M7 15h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 6.5 4.25 4.25 0 0 0 7 15zM8 19h.01M12 19h.01M16 19h.01M10 22h.01M14 22h.01",
  fog: "M4 9h16M4 13h16M6 17h12M8 5h8",
  storm: "M7 14h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 5.5 4.25 4.25 0 0 0 7 14zM13 14l-3 4h4l-3 4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
