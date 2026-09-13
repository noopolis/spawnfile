/** Only verified provider refusal fields may enter operator diagnostics. */
export function claudeRefusal(value: Record<string, unknown> | undefined, model: string): Error | undefined {
  if (value?.['type'] !== 'result' || value['is_error'] !== true ||
    value['terminal_reason'] !== 'api_error' || value['api_error_status'] !== 429) return undefined;

  const resetHint = sessionReset(value['result']);
  const code = resetHint === undefined ? 'rate-limit' : 'subscription-limit';
  const requestedModel = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model) && model.trim() === model ? model : null;
  const message = `Claude ${code} (provider claude-subscription, requested model ${requestedModel ?? 'unavailable'}; HTTP 429)`;
  return Object.assign(new Error(`${message}${resetHint === undefined ? '' : `; resets ${resetHint}`}`), {
    name: 'ClaudeProviderRefusalError', provider: 'claude-subscription', requestedModel, code, httpStatus: 429,
    ...(resetHint === undefined ? {} : { resetHint }),
  });
}

function sessionReset(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 160) return undefined;
  const match = /^You've hit your session limit · resets ((?:[1-9]|1[0-2]):[0-5][0-9](?:am|pm)) \(([A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2})\)$/u.exec(value);
  if (match === null || match[0] !== value) return undefined;
  const time = match[1]!, zone = match[2]!;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); }
  catch { return undefined; }
  // This is the provider's local-clock hint, not a derived absolute reset timestamp.
  return `${time} (${zone})`;
}
