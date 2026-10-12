/** Trusted container launch policy: only the broker owns shared request admission. */
export function assertModelRequestAdmission(provider: string, route: string): void {
  const policy = process.env.PAIDEIA_MODEL_REQUEST_CAP;
  if (policy === undefined) return;
  if (policy !== 'broker') throw new Error('Unsupported PAIDEIA_MODEL_REQUEST_CAP policy');
  if (provider !== 'grok-broker') {
    throw new Error(`Capped training requires grok-broker admission; ${route} uses unsupported ${provider}`);
  }
}
