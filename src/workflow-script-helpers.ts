export function jsString(value: string): string {
  return JSON.stringify(value);
}

export function safeAgentLabel(value: string, fallback: string): string {
  const label = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return label || fallback;
}
