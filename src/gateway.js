import { readFileSync, existsSync } from 'node:fs';
import { sleep, warn } from './util.js';

/**
 * Thin client for any OpenAI-compatible gateway (OmniRoute by default).
 * All model access in CourseMate goes through here — one place to change
 * providers, one place that logs failures.
 */
/** Models answer with stray quotes, fences or "Here is the transcript:". */
function stripTranscriptNoise(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[\s\S]*?\n([\s\S]*?)```$/m, '$1').trim();
  t = t.replace(/^(here is|here's) the transcript:?/i, '').trim();
  t = t.replace(/^transcript:?/i, '').trim();
  t = t.replace(/^["']([\s\S]*)["']$/, '$1').trim();
  if (/^(tone|silence|no speech|no intelligible speech|inaudible|\(\)|\[\])/i.test(t)) return '';
  return t;
}

export function makeGateway(cfg, fetchImpl = globalThis.fetch) {
  let cachedKey = null;

  function apiKey() {
    if (cfg.apiKey) return cfg.apiKey;
    if (cachedKey !== null) return cachedKey;
    try {
      cachedKey = cfg.keyFile && existsSync(cfg.keyFile)
        ? readFileSync(cfg.keyFile, 'utf8').trim()
        : '';
    } catch {
      cachedKey = '';
    }
    return cachedKey;
  }

  function headers(extra = {}) {
    const h = { ...extra };
    const key = apiKey();
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  async function request(path, init, { retries = 2 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const res = await fetchImpl(`${cfg.gatewayUrl}${path}`, {
          ...init,
          headers: headers(init.headers || {}),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new Error(`gateway ${res.status} on ${path}: ${text.slice(0, 400)}`);
          err.status = res.status;
          // 4xx other than rate limiting will not succeed on retry.
          if (res.status !== 429 && res.status < 500) throw Object.assign(err, { fatal: true });
          lastErr = err;
        } else {
          return text ? JSON.parse(text) : {};
        }
      } catch (e) {
        lastErr = e;
        if (e.fatal || attempt === retries) break;
      } finally {
        clearTimeout(timer);
      }
      await sleep(400 * 2 ** attempt);
    }
    throw lastErr;
  }

  async function chatJson(body, { jsonMode = true, retries = 2 } = {}) {
    const payload = {
      model: body.model || cfg.model,
      messages: body.messages,
      temperature: body.temperature ?? 0.4,
      max_tokens: body.maxTokens ?? 1600,
    };
    if (jsonMode) payload.response_format = { type: 'json_object' };

    try {
      return await request('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { retries });
    } catch (e) {
      // Some providers reject response_format outright. Retry once as prose and
      // let the caller's JSON extractor cope.
      if (jsonMode && (e.status === 400 || e.status === 422)) {
        const { response_format, ...rest } = payload;
        return request('/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rest),
        }, { retries });
      }
      throw e;
    }
  }

  const firstText = (reply) =>
    reply?.choices?.[0]?.message?.content?.map?.((p) => p.text).join('') ??
    reply?.choices?.[0]?.message?.content ??
    '';

  /**
   * Ask about an image. `image` is { b64, mime }.
   */
  async function vision({ image, prompt, system, model, maxTokens = 1200, temperature = 0.2 }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: { url: `data:${image.mime || 'image/jpeg'};base64,${image.b64}` },
        },
      ],
    });
    const reply = await chatJson({
      messages,
      model: model || cfg.visionModel,
      maxTokens,
      temperature,
    });
    return { text: firstText(reply), reply };
  }

  async function complete({ messages, model, maxTokens = 1800, temperature = 0.55 }) {
    const reply = await chatJson({ messages, model, maxTokens, temperature });
    return { text: firstText(reply), reply };
  }

  const audioFormat = (mime = '') =>
    mime.includes('wav') ? 'wav'
      : mime.includes('mp4') || mime.includes('m4a') ? 'mp4'
        : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3'
          : mime.includes('ogg') ? 'ogg'
            : 'webm';

  /**
   * Speech to text.
   *
   * Tries the dedicated Whisper-style endpoint first, because it is cheapest and
   * most accurate where it exists. Many gateways only expose transcription on
   * providers that a given API key may not reach (allowlists, missing
   * credentials), so we fall back to a multimodal chat call carrying the audio
   * inline — which is how Gemini and friends transcribe.
   */
  async function transcribe({ audio, language }) {
    const bytes = Buffer.from(audio.b64, 'base64');
    const format = audioFormat(audio.mime);
    let primaryError = null;

    try {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: audio.mime || 'audio/webm' }), `chunk.${format}`);
      form.append('model', cfg.sttModel);
      if (language) form.append('language', language);
      const reply = await request('/audio/transcriptions', { method: 'POST', body: form }, { retries: 0 });
      const text = String(reply.text || '').trim();
      if (text) return { text, via: 'transcriptions', reply };
      primaryError = 'empty transcript';
    } catch (e) {
      primaryError = e.message;
    }

    // Fallback: the same audio, inline in a chat turn.
    try {
      const { text } = await complete({
        model: cfg.sttModel || cfg.visionModel,
        temperature: 0.0,
        maxTokens: 900,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Transcribe the speech in this audio verbatim, in the language spoken. Output only the transcript, with no commentary, quotes or timestamps. If there is no intelligible speech, output nothing at all.',
              },
              { type: 'input_audio', input_audio: { data: audio.b64, format } },
            ],
          },
        ],
      });
      const cleaned = stripTranscriptNoise(text);
      if (!cleaned) warn('gateway', `no speech found (primary failed: ${primaryError})`);
      return { text: cleaned, via: 'chat_audio' };
    } catch (e) {
      warn('gateway', `transcription unavailable: ${primaryError}; fallback: ${e.message}`);
      throw new Error(`transcription failed: ${e.message}`);
    }
  }

  async function health() {
    try {
      const res = await fetchImpl(`${cfg.gatewayUrl}/models`, {
        headers: headers(),
        signal: AbortSignal.timeout(4000),
      });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      warn('gateway', 'unreachable', cfg.gatewayUrl);
      return { ok: false, status: 0, error: String(e.message || e) };
    }
  }

  return { vision, complete, transcribe, health, apiKeyConfigured: () => Boolean(apiKey()) };
}
