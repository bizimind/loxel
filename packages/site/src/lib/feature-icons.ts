// Line icons for the homepage's feature points and screenshot callouts: the inner markup of a
// 24×24 SVG drawn with `stroke="currentColor"`. Drawn here, not taken from an icon set, so the site
// ships no third-party artwork.
export const FEATURE_ICONS = {
  nest: '<rect x="3" y="3" width="8" height="6" rx="1.5"/><rect x="13" y="15" width="8" height="6" rx="1.5"/><path d="M7 9v6a3 3 0 0 0 3 3h3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  keyboard:
    '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  agents:
    '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M3 20c0-3 2.5-5 5-5s5 2 5 5M11 20c0-3 2.5-5 5-5s5 2 5 5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  pullRequest:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="M13 3.5 10.5 6 13 8.5"/>',
  commits: '<circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6"/>',
  definition: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/><path d="M13.5 4l-3 16"/>',
  checkbox:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 12.5l2.7 2.7L16.5 9"/>',
} as const;

export type FeatureIcon = keyof typeof FEATURE_ICONS;
