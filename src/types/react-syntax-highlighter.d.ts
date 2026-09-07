declare module 'react-syntax-highlighter';
declare module 'react-syntax-highlighter/dist/esm/styles/prism';
// Грамматики языков подключаются по одной (см. Markdown.tsx): в пакете нет
// типов на каждый файл, а один общий шаблон TypeScript для путей не выводит.
declare module 'react-syntax-highlighter/dist/esm/languages/prism/*';
