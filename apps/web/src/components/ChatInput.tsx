import { useState, useRef, type KeyboardEvent } from 'react';
import { uploadFile, transcribeAudio, type UploadResult } from '../services/api.js';

interface Props {
  onSend: (message: string) => void;
  onStop: () => void;
  isLoading: boolean;
}

const ACCEPT =
  'image/*,audio/*,.pdf,.txt,.md,.csv,.json,.log,.xml,.yaml,.yml,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.mp4';

export function ChatInput({ onSend, onStop, isLoading }: Props) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<UploadResult[]>([]);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const handleSend = () => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || isLoading || uploading) return;

    // Componer el mensaje con marcadores que el agente ya entiende (visión / lectura de archivos).
    const parts: string[] = [];
    if (trimmed) parts.push(trimmed);
    for (const a of attachments) {
      parts.push(
        a.kind === 'image'
          ? `[imagen adjunta guardada en: ${a.path}]`
          : `[archivo adjunto guardado en: ${a.path}]`,
      );
    }
    let message = parts.join('\n');
    // Si solo hay adjunto sin texto, dar una instrucción mínima para que Emma actúe.
    if (!trimmed && attachments.length > 0) {
      const hasImage = attachments.some((a) => a.kind === 'image');
      const lead = hasImage
        ? 'Observa y describe esta imagen, por favor.'
        : 'Revisa este archivo adjunto, por favor.';
      message = `${lead}\n${message}`;
    }

    onSend(message);
    setValue('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setNotice(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        try {
          const res = await uploadFile(file);
          setAttachments((prev) => [...prev, res]);
        } catch (err) {
          setNotice(`No pude adjuntar "${file.name}": ${(err as Error).message}`);
        }
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const startRecording = async () => {
    setNotice(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice('Su navegador no permite grabar audio aquí, señor.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setTranscribing(true);
        try {
          const text = await transcribeAudio(blob);
          if (text) {
            setValue((prev) => (prev ? `${prev} ${text}` : text));
            textareaRef.current?.focus();
          } else {
            setNotice('No entendí el audio, señor. Inténtelo de nuevo.');
          }
        } catch (err) {
          setNotice(`Transcripción fallida: ${(err as Error).message}`);
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setNotice(`No pude acceder al micrófono: ${(err as Error).message}`);
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  const btn = 'shrink-0 p-3 rounded-xl transition-colors';

  return (
    <div className="border-t border-gray-700 bg-gray-900 px-4 py-3">
      <div className="max-w-4xl mx-auto flex flex-col gap-2">
        {notice && (
          <div className="text-[11px] text-amber-400/90 px-1">{notice}</div>
        )}

        {/* Adjuntos pendientes de enviar */}
        {(attachments.length > 0 || uploading) && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.path}
                className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg pl-1 pr-2 py-1 text-xs text-gray-200"
              >
                {a.kind === 'image' ? (
                  <img
                    src={`${import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3000'}${a.url}`}
                    alt={a.name}
                    className="w-8 h-8 object-cover rounded"
                  />
                ) : (
                  <span className="text-base px-1">{a.kind === 'audio' ? '🎵' : '📄'}</span>
                )}
                <span className="max-w-[140px] truncate">{a.name}</span>
                <button
                  onClick={() => removeAttachment(a.path)}
                  className="text-gray-500 hover:text-red-400"
                  title="Quitar"
                >
                  ✕
                </button>
              </div>
            ))}
            {uploading && <span className="text-xs text-gray-400 self-center">Subiendo…</span>}
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />

          {/* Adjuntar archivo */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || uploading}
            className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40`}
            title="Adjuntar archivo o imagen"
          >
            📎
          </button>

          {/* Micrófono / nota de voz */}
          <button
            onClick={recording ? stopRecording : () => void startRecording()}
            disabled={isLoading || transcribing}
            className={`${btn} ${
              recording
                ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
                : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
            } disabled:opacity-40`}
            title={recording ? 'Detener y transcribir' : 'Grabar nota de voz'}
          >
            {transcribing ? '…' : recording ? '⏹' : '🎤'}
          </button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder="Escribe un mensaje... (Enter para enviar, Shift+Enter para nueva línea)"
            rows={1}
            className="flex-1 resize-none bg-gray-800 text-gray-100 placeholder-gray-500 rounded-xl px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-blue-500 border border-gray-700 max-h-48 overflow-y-auto"
          />

          {isLoading ? (
            <button
              onClick={onStop}
              className={`${btn} bg-red-600 hover:bg-red-500 text-white`}
              title="Detener"
            >
              ■
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={(!value.trim() && attachments.length === 0) || uploading}
              className={`${btn} bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white`}
              title="Enviar"
            >
              ▶
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
