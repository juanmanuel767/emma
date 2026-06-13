// Detecta rutas de medios que Emma genera en /tmp/emma/ (QR, imágenes, audio, vídeo)
// dentro de un texto y las renderiza, sirviéndolas desde el endpoint /media del gateway.
const GATEWAY_URL = import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3000';
const MEDIA_RE = /\/tmp\/emma\/[\w.-]+\.(png|jpe?g|gif|webp|ogg|oga|wav|mp3|mp4)/gi;

function urlFor(path: string): string {
  const name = path.split('/').pop() ?? '';
  return `${GATEWAY_URL}/media/${encodeURIComponent(name)}`;
}

/** Devuelve las rutas de medios únicas encontradas en un texto. */
export function findMedia(text: string): string[] {
  const matches = text.match(MEDIA_RE) ?? [];
  return Array.from(new Set(matches));
}

export function MediaPreview({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 mt-2">
      {paths.map((p) => {
        const url = urlFor(p);
        const ext = (p.split('.').pop() ?? '').toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
          return (
            <img
              key={p}
              src={url}
              alt="Imagen de Emma"
              className="rounded-lg max-w-[260px] border border-ink-700 bg-white"
            />
          );
        }
        if (['ogg', 'oga', 'wav', 'mp3'].includes(ext)) {
          return <audio key={p} src={url} controls className="w-full max-w-[300px]" />;
        }
        if (ext === 'mp4') {
          return <video key={p} src={url} controls className="rounded-lg max-w-[300px]" />;
        }
        return null;
      })}
    </div>
  );
}
