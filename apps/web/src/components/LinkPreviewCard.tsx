'use client';

import { useEffect, useState } from 'react';
import { api, type LinkPreview } from '../lib/api';

export function LinkPreviewCard({ url, accessToken }: { url: string; accessToken: string }) {
  const [preview, setPreview] = useState<LinkPreview | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .linkPreview(url, accessToken)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreview('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [url, accessToken]);

  if (!preview || preview === 'failed') return null;

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noreferrer noopener"
      className="mt-2 block overflow-hidden rounded-sm border border-soft bg-black/5 text-xs no-underline"
    >
      {preview.image && (
        // eslint-disable-next-line @next/next/no-img-element -- remote OG images, not a local asset
        <img src={preview.image} alt="" className="h-28 w-full object-cover" />
      )}
      <div className="p-2">
        <p className="font-medium leading-tight">{preview.title}</p>
        {preview.description && <p className="mt-0.5 line-clamp-2 opacity-70">{preview.description}</p>}
      </div>
    </a>
  );
}
