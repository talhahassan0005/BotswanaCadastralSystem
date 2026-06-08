import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./modules/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Palette derived from the UI mockups.
        navy: {
          900: "#0f172a",
          800: "#1e293b",
          700: "#334155",
        },
        brand: {
          // emerald accent used for the active tab / primary buttons
          DEFAULT: "#10b981",
          dark: "#059669",
          light: "#d1fae5",
        },
      },
    },
  },
  plugins: [],
};

export default config;
