import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The React component-props layer is intentionally loosely typed for velocity; the data that
    // actually matters (markets, parlays, squads) flows through the explicit MarketView / ParlayView /
    // PubSquad types in lib/. `any` there is a deliberate, visible warning, not a build-blocking error.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // This rule over-fires on two legitimate patterns we rely on: (1) reading client-only localStorage
      // in a mount effect (a lazy useState initializer would run during SSR where localStorage is
      // undefined, causing hydration mismatches), and (2) kicking off async refreshers whose setState
      // happens after an await. Kept as a visible warning, not a build-blocking error.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
