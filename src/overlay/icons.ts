/** Inline SVG icons (24x24, stroke = currentColor). */

const svg = (inner: string) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
    pen: svg(
        '<path d="M12.9 4.6 19.4 11.1 8.5 22H2v-6.5L12.9 4.6z" fill="currentColor" stroke="none"/>' +
        '<path d="m15.9 1.6 2.4-.9 4 4-.9 2.4-3.5 3.5-5.5-5.5 3.5-3.5z" fill="currentColor" stroke="none"/>',
    ),
    penStroke: svg(
        '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"/>' +
        '<path d="M14.5 6.5l3 3"/>',
    ),
    highlighter: svg(
        '<path d="M9.5 14.5 5 19H3v-2l4.5-4.5"/>' +
        '<path d="M11 6.5 17.5 13l-5.2 5.2a2 2 0 0 1-2.8 0l-1.7-1.7a2 2 0 0 1 0-2.8L11 6.5z"/>' +
        '<path d="M13 4.5 19.5 11l1.6-1.6a2 2 0 0 0 0-2.8l-2.7-2.7a2 2 0 0 0-2.8 0L13 4.5z"/>',
    ),
    eraser: svg(
        '<path d="M8.5 20H21"/>' +
        '<path d="m5.5 16.5 8.7-8.7a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8l-5.5 5.5a2 2 0 0 1-1.4.6H9.4a2 2 0 0 1-1.4-.6l-2.5-2.5a2 2 0 0 1 0-2.8l7.8-7.8"/>' +
        '<path d="M9 10.5l5.5 5.5"/>',
    ),
    select: svg(
        '<path d="M5.5 3.2 20 10.6l-6.4 1.8a1.6 1.6 0 0 0-1.1 1.1L10.6 20 5.5 3.2z" fill="currentColor" stroke="currentColor" stroke-width="1"/>',
    ),
    undo: svg('<path d="M8.5 13.5 4 9l4.5-4.5"/><path d="M4 9h9.5a6 6 0 0 1 0 12H10"/>'),
    redo: svg('<path d="M15.5 13.5 20 9l-4.5-4.5"/><path d="M20 9h-9.5a6 6 0 0 0 0 12H14"/>'),
    trash: svg(
        '<path d="M4 7h16"/><path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2"/>' +
        '<path d="M6.5 7l1 12A2 2 0 0 0 9.5 21h5a2 2 0 0 0 2-1.9l1-12"/>',
    ),
    duplicate: svg(
        '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/>' +
        '<path d="M15.5 5.5v-.7A2.3 2.3 0 0 0 13.2 2.5H5.8A2.3 2.3 0 0 0 3.5 4.8v7.4a2.3 2.3 0 0 0 2.3 2.3h.7"/>',
    ),
    check: svg('<path d="m4.5 12.5 5 5 10-11"/>'),
    export: svg(
        '<path d="M12 3v12"/><path d="m7 10.5 5 5 5-5"/>' +
        '<path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17"/>',
    ),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    collapse: svg('<path d="m9 5 7 7-7 7"/>'),
    pencilHandle: svg(
        '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" fill="currentColor" stroke="none"/>' +
        '<path d="M14.5 6.5l3 3" stroke="#1c1c20"/>',
    ),
    gear: svg(
        '<circle cx="12" cy="12" r="3.2"/>' +
        '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>',
    ),
};

export const TOPBAR_SVG = ICONS.penStroke.replace(
    "<svg ",
    '<svg class="pa-topbar-svg" style="width:16px;height:16px" ',
);
