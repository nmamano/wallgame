export const PLAYER_COLORS = [
  "red",
  "blue",
  "green",
  "purple",
  "pink",
  "cyan",
  "brown",
  "gray",
] as const;

export type PlayerColor = (typeof PLAYER_COLORS)[number] | string;

// Color class mappings for Tailwind CSS
export const colorClassMap: Record<string, string> = {
  red: "text-red-600",
  blue: "text-blue-600",
  green: "text-green-600",
  purple: "text-purple-600",
  pink: "text-pink-600",
  cyan: "text-cyan-600",
  brown: "text-amber-700",
  gray: "text-gray-600",
};

// Display names for colors
export const colorDisplayNames: Record<string, string> = {
  red: "Red",
  blue: "Blue",
  green: "Green",
  purple: "Purple",
  pink: "Pink",
  cyan: "Cyan",
  brown: "Brown",
  gray: "Gray",
};

// Hex color values for displaying swatches
export const colorHexMap: Record<string, string> = {
  red: "#dc2626",
  blue: "#2563eb",
  green: "#16a34a",
  purple: "#9333ea",
  pink: "#ec4899",
  cyan: "#06b6d4",
  brown: "#b45309",
  gray: "#6b7280",
};

// CSS filter values to colorize SVGs
export const colorFilterMap: Record<string, string> = {
  red: "invert(27%) sepia(51%) saturate(2878%) hue-rotate(346deg) brightness(104%) contrast(97%)",
  blue: "invert(39%) sepia(57%) saturate(1815%) hue-rotate(195deg) brightness(96%) contrast(106%)",
  green: "invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(96%) contrast(119%)",
  purple: "invert(32%) sepia(90%) saturate(1853%) hue-rotate(258deg) brightness(91%) contrast(101%)",
  pink: "invert(65%) sepia(57%) saturate(4146%) hue-rotate(303deg) brightness(100%) contrast(101%)",
  cyan: "invert(69%) sepia(59%) saturate(4498%) hue-rotate(157deg) brightness(100%) contrast(101%)",
  brown: "invert(46%) sepia(84%) saturate(514%) hue-rotate(1deg) brightness(94%) contrast(101%)",
  gray: "invert(50%) sepia(0%) saturate(0%) hue-rotate(173deg) brightness(95%) contrast(89%)",
};
