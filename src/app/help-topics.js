// The topics of the Help, in the order they are shown. The Help dialog
// (app/methods/ui-methods.js) and the manual page built from the same texts
// (scripts/manual/render-manual.mjs) both read this list, so a topic added
// here appears in both. The texts are `helpSec<section>Title` and
// `helpSec<section>Body` in i18n/translations.js.
export const HELP_TOPICS = [
    { section: '1', icon: 'compass', color: '#3b82f6' },
    { section: '2', icon: 'folder', color: '#f59e0b' },
    { section: '3', icon: 'model', color: '#2563eb' },
    { section: '4', icon: 'layers', color: '#06b6d4' },
    { section: '5', icon: 'chart', color: '#8b5cf6' },
    { section: '15', icon: 'gear', color: '#0891b2' },
    { section: '6', icon: 'spectrum', color: '#ec4899' },
    { section: '7', icon: 'animation', color: '#a855f7' },
    { section: '8', icon: 'cursor', color: '#ef4444' },
    { section: '9', icon: 'align', color: '#14b8a6' },
    { section: '10', icon: 'formula', color: '#f97316' },
    { section: '11', icon: 'database', color: '#64748b' },
    { section: '12', icon: 'reload', color: '#0ea5e9' },
    { section: '13', icon: 'save', color: '#22c55e' },
    { section: '14', icon: 'info', color: '#6366f1' },
];
