// Ambient shape for the optional peer `@react-email/render`. Declared here
// rather than installed so the package stays out of this repo's dependency
// graph — `unemail/render/react` imports it only when a caller uses it.
declare module "@react-email/render" {
  export function render(
    element: unknown,
    options?: { plainText?: boolean },
  ): Promise<string> | string
}
