// Languages offered to students. `google` and `deepl` are the provider-specific codes
// (null = that provider does not support the language). Source language defaults to English.
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', google: 'en', deepl: 'EN' },
  { code: 'es', name: 'Spanish', native: 'Español', google: 'es', deepl: 'ES' },
  { code: 'zh', name: 'Chinese (Simplified)', native: '中文（简体）', google: 'zh-CN', deepl: 'ZH-HANS' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', google: 'hi', deepl: null },
  { code: 'ar', name: 'Arabic', native: 'العربية', google: 'ar', deepl: 'AR', rtl: true },
  { code: 'fr', name: 'French', native: 'Français', google: 'fr', deepl: 'FR' },
  { code: 'pt', name: 'Portuguese', native: 'Português', google: 'pt', deepl: 'PT-BR' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', google: 'bn', deepl: null },
  { code: 'ru', name: 'Russian', native: 'Русский', google: 'ru', deepl: 'RU' },
  { code: 'ur', name: 'Urdu', native: 'اردو', google: 'ur', deepl: null, rtl: true },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', google: 'id', deepl: 'ID' },
  { code: 'de', name: 'German', native: 'Deutsch', google: 'de', deepl: 'DE' },
  { code: 'ja', name: 'Japanese', native: '日本語', google: 'ja', deepl: 'JA' },
  { code: 'ro', name: 'Romanian', native: 'Română', google: 'ro', deepl: 'RO' },
];

export const byCode = (code) => LANGUAGES.find((l) => l.code === code) || null;
