// Pluggable translation providers. Pick with TRANSLATE_PROVIDER=google|deepl|claude|mock,
// or leave unset to auto-detect from which API key is present.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { LANGUAGES, byCode } from './languages.js';

const env = process.env;
export const MAX_CHARS = 5000;

const google = {
  name: 'Google Cloud Translation',
  supports: (lang) => Boolean(byCode(lang)?.google),
  async translate(text, target, source) {
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(env.GOOGLE_TRANSLATE_API_KEY)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: text, target: byCode(target).google, source: byCode(source)?.google || undefined, format: 'text' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google Translate: ${body.error?.message || `HTTP ${res.status}`}`);
    return body.data.translations[0].translatedText;
  },
};

const deepl = {
  name: 'DeepL',
  supports: (lang) => Boolean(byCode(lang)?.deepl),
  async translate(text, target, source) {
    const key = env.DEEPL_API_KEY || '';
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const res = await fetch(`${host}/v2/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${key}` },
      body: JSON.stringify({ text: [text], target_lang: byCode(target).deepl, source_lang: byCode(source)?.deepl?.split('-')[0] || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`DeepL: ${body.message || `HTTP ${res.status}`}`);
    return body.translations[0].text;
  },
};

let anthropic;
const claude = {
  name: 'Claude',
  supports: () => true,
  async translate(text, target, source) {
    anthropic ??= new Anthropic(); // reads ANTHROPIC_API_KEY
    const model = env.CLAUDE_MODEL || 'claude-opus-5';
    const to = byCode(target).name;
    const from = byCode(source)?.name || 'the original language';
    const response = await anthropic.beta.messages.create({
      model,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system:
        `You translate a teacher's speaker notes from ${from} to ${to} for students who read ${to} natively. ` +
        'Translate faithfully and naturally, keep line breaks and lists, keep technical terms, code, numbers and proper nouns as they are, ' +
        'and reply with the translation only: no preface, no quotes, no notes.',
      messages: [{ role: 'user', content: text }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to translate this text');
    const out = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!out) throw new Error('Claude returned an empty translation');
    return out;
  },
};

// For DEMO_MODE and tests: no network, obviously fake output.
const mock = {
  name: 'Demo (not a real translation)',
  supports: () => true,
  async translate(text, target) {
    return `[${byCode(target).native}] ${text}`;
  },
};

function pick() {
  const choice = (env.TRANSLATE_PROVIDER || '').toLowerCase();
  if (choice === 'google') return google;
  if (choice === 'deepl') return deepl;
  if (choice === 'claude') return claude;
  if (choice === 'mock') return mock;
  if (choice === 'none') return null;
  if (env.GOOGLE_TRANSLATE_API_KEY) return google;
  if (env.DEEPL_API_KEY) return deepl;
  if (env.ANTHROPIC_API_KEY) return claude;
  if (config.demoMode) return mock;
  return null;
}

export const provider = pick();
export const sourceLanguage = byCode((env.NOTES_LANGUAGE || 'en').toLowerCase()) ? (env.NOTES_LANGUAGE || 'en').toLowerCase() : 'en';

/** What the client needs to know: which languages can be offered. */
export function translationInfo() {
  return {
    enabled: Boolean(provider),
    provider: provider?.name || null,
    source: sourceLanguage,
    languages: LANGUAGES.filter((l) => l.code === sourceLanguage || (provider && provider.supports(l.code))).map(
      ({ code, flag, name, native, rtl }) => ({ code, flag, name, native, rtl: Boolean(rtl) })
    ),
  };
}

/** Translate arbitrary text from `from` to `to` (both app language codes). Returns null when not possible. */
export async function translateBetween(text, from, to) {
  if (!text || from === to || !provider) return null;
  if (!provider.supports(to) || (from && !provider.supports(from))) return null;
  const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  return provider.translate(clipped, to, from);
}

/** Translate `text` to `target`. Returns the original text when no translation is needed/possible. */
export async function translateText(text, target) {
  if (!text || target === sourceLanguage) return { text, translated: false };
  if (!provider) return { text, translated: false, reason: 'Translation is not configured on this server.' };
  if (!provider.supports(target)) return { text, translated: false, reason: `${provider.name} does not support this language.` };
  const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const out = await provider.translate(clipped, target, sourceLanguage);
  return { text: out, translated: true };
}
