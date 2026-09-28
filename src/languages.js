// Languages offered to students. `flag` is a country code with an SVG at public/flags/<flag>.svg. `google` and `deepl` are the provider-specific codes
// (null = that provider does not support the language). Source language defaults to English.
export const LANGUAGES = [
  { code: 'en', flag: 'us', name: 'English', native: 'English', google: 'en', deepl: 'EN' },
  { code: 'es', flag: 'es', name: 'Spanish', native: 'Español', google: 'es', deepl: 'ES' },
  { code: 'zh', flag: 'cn', name: 'Chinese (Simplified)', native: '中文（简体）', google: 'zh-CN', deepl: 'ZH-HANS' },
  { code: 'hi', flag: 'in', name: 'Hindi', native: 'हिन्दी', google: 'hi', deepl: null },
  { code: 'ar', flag: 'sa', name: 'Arabic', native: 'العربية', google: 'ar', deepl: 'AR', rtl: true },
  { code: 'fr', flag: 'fr', name: 'French', native: 'Français', google: 'fr', deepl: 'FR' },
  { code: 'pt', flag: 'br', name: 'Portuguese', native: 'Português', google: 'pt', deepl: 'PT-BR' },
  { code: 'bn', flag: 'bd', name: 'Bengali', native: 'বাংলা', google: 'bn', deepl: null },
  { code: 'ru', flag: 'ru', name: 'Russian', native: 'Русский', google: 'ru', deepl: 'RU' },
  { code: 'ur', flag: 'pk', name: 'Urdu', native: 'اردو', google: 'ur', deepl: null, rtl: true },
  { code: 'id', flag: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', google: 'id', deepl: 'ID' },
  { code: 'de', flag: 'de', name: 'German', native: 'Deutsch', google: 'de', deepl: 'DE' },
  { code: 'ja', flag: 'jp', name: 'Japanese', native: '日本語', google: 'ja', deepl: 'JA' },
  { code: 'ro', flag: 'ro', name: 'Romanian', native: 'Română', google: 'ro', deepl: 'RO' },
];

export const byCode = (code) => LANGUAGES.find((l) => l.code === code) || null;
