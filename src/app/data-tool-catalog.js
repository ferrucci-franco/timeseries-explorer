// The data tools as a catalogue: which family each belongs to, its drawing and
// the key of the one line that says what it does. Shared by the two places
// that show the tools as tiles: the desktop's side panel
// (methods/data-tool-gallery-methods.js) and the phone's hub
// (methods/compact-tools-methods.js).
//
// Every tool of the picker in index.html must appear here:
// `npm run test:compact-tools` fails when the picker gains one this table does
// not place.
export const DATA_TOOL_GROUPS = [
    { id: 'clean', titleKey: 'compactToolGroupClean', tools: ['removeOutliers', 'interpolate', 'collapse'] },
    { id: 'calculus', titleKey: 'compactToolGroupCalculus', tools: ['derivative', 'integrate'] },
    { id: 'smooth', titleKey: 'compactToolGroupSmooth', tools: ['movingAverage', 'detrend', 'filter'] },
    { id: 'time', titleKey: 'compactToolGroupTime', tools: ['resample', 'xcorr', 'interarrival'] },
];

export const dataToolGroupOf = tool => DATA_TOOL_GROUPS.find(group => group.tools.includes(tool)) || null;

export const dataToolDescKey = tool => `compactToolDesc_${tool}`;

// Line drawings on a 24 px grid, stroked with the current colour.
export const DATA_TOOL_ICONS = {
    removeOutliers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16h5.5l2.5-9 2.5 9H21"/><path d="M15.5 3.5l4 4M19.5 3.5l-4 4"/></svg>',
    interpolate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18l5-6M16 9l5-5"/><path d="M10.5 11h.01M13.5 10h.01"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h.01M5 12h.01M5 19h.01"/><path d="M8.5 6l6 6-6 6M8.5 12h6"/><path d="M19 12h.01"/></svg>',
    derivative: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19c6 0 10-4 12-14"/><path d="M7 21l13-13" stroke-dasharray="2.2 2.2"/></svg>',
    integrate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19h18"/><path d="M4 19c3-9 6-11 9-7s5 2 7-5"/><path d="M8 19v-6M12 19v-7M16 19v-5" stroke-opacity=".55"/></svg>',
    movingAverage: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13l2-4 2 6 2-7 2 7 2-5 2 6 2-6 2 4 2-1" stroke-opacity=".45"/><path d="M3 12c6-1.5 12-1.5 18 0"/></svg>',
    detrend: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19L21 6" stroke-opacity=".45" stroke-dasharray="2.2 2.2"/><path d="M3 14l3-2 3 3 3-3 3 2 3-2 3 1"/></svg>',
    filter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>',
    resample: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18"/><path d="M5 20v-7M9 20v-11M13 20v-9M17 20v-6M21 20v-4"/></svg>',
    xcorr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9c2.5-5 5-5 7.5 0s5 5 7.5 0"/><path d="M6 17c2.5-5 5-5 7.5 0s5 5 7.5 0" stroke-opacity=".55"/></svg>',
    interarrival: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 20h4v-8h5v8h4v-8h5v8h2" stroke-opacity=".55"/><path d="M6 6.5h9M6 4v5M15 4v5"/></svg>',
};
