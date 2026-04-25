// {token} → URL-encoded value from context. Unknown tokens collapse to ""
// so half-filled placeholders don't leak into the final affiliate URL.
export function renderTemplate(
  template: string,
  context: Record<string, string | undefined>
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    const v = context[key];
    return v == null ? '' : encodeURIComponent(v);
  });
}
