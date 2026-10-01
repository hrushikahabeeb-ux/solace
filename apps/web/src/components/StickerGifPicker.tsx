'use client';

import { useState } from 'react';

export interface GifResult {
  id: string;
  previewUrl: string;
  url: string;
}

const STICKERS = ['\u2764\uFE0F', '\uD83D\uDD25', '\uD83C\uDF89', '\uD83D\uDE02', '\uD83D\uDE0D', '\uD83D\uDC4D', '\uD83D\uDE22', '\uD83D\uDE31', '\uD83E\uDD73', '\uD83D\uDC4B', '\u2728', '\uD83D\uDE4F'];

/** A tabbed sticker/GIF popover. Stickers are a small built-in set (just large emoji
 *  \u2014 no server round trip, no external dependency). GIFs go through the server's
 *  Giphy proxy (see routes/gifs.ts); if the operator hasn't configured a GIPHY_API_KEY,
 *  the search silently returns nothing rather than erroring, and the tab still works
 *  for browsing stickers. */
export function StickerGifPicker({
  onPickSticker,
  onPickGif,
  onSearchGifs,
}: {
  onPickSticker: (emoji: string) => void;
  onPickGif: (gif: GifResult) => void;
  onSearchGifs: (query: string) => Promise<GifResult[]>;
}) {
  const [tab, setTab] = useState<'stickers' | 'gifs'>('stickers');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [searching, setSearching] = useState(false);

  async function handleSearch(q: string) {
    setQuery(q);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      setResults(await onSearchGifs(q));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="mb-2 rounded-md bg-canvas-alt p-3">
      <div className="mb-2 flex gap-3 text-xs">
        <button
          onClick={() => setTab('stickers')}
          className={tab === 'stickers' ? 'font-medium text-ink-canvas' : 'text-ink-canvas-muted'}
        >
          Stickers
        </button>
        <button onClick={() => setTab('gifs')} className={tab === 'gifs' ? 'font-medium text-ink-canvas' : 'text-ink-canvas-muted'}>
          GIFs
        </button>
      </div>

      {tab === 'stickers' ? (
        <div className="grid grid-cols-6 gap-2">
          {STICKERS.map((emoji) => (
            <button key={emoji} onClick={() => onPickSticker(emoji)} className="rounded-sm p-1 text-2xl hover:bg-canvas">
              {emoji}
            </button>
          ))}
        </div>
      ) : (
        <div>
          <input
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search GIFs…"
            className="mb-2 w-full rounded-sm bg-canvas px-2 py-1 text-xs text-ink-canvas outline-none"
          />
          {searching && <p className="text-xs text-ink-canvas-muted">Searching…</p>}
          <div className="grid max-h-48 grid-cols-3 gap-2 overflow-y-auto">
            {results.map((gif) => (
              // eslint-disable-next-line @next/next/no-img-element -- external GIF CDN thumbnails
              <img
                key={gif.id}
                src={gif.previewUrl}
                alt=""
                onClick={() => onPickGif(gif)}
                className="h-16 w-full cursor-pointer rounded-sm object-cover hover:opacity-80"
              />
            ))}
          </div>
          {!searching && query && results.length === 0 && (
            <p className="text-xs text-ink-canvas-muted">No results — or GIF search isn't configured on this server.</p>
          )}
        </div>
      )}
    </div>
  );
}
