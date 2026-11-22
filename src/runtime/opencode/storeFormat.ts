/** Evaluated against the native store both when enrolling and when opening the grant. */
export function usableOpenCodeLogin(provider: string): string {
  return String.raw`(() => {
    if (!store || typeof store !== "object" || Array.isArray(store) || Object.keys(store).length !== 1) return false;
    const auth = store[${JSON.stringify(provider)}];
    const token = value => typeof value === "string" && /^\S+$/u.test(value);
    return auth?.type === "oauth" && token(auth.refresh)
      && (token(auth.access) || (${JSON.stringify(provider)} === "openai" && auth.access === ""))
      && Number.isSafeInteger(auth.expires) && auth.expires >= 0
      && (auth.accountId === undefined || token(auth.accountId))
      && (auth.enterpriseUrl === undefined || typeof auth.enterpriseUrl === "string");
  })()`;
}
