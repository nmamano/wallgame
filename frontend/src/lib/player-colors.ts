export const PLAYER_COLORS = [
  "red",
  "red-dark",
  "red-light",
  "blue",
  "blue-dark",
  "blue-light",
  "green",
  "green-dark",
  "green-light",
  "purple",
  "purple-dark",
  "purple-light",
  "pink",
  "pink-dark",
  "pink-light",
  "cyan",
  "cyan-dark",
  "cyan-light",
  "brown",
  "brown-dark",
  "brown-light",
  "gray",
  "gray-dark",
  "gray-light",
] as const;

export const SELECTABLE_PLAYER_COLORS = [
  "red",
  "blue",
  "green",
  "purple",
  "pink",
  "cyan",
  "brown",
  "gray",
] as const;

export type PlayerColor = (typeof PLAYER_COLORS)[number];

// Color class mappings for Tailwind CSS
export const colorClassMap: Record<string, string> = {
  red: "text-red-600",
  "red-dark": "text-red-800",
  "red-light": "text-red-400",
  blue: "text-blue-600",
  "blue-dark": "text-blue-800",
  "blue-light": "text-blue-400",
  green: "text-green-600",
  "green-dark": "text-green-800",
  "green-light": "text-green-400",
  purple: "text-purple-600",
  "purple-dark": "text-purple-800",
  "purple-light": "text-purple-400",
  pink: "text-pink-600",
  "pink-dark": "text-pink-800",
  "pink-light": "text-pink-400",
  cyan: "text-cyan-600",
  "cyan-dark": "text-cyan-800",
  "cyan-light": "text-cyan-400",
  brown: "text-amber-700",
  "brown-dark": "text-amber-900",
  "brown-light": "text-amber-500",
  gray: "text-gray-600",
  "gray-dark": "text-gray-800",
  "gray-light": "text-gray-400",
};

// Display names for colors
export const colorDisplayNames: Record<string, string> = {
  red: "Red",
  "red-dark": "Red (Dark)",
  "red-light": "Red (Light)",
  blue: "Blue",
  "blue-dark": "Blue (Dark)",
  "blue-light": "Blue (Light)",
  green: "Green",
  "green-dark": "Green (Dark)",
  "green-light": "Green (Light)",
  purple: "Purple",
  "purple-dark": "Purple (Dark)",
  "purple-light": "Purple (Light)",
  pink: "Pink",
  "pink-dark": "Pink (Dark)",
  "pink-light": "Pink (Light)",
  cyan: "Cyan",
  "cyan-dark": "Cyan (Dark)",
  "cyan-light": "Cyan (Light)",
  brown: "Brown",
  "brown-dark": "Brown (Dark)",
  "brown-light": "Brown (Light)",
  gray: "Gray",
  "gray-dark": "Gray (Dark)",
  "gray-light": "Gray (Light)",
};

// Hex color values for displaying swatches
export const colorHexMap: Record<string, string> = {
  red: "#dc2626",
  "red-dark": "#991b1b",
  "red-light": "#f87171",
  blue: "#2563eb",
  "blue-dark": "#1e40af",
  "blue-light": "#60a5fa",
  green: "#16a34a",
  "green-dark": "#166534",
  "green-light": "#4ade80",
  purple: "#9333ea",
  "purple-dark": "#6b21a8",
  "purple-light": "#c084fc",
  pink: "#ec4899",
  "pink-dark": "#9d174d",
  "pink-light": "#f472b6",
  cyan: "#06b6d4",
  "cyan-dark": "#155e75",
  "cyan-light": "#22d3ee",
  brown: "#b45309",
  "brown-dark": "#78350f",
  "brown-light": "#f59e0b",
  gray: "#6b7280",
  "gray-dark": "#374151",
  "gray-light": "#9ca3af",
};

// CSS filter values to colorize SVGs
export const colorFilterMap: Record<string, string> = {
  red: "invert(27%) sepia(51%) saturate(2878%) hue-rotate(346deg) brightness(104%) contrast(97%)",
  "red-dark":
    "invert(13%) sepia(61%) saturate(4322%) hue-rotate(352deg) brightness(78%) contrast(108%)",
  "red-light":
    "invert(68%) sepia(21%) saturate(1453%) hue-rotate(314deg) brightness(101%) contrast(96%)",
  blue: "invert(39%) sepia(57%) saturate(1815%) hue-rotate(195deg) brightness(96%) contrast(106%)",
  "blue-dark":
    "invert(18%) sepia(76%) saturate(3665%) hue-rotate(214deg) brightness(91%) contrast(103%)",
  "blue-light":
    "invert(63%) sepia(68%) saturate(446%) hue-rotate(180deg) brightness(100%) contrast(96%)",
  green:
    "invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(96%) contrast(119%)",
  "green-dark":
    "invert(28%) sepia(94%) saturate(1437%) hue-rotate(106deg) brightness(91%) contrast(103%)",
  "green-light":
    "invert(76%) sepia(44%) saturate(542%) hue-rotate(76deg) brightness(97%) contrast(90%)",
  purple:
    "invert(32%) sepia(90%) saturate(1853%) hue-rotate(258deg) brightness(91%) contrast(101%)",
  "purple-dark":
    "invert(18%) sepia(61%) saturate(4646%) hue-rotate(274deg) brightness(86%) contrast(106%)",
  "purple-light":
    "invert(65%) sepia(43%) saturate(3065%) hue-rotate(224deg) brightness(101%) contrast(98%)",
  pink: "invert(65%) sepia(57%) saturate(4146%) hue-rotate(303deg) brightness(100%) contrast(101%)",
  "pink-dark":
    "invert(19%) sepia(66%) saturate(3620%) hue-rotate(313deg) brightness(86%) contrast(98%)",
  "pink-light":
    "invert(71%) sepia(35%) saturate(769%) hue-rotate(293deg) brightness(98%) contrast(92%)",
  cyan: "invert(69%) sepia(59%) saturate(4498%) hue-rotate(157deg) brightness(100%) contrast(101%)",
  "cyan-dark":
    "invert(29%) sepia(67%) saturate(1637%) hue-rotate(162deg) brightness(92%) contrast(101%)",
  "cyan-light":
    "invert(80%) sepia(29%) saturate(989%) hue-rotate(162deg) brightness(101%) contrast(96%)",
  brown:
    "invert(46%) sepia(84%) saturate(514%) hue-rotate(1deg) brightness(94%) contrast(101%)",
  "brown-dark":
    "invert(21%) sepia(66%) saturate(1545%) hue-rotate(15deg) brightness(94%) contrast(106%)",
  "brown-light":
    "invert(77%) sepia(43%) saturate(2032%) hue-rotate(359deg) brightness(101%) contrast(106%)",
  gray: "invert(50%) sepia(0%) saturate(0%) hue-rotate(173deg) brightness(95%) contrast(89%)",
  "gray-dark":
    "invert(24%) sepia(10%) saturate(636%) hue-rotate(177deg) brightness(96%) contrast(88%)",
  "gray-light":
    "invert(70%) sepia(13%) saturate(265%) hue-rotate(178deg) brightness(91%) contrast(86%)",
};
