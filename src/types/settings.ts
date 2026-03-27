/** App settings configurable from the companion UI */
export interface LiveCaptionSettings {
  language: LanguageOption;
  smartFormat: boolean;
  profanityFilter: boolean;
  fontSize: 'small' | 'medium' | 'large';
}

export interface LanguageOption {
  code: string;       // Deepgram language code
  label: string;      // Display name
  flag: string;       // Emoji flag
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'multi', label: 'Auto-detect', flag: '🌍' },
  { code: 'nl',    label: 'Nederlands',  flag: '🇳🇱' },
  { code: 'en',    label: 'English',     flag: '🇬🇧' },
  { code: 'de',    label: 'Deutsch',     flag: '🇩🇪' },
  { code: 'fr',    label: 'Français',    flag: '🇫🇷' },
  { code: 'es',    label: 'Español',     flag: '🇪🇸' },
  { code: 'it',    label: 'Italiano',    flag: '🇮🇹' },
  { code: 'pt',    label: 'Português',   flag: '🇵🇹' },
  { code: 'pl',    label: 'Polski',      flag: '🇵🇱' },
  { code: 'tr',    label: 'Türkçe',      flag: '🇹🇷' },
  { code: 'ja',    label: '日本語',       flag: '🇯🇵' },
  { code: 'ko',    label: '한국어',       flag: '🇰🇷' },
  { code: 'zh',    label: '中文',         flag: '🇨🇳' },
];

export const DEFAULT_SETTINGS: LiveCaptionSettings = {
  language: LANGUAGES[1], // Dutch
  smartFormat: true,
  profanityFilter: false,
  fontSize: 'medium',
};

/** Message sent from client → server to configure the Deepgram session */
export interface ConfigMessage {
  type: 'config';
  language: string;
  smartFormat: boolean;
  profanityFilter: boolean;
}
