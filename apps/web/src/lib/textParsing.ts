export interface TextToken {
  kind: 'text' | 'mention' | 'url';
  value: string;
}

const TOKEN_RE = /(@[a-zA-Z0-9_.]+)|(https?:\/\/[^\s]+)/g;

export function tokenizeMessageText(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push({ kind: 'text', value: text.slice(lastIndex, index) });
    tokens.push({ kind: match[1] ? 'mention' : 'url', value: match[0] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) tokens.push({ kind: 'text', value: text.slice(lastIndex) });
  return tokens;
}

export function firstUrlIn(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match?.[0] ?? null;
}
