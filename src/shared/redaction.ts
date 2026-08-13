const redactTokenLikeText = (text: string): string => {
  let redacted = text;
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/\bmagt_v1_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)([^\s"'`]+)/gi, "$1[REDACTED]");
  return redacted.replace(/(\"([^\"]*(?:api[_-]?key|token|secret|password)[^\"]*)\"\s*:\s*\")([^\"]+)(\")/gi, "$1[REDACTED]$4");
};

export const redactSensitiveText = (text: string): string => redactTokenLikeText(text);

export const boundedRedactedText = (text: string, limit = 240): string =>
  redactSensitiveText(text).replace(/\s+/gu, " ").slice(0, limit);
