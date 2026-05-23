import OpenAI, { toFile } from "openai";

// Transcribe a Telegram voice message (OGG/Opus) using OpenAI's audio API.
// gpt-4o-mini-transcribe is cheaper and good enough for short voice notes;
// fall back to whisper-1 if the call fails.
export async function transcribeVoice(args: {
  audio: Buffer;
  filename?: string;     // Telegram voices have no name; default to "voice.ogg"
  mimeType?: string;     // typically "audio/ogg"
  hintLanguage?: string; // ISO 639-1 (e.g. "es", "en") — null = auto-detect
}): Promise<{ text: string; model: string; durationMs: number }> {
  const client = new OpenAI();
  const file = await toFile(
    args.audio,
    args.filename ?? "voice.ogg",
    { type: args.mimeType ?? "audio/ogg" }
  );
  const t0 = Date.now();
  try {
    const resp = await client.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe",
      language: args.hintLanguage,
    });
    return { text: resp.text, model: "gpt-4o-mini-transcribe", durationMs: Date.now() - t0 };
  } catch (err) {
    console.warn("[transcribe] gpt-4o-mini-transcribe failed, retrying with whisper-1:", err);
    const refile = await toFile(
      args.audio,
      args.filename ?? "voice.ogg",
      { type: args.mimeType ?? "audio/ogg" }
    );
    const resp = await client.audio.transcriptions.create({
      file: refile,
      model: "whisper-1",
      language: args.hintLanguage,
    });
    return { text: resp.text, model: "whisper-1", durationMs: Date.now() - t0 };
  }
}
