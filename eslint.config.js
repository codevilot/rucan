import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "target/**"] },
  ...tseslint.configs.recommended,
);
