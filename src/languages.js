// Languages offered to students. `google` and `deepl` are the provider-specific codes
// (null = that provider does not support the language). Source language defaults to English.
export const LANGUAGES = [
  { code: 'en', flag: '🇺🇸', name: 'English', native: 'English', google: 'en', deepl: 'EN' },
  { code: 'es', flag: '🇪🇸', name: 'Spanish', native: 'Español', google: 'es', deepl: 'ES' },
  { code: 'zh', flag: '🇨🇳', name: 'Chinese (Simplified)', native: '中文（简体）', google: 'zh-CN', deepl: 'ZH-HANS' },
  { code: 'hi', flag: '🇮🇳', name: 'Hindi', native: 'हिन्दी', google: 'hi', deepl: null },
  { code: 'ar', flag: '🇸🇦', name: 'Arabic', native: 'العربية', google: 'ar', deepl: 'AR', rtl: true },
  { code: 'fr', flag: '🇫🇷', name: 'French', native: 'Français', google: 'fr', deepl: 'FR' },
  { code: 'pt', flag: '🇧🇷', name: 'Portuguese', native: 'Português', google: 'pt', deepl: 'PT-BR' },
  { code: 'bn', flag: '🇧🇩', name: 'Bengali', native: 'বাংলা', google: 'bn', deepl: null },
  { code: 'ru', flag: '🇷🇺', name: 'Russian', native: 'Русский', google: 'ru', deepl: 'RU' },
  { code: 'ur', flag: '🇵🇰', name: 'Urdu', native: 'اردو', google: 'ur', deepl: null, rtl: true },
  { code: 'id', flag: '🇮🇩', name: 'Indonesian', native: 'Bahasa Indonesia', google: 'id', deepl: 'ID' },
  { code: 'de', flag: '🇩🇪', name: 'German', native: 'Deutsch', google: 'de', deepl: 'DE' },
  { code: 'ja', flag: '🇯🇵', name: 'Japanese', native: '日本語', google: 'ja', deepl: 'JA' },
  { code: 'ro', flag: '🇷🇴', name: 'Romanian', native: 'Română', google: 'ro', deepl: 'RO' },
];

export const byCode = (code) => LANGUAGES.find((l) => l.code === code) || null;
